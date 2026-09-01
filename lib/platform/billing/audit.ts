import 'server-only'
import type { DB } from '@/db'
import { auditLog } from '@/db/schema'

/**
 * THE AUDIT TRAIL FOR PLATFORM-ADMIN OVERRIDES (AROS-114 §9).
 *
 * ── One audit system, not two ───────────────────────────────────────────────
 *
 * `public.audit_log` (0018) is reused unchanged: same table, same columns, same
 * append-only guarantee (SELECT + INSERT policies only, SELECT + INSERT grants
 * only — no policy can authorise an update or a delete of the trail). This is
 * the third writer, joining lib/billing/refunds.ts (tenant refunds and voids)
 * and lib/platform/billing/lifecycle.ts (subscription lifecycle transitions,
 * AROS-113). There is no separate platform audit table and no second history
 * model.
 *
 * ── WHY `actor_membership_id` IS NULL, AND WHERE THE ACTOR ACTUALLY GOES ────
 *
 * This is the one honest awkwardness and it deserves stating rather than
 * hiding. `audit_log.actor_membership_id` references `public.memberships` —
 * a person's seat INSIDE a tenant. A platform admin is a different kind of
 * identity: a global `users.is_platform_admin` flag, and they normally hold no
 * membership in the business they are acting on. There is no membership id to
 * put in that column, and inventing one would either fail the foreign key or,
 * worse, attribute a support action to whichever member of the business
 * happened to be handy.
 *
 * So the column is NULL — which already has a meaning in this codebase, set by
 * AROS-113: "nobody in the business did this". Correct here too.
 *
 * The actor is recorded WHERE IT CAN BE: inside the `after` payload, as
 * `actorUserId` and `actorEmail`, alongside `actorKind: 'platform_admin'`.
 * Every entry this module writes therefore names a real, resolvable person, and
 * the tenant's own owner can read it — `audit_log_tenant_select` (0018) admits
 * the whole trail for their tenant, so a business can always see what Arena OS
 * did to its account.
 *
 * Changing the column to a nullable `users` reference was considered and
 * rejected: `actor_membership_id` is read by lib/billing/refunds.ts and by the
 * existing relations, a second actor column would leave two places to look for
 * "who did this", and the JSON payload answers the question completely without
 * touching a table five other features already depend on.
 *
 * ── Written in the SAME transaction as the change ───────────────────────────
 *
 * Every caller passes the `tx` it is mutating in, so an override and its audit
 * entry commit together or not at all. There is no code path that changes a
 * subscription and then separately tries to remember it.
 */

/** Who did it. Resolved from the SESSION by requirePlatformAdmin(), never from input. */
export type PlatformActor = {
  userId: string
  email: string
}

/** The overrides AROS-114 §9 requires a trail for. A closed set, on purpose. */
export type PlatformOverrideAction =
  | 'change_plan'
  | 'extend_trial'
  | 'comp_or_discount'
  | 'refund'
  | 'force_cancel'

export type PlatformAuditEntry = {
  tenantId: string
  action: PlatformOverrideAction
  /** 'tenant_subscription' | 'platform_invoice' — the thing that changed. */
  entityType: string
  /** A uuid. The subscription, or the invoice for a refund. */
  entityId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

/**
 * Append exactly ONE entry for one override.
 *
 * `before` and `after` are the caller's own snapshots of the row it locked —
 * taken from the database, never from the form that asked for the change. That
 * is what makes the trail evidence rather than a restatement of a request: an
 * operator reading it later sees what the row actually WAS, including when the
 * change turned out to be a no-op.
 */
export async function recordPlatformOverride(
  tx: DB,
  actor: PlatformActor,
  entry: PlatformAuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: entry.tenantId,
    // See the note above. Not a gap — the documented value for "no member of
    // this business did this".
    actorMembershipId: null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: {
      ...entry.after,
      actorKind: 'platform_admin',
      actorUserId: actor.userId,
      actorEmail: actor.email,
    },
  })
}
