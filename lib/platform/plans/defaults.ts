/**
 * The platform plan catalogue a fresh install starts with (M16).
 *
 * SEED DATA, not business logic. Exactly the same role DEFAULT_EXPENSE_CATEGORIES
 * plays for expenses: these become ordinary rows in `plans` / `plan_entitlements`
 * that the operator renames, reprices, retires or adds keys to from the platform
 * admin UI. Nothing in the application may import this to decide what a tenant
 * can do — `getEntitlements()` reads the DATABASE and returns whatever keys it
 * finds there. If this file and the database ever disagree, the database wins.
 *
 * Deliberately a bare constant in its own module, with no `server-only` and no
 * database import: scripts/seed-demo.ts is a standalone script that must not
 * pull in app modules that open a pool on import, and both it and the app need
 * to name the same starting catalogue.
 *
 * ── About the numbers ───────────────────────────────────────────────────────
 * The project defines no pricing anywhere, so these are invented starting
 * points for local development, not a commercial decision — expect the operator
 * to overwrite every one of them. What they DO establish is the shape:
 *
 *   * a limit is a number, and `null` means UNLIMITED (not zero, which would
 *     mean "none allowed");
 *   * a module flag is a boolean;
 *   * every plan carries the SAME key set, so a missing key always means "this
 *     plan predates that entitlement", never "unlimited by accident".
 *
 * `module.events` is present and false on the lower tiers even though M15
 * Tournaments & Events does not exist yet. That is intentional: the flag is how
 * the module will be sold when it lands, and carrying it now means the reader
 * and the admin UI are exercised against a false-valued module from day one.
 */

/** number → a limit · null → unlimited · boolean → a module switch. */
export type EntitlementSeedValue = number | boolean | null

export type PlanSeed = {
  name: string
  monthlyPrice: string
  annualPrice: string
  entitlements: Record<string, EntitlementSeedValue>
}

/**
 * The keys this catalogue ships with. Exported for the seed and for the admin
 * UI's "add entitlement" suggestions — NEVER as an allow-list. `key` in the
 * database is free text (shape-checked only), so the operator can add a key
 * this file has never heard of and the reader will return it.
 */
export const KNOWN_ENTITLEMENT_KEYS = [
  'max_branches',
  'max_staff',
  'max_resources',
  'module.payroll',
  'module.expenses',
  'module.reports',
  'module.events',
] as const

export const DEFAULT_PLANS: readonly PlanSeed[] = [
  {
    name: 'Starter',
    monthlyPrice: '2999.00',
    annualPrice: '29990.00',
    entitlements: {
      max_branches: 1,
      max_staff: 5,
      max_resources: 10,
      'module.payroll': false,
      'module.expenses': false,
      'module.reports': false,
      'module.events': false,
    },
  },
  {
    name: 'Pro',
    monthlyPrice: '7999.00',
    annualPrice: '79990.00',
    entitlements: {
      max_branches: 3,
      max_staff: 25,
      max_resources: 50,
      'module.payroll': true,
      'module.expenses': true,
      'module.reports': true,
      'module.events': false,
    },
  },
  {
    name: 'Enterprise',
    monthlyPrice: '19999.00',
    annualPrice: '199990.00',
    entitlements: {
      // null, not a large number: "unlimited" is a distinct fact and the reader
      // hands it through as null rather than a sentinel a caller could compare
      // against by mistake.
      max_branches: null,
      max_staff: null,
      max_resources: null,
      'module.payroll': true,
      'module.expenses': true,
      'module.reports': true,
      'module.events': true,
    },
  },
] as const
