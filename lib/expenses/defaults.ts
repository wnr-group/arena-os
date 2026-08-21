/**
 * The expense categories a tenant starts with (AROS-107/108).
 *
 * Seeded, not hard-coded: these are ordinary rows a manager can rename, retire
 * or add to, which is why `expense_categories` is a table and not an enum. The
 * list exists so the Expenses page is usable the moment a tenant is created —
 * an expense REQUIRES a category (expenses.category_id is NOT NULL), so with an
 * empty catalogue the entry form is a dead end.
 *
 * Deliberately NOT in lib/expenses/data.ts: that module is `server-only` and
 * opens a DB pool on import, while scripts/seed-demo.ts is a standalone script
 * that avoids importing server-only app modules. A bare constant belongs
 * somewhere both can reach, so the two seeding paths cannot drift apart.
 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  'Rent',
  'Utilities',
  'Supplies',
  'Maintenance',
  'Salaries',
  'Other',
] as const
