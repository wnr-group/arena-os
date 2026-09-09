import 'server-only'
import { sql } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { round2 } from '@/lib/billing/pricing'
import type { DateRange } from '@/lib/reports/date-range'
import { requirePlatformAdmin } from '../guard'
import { PLATFORM_TIMEZONE } from './invoices'

/**
 * THE PLATFORM BILLING METRICS (AROS-114 §§2–6).
 *
 * ── Everything is DERIVED. Nothing is stored ────────────────────────────────
 *
 * There is no `mrr` column, no metrics table, no nightly rollup and no cache.
 * Every figure on the dashboard is an aggregate over the four tables that
 * already hold the facts — `plans`, `tenant_subscriptions`, `tenants` and
 * `platform_invoices` (plus `platform_refunds`, 0083). A stored metric is a
 * second source of truth about money, and the first thing it does is drift
 * from the rows it was computed from.
 *
 * ── And it is aggregated in POSTGRES, not in JavaScript ─────────────────────
 *
 * Every count and every sum below is a `filter (where …)` aggregate in one
 * statement. The only work done in JS is merging two already-aggregated series
 * (revenue and refunds, at most a few hundred bucket rows) and filling the
 * empty buckets — the same shaping lib/reports/revenue.ts does and documents.
 * Nothing here ever loads a subscription list to count it.
 *
 * ── Why the owner connection ────────────────────────────────────────────────
 *
 * This is cross-tenant BY DEFINITION: the whole point is the platform-wide
 * picture. So it runs on `ownerDb` and every exported reader calls
 * requirePlatformAdmin() ITSELF — the rule lib/platform/data.ts states and
 * every platform reader follows. A page-only guard would leak the platform's
 * revenue into the RSC payload of any signed-in user who guessed the URL.
 *
 * NOTHING here reads `platform_payment_settings`. No key id, no ciphertext, no
 * webhook secret — those columns are not selected anywhere in this file, and
 * `arena_app` has no grant on that table at all (0080).
 *
 * ═══ MRR — THE DEFINITION ═══════════════════════════════════════════════════
 *
 *   monthly plan → plans.monthly_price
 *   annual  plan → plans.annual_price / 12
 *
 * Read from the plan the subscription is ON, not from an invoice: MRR is
 * forward-looking (what recurs next month), while an invoice is history.
 *
 * COUNTED: `status = 'active'` whose `current_period_end` is still in the
 * future. Both halves matter. The status alone would count a subscription whose
 * period ended and whose renewal never landed — a row that is granting nothing
 * (lib/platform/entitlements.ts refuses it on exactly this clock) and therefore
 * is not revenue. Those rows are reported separately as `lapsedActive` so the
 * discrepancy is visible rather than silently dropped.
 *
 * NOT COUNTED, and each for its own reason:
 *   trialing   nobody has paid yet. Reported in the mix, never in MRR.
 *   past_due   in arrears. Reported as `pastDueMrr` — revenue AT RISK, which an
 *              operator needs to see, and which would overstate MRR if merged
 *              into it. AROS-113's grace period means these are still being
 *              served, so they are not zero either; they are their own number.
 *   expired    suspended (AROS-113) or completed. Not being charged.
 *   cancelled  gone.
 *   one-off    there are none. Every platform_invoice is a subscription charge
 *              or a credit note; nothing else can raise one.
 *   refunds    do not touch MRR at all. MRR is a run-rate, not cash collected —
 *              a refund of last month's charge does not change what recurs next
 *              month. Refunds are subtracted from REVENUE OVER TIME, which is
 *              the cash view, and shown there.
 *
 * ARR = MRR × 12. Stated once, in `arr` below, so no caller multiplies its own.
 *
 * ── Currency ────────────────────────────────────────────────────────────────
 *
 * Grouped BY CURRENCY and returned as a list, never summed across currencies.
 * `plans.currency` is free text (CHECK length = 3), and adding ₹ to $ would
 * produce a number that means nothing. In practice there is one row; the UI
 * renders the largest and says so if there are more.
 */

// ── MRR / ARR ────────────────────────────────────────────────────────────────

