import 'server-only'
import type { DB } from '@/db'
import { platformDunningNotices } from '@/db/schema'
import type { DunningStage } from './dunning-policy'

/**
 * SENDING A DUNNING REMINDER, EXACTLY ONCE (AROS-113 §5).
 *
 * ══ Read this before adding an email provider ══════════════════════════════
 *
 * The ticket says: reuse the existing notification infrastructure, do not
 * create a separate one. That was checked first, and the finding is plain —
 * THERE IS NO NOTIFICATION INFRASTRUCTURE IN THIS PROJECT. No email
 * dependency, no SMS dependency, no provider settings table, no template
 * store, no queue, nothing. `package.json` has no mail client;
 * `scripts/run-recurring-expenses.ts` says as much in its own header ("the
 * notification/reminder work that would introduce one is still M3-C on the
 * roadmap").
 *
 * So the ticket's fallback applies — "extend minimally" — and this module is
 * that minimum. It is deliberately NOT a notification framework:
 *
 *   * no templates, no channel routing, no retry queue, no scheduling. The
 *     SCHEDULE is lib/platform/billing/dunning-policy.ts and the TRIGGER is
 *     lib/platform/billing/dunning.ts; this module only answers "has this
 *     business already been told, and if not, tell it".
 *   * one table, modelled on `webhook_events` — the delivery log this codebase
 *     already has — with a unique claim that makes a repeat a no-op.
 *   * one seam, `DunningNotifier`, which is the ONLY thing that changes the day
 *     this platform gains a real provider. Nothing else in the dunning path
 *     knows how a message goes out.
 *
 * ══ What "sent" means today ════════════════════════════════════════════════
 *
 * Two real deliveries, neither of which required inventing a provider:
 *
 *   1. THE OWNER SEES IT IN THE APP. The billing portal's StatusBanner already
 *      renders the arrears state, and AROS-113 extends it with the actual
 *      deadlines from dunning-policy.ts — "suspended on 12 March", "cancelled
 *      on 26 March", with the payment-method button beside it. That is a real,
 *      tenant-visible notification through a surface that already exists.
 *   2. RAZORPAY EMAILS THE PAYER. Subscriptions are created with
 *      `customer_notify: 1` (lib/platform/billing/razorpay-subscriptions.ts),
 *      so the gateway itself mails and SMSes the mandate holder about failed
 *      charges and retries. Building a second stream of "your payment failed"
 *      emails on top of that would double-message every payer.
 *
 * What this module adds is the OPERATOR-side record and signal: a structured
 * log line an on-call operator or a log drain can act on, and a row proving
 * what was sent and when. `logDunningNotice` is the default notifier for that
 * reason — it is honest about the platform's actual capability rather than
 * pretending a message went to an inbox that nothing can reach.
 *
 * ══ Idempotency ════════════════════════════════════════════════════════════
 *
 * The guarantee is `idx_platform_dunning_notices_once` on
 * (subscription_id, dunning_cycle, stage) — an INDEX, not a check in this file.
 * Two job runs racing on one subscription both attempt the insert; exactly one
 * inserts a row and the other is refused by the index without notifying. An
 * application-level "have we sent this?" would have a window between the read
 * and the write, and an hourly job would eventually find it.
 *
 * The refusal is expressed as `on conflict do nothing … returning`, not as a
 * caught 23505. In Postgres a raised unique violation ABORTS the surrounding
 * transaction, and one subscription's turn here can send several notices (a job
 * catching up after an outage owes every stage it missed) — so a thrown
 * duplicate would poison the transaction that still had work to do. This is the
 * same `on conflict do nothing` idiom scripts/run-recurring-expenses.ts uses,
 * and for the same reason.
 *
 * `dunningCycle` is the subscription's `past_due_since` — the EPISODE key. Its
 * consequence is the useful one: a business is warned once per arrears episode,
 * and a business that recovers and fails again months later is warned again
 * rather than silenced forever by a notice it received in the spring.
 */

/** The one place a message is actually emitted. Swap this to add a provider. */
export type DunningNotifier = (notice: DunningNotice) => void | Promise<void>

export type DunningNotice = {
  tenantId: string
  subscriptionId: string
  stage: DunningStage
  /** The `past_due_since` this episode is anchored on. */
  dunningCycle: Date
  /** When the account is (or was) suspended. Null before grace has been computed. */
  graceEndsAt: Date | null
  /** When the subscription is (or was) cancelled. Null until suspension. */
  cancelsAt: Date | null
}

/**
 * The default notifier: one structured line per notice, on the server log.
 *
 * NEVER a credential, a payment id, a signature or a customer's contact
 * details — the same rule the webhook route's logging follows. Only our own
 * ids, the stage, and the deadlines, which is exactly what an operator needs to
 * answer "was this business warned before we suspended it?".
 */
export const logDunningNotice: DunningNotifier = (notice) => {
  console.info(
    `[dunning] ${notice.stage}: tenant ${notice.tenantId} subscription ${notice.subscriptionId}` +
      ` (episode ${notice.dunningCycle.toISOString()}` +
      (notice.graceEndsAt ? `, suspends ${notice.graceEndsAt.toISOString()}` : '') +
      (notice.cancelsAt ? `, cancels ${notice.cancelsAt.toISOString()}` : '') +
      ')',
  )
}

/**
 * Record and send ONE dunning notice, if it has not already been sent.
 *
 * Returns true when this call was the one that sent it, false when it had
 * already gone out. A caller can therefore count what it actually did without
 * a second query, and calling this repeatedly is free.
 *
 * ── Ordering: claim first, notify second ────────────────────────────────────
 *
 * The row is inserted BEFORE the notifier runs, so two concurrent runs cannot
 * both notify — the loser is refused by the index before it ever reaches the
 * message. The cost is the opposite failure: if the notifier throws, or the
 * surrounding transaction rolls back after a successful insert, delivery and
 * record can disagree by one message. That trade is taken deliberately and in
 * this direction, because the alternative — notify, then record — turns every
 * crash into a business being emailed the same warning on every subsequent job
 * run. Under-notifying by one is recoverable; a message loop is not.
 *
 * A notifier that throws is NOT caught here. The caller runs one transaction
 * per subscription and logs the failure, so a broken notifier fails that one
 * subscription's turn and the others still run — the same "keep going, report
 * at the end" shape scripts/run-recurring-expenses.ts uses.
 */
export async function sendDunningNotice(
  tx: DB,
  notice: DunningNotice,
  notify: DunningNotifier = logDunningNotice,
): Promise<boolean> {
  const inserted = await tx
    .insert(platformDunningNotices)
    .values({
      tenantId: notice.tenantId,
      subscriptionId: notice.subscriptionId,
      dunningCycle: notice.dunningCycle,
      stage: notice.stage,
      channel: 'log',
    })
    // The target IS idx_platform_dunning_notices_once. Named explicitly so a
    // conflict on some future constraint is a loud error rather than a message
    // silently not sent.
    .onConflictDoNothing({
      target: [
        platformDunningNotices.subscriptionId,
        platformDunningNotices.dunningCycle,
        platformDunningNotices.stage,
      ],
    })
    .returning({ id: platformDunningNotices.id })

  // Empty means the index refused it: already sent for this (subscription,
  // episode, stage). The expected outcome on any re-run, and never an error.
  if (inserted.length === 0) return false

  await notify(notice)
  return true
}