export type MrrByCurrency = {
  currency: string
  /** Recurring revenue from `active`, unlapsed subscriptions. */
  mrr: number
  /** mrr × 12. Computed once, here. */
  arr: number
  activeCount: number
  /** Revenue AT RISK: the same normalisation over `past_due` subscriptions. */
  pastDueMrr: number
  pastDueCount: number
  /**
   * `active` rows whose period end has passed — granting nothing, and therefore
   * excluded from `mrr`. Surfaced so the omission is visible.
   */
  lapsedActiveCount: number
}

type MrrRow = {
  currency: string
  mrr: string | null
  active_count: string | number
  past_due_mrr: string | null
  past_due_count: string | number
  lapsed_active_count: string | number
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * The normalisation, written ONCE as a SQL fragment and reused by every
 * aggregate that needs it — including the per-tenant table below, which is why
 * a tenant's "MRR contribution" can never disagree with the total it is part of.
 */
const MONTHLY_VALUE = sql`case
  when s.billing_period = 'annual' then p.annual_price / 12
  else p.monthly_price
end`

async function readMrr(db: DB): Promise<MrrByCurrency[]> {
  const { rows } = await db.execute<MrrRow>(sql`
    select
      p.currency,
      coalesce(sum(${MONTHLY_VALUE}) filter (
        where s.status = 'active' and s.current_period_end > now()
      ), 0) as mrr,
      count(*) filter (
        where s.status = 'active' and s.current_period_end > now()
      ) as active_count,
      coalesce(sum(${MONTHLY_VALUE}) filter (where s.status = 'past_due'), 0) as past_due_mrr,
      count(*) filter (where s.status = 'past_due') as past_due_count,
      count(*) filter (
        where s.status = 'active' and s.current_period_end <= now()
      ) as lapsed_active_count
    from public.tenant_subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.status in ('active', 'past_due')
    group by p.currency
  `)

  return rows
    .map((r) => {
      // Rounded ONCE, on the aggregate. Rounding each subscription's monthly
      // value first would accumulate a paisa of drift per annual plan.
      const mrr = round2(num(r.mrr))
      return {
        currency: r.currency,
        mrr,
        arr: round2(mrr * 12),
        activeCount: num(r.active_count),
        pastDueMrr: round2(num(r.past_due_mrr)),
        pastDueCount: num(r.past_due_count),
        lapsedActiveCount: num(r.lapsed_active_count),
      }
    })
    .sort((a, b) => b.mrr - a.mrr)
}

// ── subscription mix ─────────────────────────────────────────────────────────

/**
 * Counts per TENANT, never per subscription row (AROS-114 §4).
 *
 * `tenant_subscriptions` keeps history — a tenant that has changed plans three
 * times has four rows — so counting rows would report one business several
 * times. The `distinct on (tenant_id)` below collapses each tenant to its ONE
 * live subscription, which `idx_tenant_subscriptions_one_live` (0079) already
 * guarantees is at most one; the `distinct on` is what makes the query correct
 * even if that index were ever dropped or built NOT VALID.
 *
 * A tenant with no live subscription is classified from `tenants.status`, using
 * exactly the mapping AROS-113 established:
 *
 *   live row 'trialing'                → Trial
 *   live row 'active'                  → Active
 *   live row 'past_due'                → Past due
 *   no live row + tenants.status suspended → Suspended
 *   no live row + tenants.status cancelled → Cancelled
 *   no live row, anything else         → No plan
 *
 * The six buckets are mutually exclusive and sum to the tenant count, which is
 * asserted in the test suite rather than assumed.
 */
export type SubscriptionMix = {
  trialing: number
  active: number
  pastDue: number
  suspended: number
  cancelled: number
  /** Never subscribed, or lapsed without being suspended or cancelled. */
  noPlan: number
  /** Every tenant on the platform. The six buckets above sum to this. */
  tenants: number
}

type MixRow = Record<keyof SubscriptionMix | 'past_due' | 'no_plan', string | number>

async function readMix(db: DB): Promise<SubscriptionMix> {
  const { rows } = await db.execute<MixRow>(sql`
    with live as (
      select distinct on (s.tenant_id)
             s.tenant_id,
             s.status
        from public.tenant_subscriptions s
       where s.status in ('trialing', 'active', 'past_due')
       order by s.tenant_id, s.current_period_start desc
    )
    select
      count(*) filter (where l.status = 'trialing')  as trialing,
      count(*) filter (where l.status = 'active')    as active,
      count(*) filter (where l.status = 'past_due')  as past_due,
      count(*) filter (where l.status is null and t.status = 'suspended') as suspended,
      count(*) filter (where l.status is null and t.status = 'cancelled') as cancelled,
      count(*) filter (
        where l.status is null and t.status not in ('suspended', 'cancelled')
      ) as no_plan,
      count(*) as tenants
      from public.tenants t
      left join live l on l.tenant_id = t.id
  `)

  const r = rows[0]
  return {
    trialing: num(r?.trialing as string),
    active: num(r?.active as string),
    pastDue: num(r?.past_due as string),
    suspended: num(r?.suspended as string),
    cancelled: num(r?.cancelled as string),
    noPlan: num(r?.no_plan as string),
    tenants: num(r?.tenants as string),
  }
}

// ── churn ────────────────────────────────────────────────────────────────────

/**
 * CHURN — the definition, and why it is this one (AROS-114 §5).
 *
 *   churnRate = tenants that were live at the START of the window
 *               and are NOT live at the END
 *             ÷ tenants that were live at the START
 *
 * ── It is measured per TENANT, and that is the point ────────────────────────
 *
 * Counting cancelled SUBSCRIPTION ROWS would be wrong here, and provably so:
 * this codebase changes a plan by cancelling the old subscription and opening a
 * new one (lib/actions/plans.ts assignPlan, lib/platform/billing/subscribe.ts).
 * Every upgrade would therefore register as a churn. Measuring the tenant
 * instead is immune to that — a business that upgrades still has a live
 * subscription at the end of the window — and it cannot double-count a tenant
 * with several historical rows either.
 *
 * ── "Live at an instant" is RECONSTRUCTED, not invented ─────────────────────
 *
 * The schema records no membership history, so liveness at a past instant is
 * derived from the three dates it does record:
 *
 *     created_at <= T
 *     and (cancelled_at is null or cancelled_at > T)
 *     and current_period_end > T
 *
 * The third clause matters: a subscription that simply ran out (`expired`,
 * `completed`, a mandate never authenticated) carries no end timestamp at all,
 * and without it every such row would count as live forever, inflating the
 * denominator and understating churn.
 *
 * AROS-114 says "do not invent historical data that the existing schema cannot
 * support", so nothing beyond these three columns is used, and nothing is
 * back-filled.
 *
 * ── Suspension is not churn ─────────────────────────────────────────────────
 *
 * A suspended tenant's subscription is `expired` with a past period end, so it
 * is not live at the end of the window and DOES count as churned. That is
 * deliberate and consistent with the money: a suspended business is not paying.
 * It is also reversible — AROS-113 restores it on the next successful charge —
 * so it will re-enter as live in a later window. `cancelledInPeriod` is
 * reported alongside for the hard-cancellation view.
 *
 * ── Zero denominator ────────────────────────────────────────────────────────
 *
 * `churnRate` is NULL when nothing was live at the start, never 0 and never
 * NaN. A rate over nothing is undefined, and rendering it as "0% churn" on a
 * brand-new platform would be a lie in the flattering direction.
 */
export type ChurnMetrics = {
  /** Tenants with a live subscription at the first instant of the range. */
  activeAtStart: number
  /** Of those, the ones with no live subscription at the last instant. */
  churned: number
  /** churned ÷ activeAtStart, as a PERCENT. Null when the denominator is 0. */
  churnRatePercent: number | null
  /** Tenants that became live during the window and were not live at its start. */
  newInPeriod: number
  /**
   * Subscription rows whose `cancelled_at` falls in the window. INCLUDES
   * closures caused by a plan change, which is why it is reported beside the
   * churn rate rather than used to compute it.
   */
  cancelledInPeriod: number
}

type ChurnRow = {
  active_at_start: string | number
  churned: string | number
  new_in_period: string | number
  cancelled_in_period: string | number
}

async function readChurn(db: DB, range: DateRange): Promise<ChurnMetrics> {
  // The window as INSTANTS, in the supplier's timezone — the same zone the
  // platform's invoice numbering runs on, so "August" means one thing across
  // this whole dashboard. Half-open at the top: `end` is inclusive as a
  // calendar day, so the closing instant is the start of the following day.
  const tz = PLATFORM_TIMEZONE

  const { rows } = await db.execute<ChurnRow>(sql`
    with bounds as (
      select
        (${range.start}::date::timestamp at time zone ${tz})                      as t_start,
        ((${range.end}::date + 1)::timestamp at time zone ${tz})                  as t_end
    ),
    per_tenant as (
      select
        s.tenant_id,
        bool_or(
          s.created_at <= b.t_start
          and (s.cancelled_at is null or s.cancelled_at > b.t_start)
          and s.current_period_end > b.t_start
        ) as live_at_start,
        bool_or(
          s.created_at <= b.t_end
          and (s.cancelled_at is null or s.cancelled_at > b.t_end)
          and s.current_period_end > b.t_end
        ) as live_at_end
      from public.tenant_subscriptions s
      cross join bounds b
      group by s.tenant_id
    )
    select
      count(*) filter (where live_at_start)                        as active_at_start,
      count(*) filter (where live_at_start and not live_at_end)    as churned,
      count(*) filter (where not live_at_start and live_at_end)    as new_in_period,
      (
        select count(*)
          from public.tenant_subscriptions s2, bounds b2
         where s2.cancelled_at is not null
           and s2.cancelled_at >= b2.t_start
           and s2.cancelled_at <  b2.t_end
      )                                                            as cancelled_in_period
    from per_tenant
  `)

  const r = rows[0]
  const activeAtStart = num(r?.active_at_start)
  const churned = num(r?.churned)

  return {
    activeAtStart,
    churned,
    // Null, not 0 — see the note above.
    churnRatePercent:
      activeAtStart > 0 ? round2((churned / activeAtStart) * 100) : null,
    newInPeriod: num(r?.new_in_period),
    cancelledInPeriod: num(r?.cancelled_in_period),
  }
}

// ── revenue over time ────────────────────────────────────────────────────────

/** How the revenue series is bucketed. `date_trunc`'s vocabulary, unchanged. */
export type RevenueBucket = 'day' | 'week' | 'month'

export type RevenuePoint = {
  /** `YYYY-MM-DD` — the first day of the bucket. */
  bucketStart: string
  /** Paid subscription invoices raised in this bucket, GST-inclusive. */
  gross: number
  /** Refunds that ACTUALLY PROCESSED in this bucket. */
  refunded: number
  /** gross − refunded. */
  net: number
  invoices: number
  /**
   * Credit notes ISSUED in this bucket. Reported, NEVER subtracted — see the
   * note on `readRevenue` for why doing so would double-count.
   */
  creditsIssued: number
}

export type RevenueTotals = {
  gross: number
  refunded: number
  net: number
  invoices: number
  creditsIssued: number
}

type InvoiceBucketRow = { bucket_start: string; gross: string | null; invoices: string | number; credits: string | null }
type RefundBucketRow = { bucket_start: string; refunded: string | null }

/**
 * Revenue by bucket, from `platform_invoices` and `platform_refunds`.
 *
 * ── WHAT COUNTS AS REVENUE ──────────────────────────────────────────────────
 *
 * `kind = 'subscription' and status = 'paid'`. That is not a guess about the
 * existing rules — it is the only combination issueSubscriptionInvoice() can
 * write, because an invoice is raised exactly when a `subscription.charged`
 * webhook proves Razorpay captured the money (0081, AROS-4). A `void` invoice
 * and a `draft` never represented cash.
 *
 * ── WHY CREDIT NOTES ARE NOT SUBTRACTED ─────────────────────────────────────
 *
 * A credit note in this schema is NOT money going out —
 * `platform_invoices_credit_note_unpaid` (0081) CHECKs that it carries no
 * gateway payment, precisely because none moved. It is an OBLIGATION: an amount
 * Arena OS owes the tenant, discharged only by a refund (./refunds.ts, which
 * does move money and is counted below) or by an operator's explicit act.
 *
 * Subtracting it from revenue here would therefore book the same rupees out
 * twice — once as an unfulfilled promise, again when that promise is actually
 * paid. So credits are reported as their own series, for visibility, and never
 * netted off. `gross` stays equal to the cash the platform actually received.
 *
 * ── WHY REFUNDS ARE ────────────────────────────────────────────────────────
 *
 * A refund IS money leaving the account (0083). Only `status = 'processed'`
 * counts: a `pending` refund has not left yet and a `failed` one never will,
 * and both are decided by a signature-verified webhook rather than by the
 * request that started them.
 *
 * Refunds are bucketed by when they PROCESSED — `processed_at` (0085) — and not
 * by two other dates it would be easy to reach for:
 *
 *   NOT the invoice they reverse. A refund issued in March against a January
 *   charge is March's cash movement; restating January would change a month an
 *   operator has already read and reported on.
 *
 *   NOT `created_at`, which is when the refund was RESERVED. 0083 splits
 *   reserving from settling on purpose, and on a gateway timeout the row is
 *   deliberately left pending until a webhook settles it — possibly the next
 *   day, and across a month boundary the next reporting period. Bucketing on
 *   `created_at` reintroduced exactly the restatement above by the back door: a
 *   refund reserved on 31 March and settled on 2 April was absent when March was
 *   read on the 1st and present inside March when it was read on the 3rd.
 *
 * `coalesce(processed_at, created_at)` is the read, so rows written before 0085
 * (and any that somehow reach 'processed' without a stamp) keep the old
 * behaviour instead of dropping out of the series.
 *
 * ── ONE CURRENCY AT A TIME ──────────────────────────────────────────────────
 *
 * `currency` is a required argument, and every aggregate below filters on it.
 * This series used to sum `total` and `amount` across the whole table with no
 * such filter, while readMrr() a hundred lines up grouped by currency for
 * exactly the right reason — so a single non-INR plan (createPlan accepts any
 * ISO 4217 code) made the chart add dollars to rupees and call the result a
 * number. Two neighbouring aggregates, two different rules, one of them wrong.
 *
 * The caller picks which currency to render — see getPlatformBillingDashboard(),
 * which uses the headline currency from readMrr() so the MRR tile and the chart
 * always describe the same money.
 *
 * ── Three queries, merged over a few hundred rows ───────────────────────────
 *
 * Both aggregates are computed by Postgres, and a third query generates the
 * bucket SPINE. The merge below joins the two series onto that spine — the same
 * shaping lib/reports/revenue.ts performs, and not aggregation in JS.
 */
async function readRevenue(
  db: DB,
  range: DateRange,
  bucket: RevenueBucket,
  currency: string,
): Promise<{ points: RevenuePoint[]; totals: RevenueTotals }> {
  // `bucket` is a closed union checked by the caller, never interpolated from a
  // request. It still goes in as a bound parameter rather than as string
  // concatenation, so there is no shape of call that could reach date_trunc
  // with attacker-chosen text.
  const invoiceRows = await db.execute<InvoiceBucketRow>(sql`
    select
      date_trunc(${bucket}, i.invoice_date::timestamp)::date::text as bucket_start,
      coalesce(sum(i.total) filter (
        where i.kind = 'subscription' and i.status = 'paid'
      ), 0) as gross,
      count(*) filter (
        where i.kind = 'subscription' and i.status = 'paid'
      ) as invoices,
      coalesce(sum(i.total) filter (where i.kind = 'credit_note'), 0) as credits
    from public.platform_invoices i
    where i.invoice_date >= ${range.start}::date
      and i.invoice_date <= ${range.end}::date
      and i.currency = ${currency}
    group by 1
    order by 1
  `)

  // `coalesce(processed_at, created_at)` — see the note above. Written once as a
  // lateral so the bucket expression and the range filter can never drift onto
  // two different columns, which is the shape the 0085 bug took.
  const refundRows = await db.execute<RefundBucketRow>(sql`
    select
      date_trunc(${bucket}, (s.settled_on)::timestamp)::date::text as bucket_start,
      coalesce(sum(r.amount), 0) as refunded
    from public.platform_refunds r
    cross join lateral (
      select (coalesce(r.processed_at, r.created_at) at time zone ${PLATFORM_TIMEZONE})::date
        as settled_on
    ) s
    where r.status = 'processed'
      and r.currency = ${currency}
      and s.settled_on >= ${range.start}::date
      and s.settled_on <= ${range.end}::date
    group by 1
    order by 1
  `)

  const refundByBucket = new Map(
    refundRows.rows.map((r) => [r.bucket_start, round2(num(r.refunded))]),
  )

  /**
   * The bucket SPINE — every bucket in the range, whether or not anything
   * happened in it.
   *
   * This comment used to claim the empty buckets were filled while the code
   * below took only the buckets some document had touched, so the series was
   * DISCONTIGUOUS and the chart drawing it as evenly spaced columns closed up
   * its own gaps: a quiet fortnight vanished and 28 Aug rendered flush against
   * 31 Aug, reading as a continuous axis that was nothing of the kind. A
   * revenue chart that hides the months with no revenue is the one shape this
   * page must not take.
   *
   * Generated by Postgres rather than in JS so it aligns with `date_trunc` BY
   * CONSTRUCTION: a week here starts on whatever weekday date_trunc('week')
   * chose, and restating that rule in JS is the kind of second definition that
   * drifts from the first. `bucket` is the same closed union the caller
   * checked, and the interval is built from it as a BOUND parameter — nothing
   * is concatenated into SQL.
   */
  const spineRows = await db.execute<{ bucket_start: string }>(sql`
    select gs::date::text as bucket_start
    from generate_series(
      date_trunc(${bucket}, ${range.start}::timestamp),
      date_trunc(${bucket}, ${range.end}::timestamp),
      ${`1 ${bucket}`}::interval
    ) as gs
  `)

  // The spine, plus any bucket a document actually landed in. That union is
  // belt-and-braces: both aggregates filter to the same range and truncate by
  // the same rule, so an observed bucket outside the spine should be
  // impossible — but were one ever to appear, dropping it would leave `totals`
  // disagreeing with the series it summarises, and a wrong total is worse than
  // an unexpected column.
  const keys = new Set<string>([
    ...spineRows.rows.map((r) => r.bucket_start),
    ...invoiceRows.rows.map((r) => r.bucket_start),
    ...refundByBucket.keys(),
  ])

  const invoiceByBucket = new Map(invoiceRows.rows.map((r) => [r.bucket_start, r]))

  const points: RevenuePoint[] = [...keys]
    .sort()
    .map((bucketStart) => {
      const inv = invoiceByBucket.get(bucketStart)
      const gross = round2(num(inv?.gross))
      const refunded = refundByBucket.get(bucketStart) ?? 0
      return {
        bucketStart,
        gross,
        refunded,
        net: round2(gross - refunded),
        invoices: num(inv?.invoices),
        creditsIssued: round2(num(inv?.credits)),
      }
    })

  const totals = points.reduce<RevenueTotals>(
    (acc, p) => ({
      gross: round2(acc.gross + p.gross),
      refunded: round2(acc.refunded + p.refunded),
      net: round2(acc.net + p.net),
      invoices: acc.invoices + p.invoices,
      creditsIssued: round2(acc.creditsIssued + p.creditsIssued),
    }),
    { gross: 0, refunded: 0, net: 0, invoices: 0, creditsIssued: 0 },
  )

  return { points, totals }
}

/**
 * Every currency the platform issued a paid invoice or settled a refund in over
 * this window, busiest first.
 *
 * Exists so the dashboard can TELL an operator that the revenue chart is one
 * currency out of several, rather than silently showing a subset — the honest
 * half of making readRevenue() single-currency.
 */
async function readBilledCurrencies(db: DB, range: DateRange): Promise<string[]> {
  const { rows } = await db.execute<{ currency: string }>(sql`
    select currency, sum(n) as n from (
      select i.currency, count(*) as n
        from public.platform_invoices i
       where i.kind = 'subscription'
         and i.status = 'paid'
         and i.invoice_date >= ${range.start}::date
         and i.invoice_date <= ${range.end}::date
       group by i.currency
      union all
      select r.currency, count(*) as n
        from public.platform_refunds r
       where r.status = 'processed'
         and (coalesce(r.processed_at, r.created_at) at time zone ${PLATFORM_TIMEZONE})::date
             between ${range.start}::date and ${range.end}::date
       group by r.currency
    ) s
    group by currency
    order by sum(n) desc, currency asc
  `)
  return rows.map((r) => r.currency)
}

// ── the per-tenant table ─────────────────────────────────────────────────────

export type TenantBillingRow = {
  tenantId: string
  slug: string
  name: string
  /** The ACCOUNT state (tenants.status) — trial | active | suspended | cancelled. */
  tenantStatus: string
  /** Null when the tenant has no live subscription at all. */
  subscriptionId: string | null
  planId: string | null
  planName: string | null
  billingPeriod: 'monthly' | 'annual' | null
  /** The live subscription's status, or null. */
  status: string | null
  currentPeriodEnd: Date | null
  /**
   * This tenant's contribution to `mrr`, computed with the SAME normalisation
   * as the platform total — so the column can be summed and will agree with the
   * headline figure. 0 for anything not `active` and unlapsed.
   */
  mrr: number
  currency: string
}

type TenantRow = {
  tenant_id: string
  slug: string
  name: string
  tenant_status: string
  subscription_id: string | null
  plan_id: string | null
  plan_name: string | null
  billing_period: string | null
  status: string | null
  current_period_end: string | null
  mrr: string | null
  currency: string | null
}

/**
 * One row per TENANT — never one per subscription — with the live subscription
 * attached where there is one.
 *
 * `distinct on (tenant_id)` again, for the same reason as the mix: history must
 * not turn one business into three rows.
 */
async function readTenantRows(db: DB, limit: number): Promise<TenantBillingRow[]> {
  const { rows } = await db.execute<TenantRow>(sql`
    with live as (
      select distinct on (s.tenant_id)
             s.tenant_id,
             s.id                    as subscription_id,
             s.plan_id,
             s.billing_period,
             s.status,
             s.current_period_end,
             s.gateway_subscription_id,
             case
               when s.status = 'active' and s.current_period_end > now()
                 then ${MONTHLY_VALUE}
               else 0
             end                     as mrr
        from public.tenant_subscriptions s
        join public.plans p on p.id = s.plan_id
       where s.status in ('trialing', 'active', 'past_due')
       order by s.tenant_id, s.current_period_start desc
    )
    select
      t.id                                    as tenant_id,
      t.slug,
      t.name,
      t.status                                as tenant_status,
      l.subscription_id,
      l.plan_id,
      pl.name                                 as plan_name,
      l.billing_period::text                  as billing_period,
      l.status::text                          as status,
      l.current_period_end::text              as current_period_end,
      coalesce(l.mrr, 0)                      as mrr,
      coalesce(pl.currency, 'INR')            as currency
      from public.tenants t
      left join live l  on l.tenant_id = t.id
      left join public.plans pl on pl.id = l.plan_id
     order by coalesce(l.mrr, 0) desc, t.name asc
     limit ${limit}
  `)

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    slug: r.slug,
    name: r.name,
    tenantStatus: r.tenant_status,
    subscriptionId: r.subscription_id,
    planId: r.plan_id,
    planName: r.plan_name,
    billingPeriod: (r.billing_period as 'monthly' | 'annual' | null) ?? null,
    status: r.status,
    currentPeriodEnd: r.current_period_end ? new Date(r.current_period_end) : null,
    mrr: round2(num(r.mrr)),
    currency: r.currency ?? 'INR',
  }))
}

// ── the dashboard ────────────────────────────────────────────────────────────

export type PlatformBillingDashboard = {
  range: DateRange
  bucket: RevenueBucket
  mrr: MrrByCurrency[]
  /** The largest currency's figures, for the headline tiles. Null on an empty platform. */
  headline: MrrByCurrency | null
  mix: SubscriptionMix
  churn: ChurnMetrics
  revenue: RevenuePoint[]
  revenueTotals: RevenueTotals
  /**
   * WHICH currency `revenue` and `revenueTotals` are denominated in. The series
   * is single-currency by construction — see readRevenue() — so this has to be
   * rendered alongside the figures rather than assumed to be INR.
   */
  revenueCurrency: string
  /**
   * Every currency the platform has actually billed in over this range. More
   * than one entry means the chart is showing a subset, which the dashboard
   * says out loud instead of quietly under-reporting.
   */
  billedCurrencies: string[]
  tenants: TenantBillingRow[]
}

/** How many tenants the table shows. The drill-down is per tenant, not paged. */
export const TENANT_ROW_LIMIT = 200

/**
 * Everything the platform billing dashboard renders, from ONE consistent
 * moment.
 *
 * The five reads run inside a single transaction so the headline MRR, the mix,
 * the churn rate and the tenant table cannot be taken from four different
 * instants — the same reason getBillingPortal() opens one transaction for the
 * owner-facing page. A renewal landing mid-render would otherwise produce a
 * dashboard whose columns do not add up, and "the numbers do not add up" is the
 * one thing a billing dashboard may never do.
 */
export async function getPlatformBillingDashboard(options: {
  range: DateRange
  bucket: RevenueBucket
  /**
   * Which currency the revenue series should be denominated in. Defaults to the
   * MRR headline, so the tiles and the chart describe the same money unless an
   * operator deliberately switches.
   *
   * Ignored unless the platform has actually billed in it over this range —
   * this arrives from a query string, and a chart that is silently empty
   * because somebody typed `?currency=ZZZ` is worse than one that says INR.
   */
  currency?: string
  db?: DB
}): Promise<PlatformBillingDashboard> {
  await requirePlatformAdmin()
  const { range, bucket, db = ownerDb } = options

  return db.transaction(async (tx) => {
    // Sequential, not Promise.all: they share one transaction, and a
    // transaction is a single connection — issuing five statements at once on
    // it would serialise anyway, or error.
    const mrr = await readMrr(tx)
    const mix = await readMix(tx)
    const churn = await readChurn(tx, range)

    // Which currencies actually appear in this window, so the caller can say
    // whether the single-currency series below is the whole picture.
    const billed = await readBilledCurrencies(tx, range)

    // The operator's explicit choice, if it names a currency actually billed in
    // this window; otherwise the MRR HEADLINE — the currency the platform makes
    // most of its money in — so the tiles and the chart describe the same money
    // by default. Falling back to whatever was billed, then to INR, keeps a
    // platform with no live subscriptions from rendering an empty chart for a
    // currency it demonstrably has invoices in.
    // The MRR headline is computed over LIVE SUBSCRIPTIONS; `billed` is
    // computed over INVOICES IN THIS WINDOW. They usually agree, and when they
    // do not, following the headline blindly renders an empty chart for a
    // currency with no activity in the range while a note underneath says where
    // the activity actually is. So the headline wins only if it is one of the
    // currencies actually billed here.
    const asked = options.currency?.trim().toUpperCase()
    const headlineCurrency = mrr[0]?.currency
    const revenueCurrency =
      asked && billed.includes(asked)
        ? asked
        : headlineCurrency && (billed.length === 0 || billed.includes(headlineCurrency))
          ? headlineCurrency
          : (billed[0] ?? headlineCurrency ?? 'INR')

    const revenue = await readRevenue(tx, range, bucket, revenueCurrency)
    const tenantRows = await readTenantRows(tx, TENANT_ROW_LIMIT)

    return {
      range,
      bucket,
      mrr,
      headline: mrr[0] ?? null,
      mix,
      churn,
      revenue: revenue.points,
      revenueTotals: revenue.totals,
      revenueCurrency,
      billedCurrencies: billed,
      tenants: tenantRows,
    }
  })
}

/**
 * The default bucket for a range.
 *
 * Daily points stop being readable somewhere past a quarter, and a year of them
 * is 366 bars in a div chart. The thresholds are stated here once so the page
 * and any future export agree; an explicit `?bucket=` always wins.
 */
export function defaultBucketFor(range: DateRange, days: number): RevenueBucket {
  void range
  if (days <= 62) return 'day'
  if (days <= 186) return 'week'
  return 'month'
}
