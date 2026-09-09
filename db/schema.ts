/**
 * Drizzle schema — the TypeScript source of truth for typed queries.
 *
 * The DATABASE structure (including RLS policies, helper functions, roles and
 * grants that Drizzle cannot express) is authored as SQL in db/migrations. Keep
 * the table/column shapes here in sync with those migrations.
 */
import { relations, sql } from 'drizzle-orm'
import {
  pgTable,
  pgView,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  date,
  time,
  numeric,
  integer,
  smallint,
  jsonb,
  unique,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/pg-core'

// ── enums ────────────────────────────────────────────────────────────────────
export const tenantStatus = pgEnum('tenant_status', ['trial', 'active', 'suspended', 'cancelled'])
export const tenantIndustry = pgEnum('tenant_industry', [
  'gaming_cafe',
  'recording_studio',
  'podcast_studio',
  'dance_studio',
  'vr_centre',
  'restaurant',
  'other',
])
export const branchStatus = pgEnum('branch_status', ['active', 'inactive'])
export const memberRole = pgEnum('member_role', [
  'owner',
  'manager',
  'cashier',
  'kitchen_staff',
  'floor_staff',
  'receptionist',
])
export const memberStatus = pgEnum('member_status', ['invited', 'active', 'disabled'])

// ── identity (global, not tenant-scoped) ─────────────────────────────────────
// users + sessions are owned/read only through the OWNER connection (auth is a
// privileged bootstrap). They are NOT granted to the app role, so a tenant query
// can never enumerate the global user table.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // opaque random token stored in the cookie
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── tenancy (RLS-protected, granted to app role) ─────────────────────────────
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  industry: tenantIndustry('industry').notNull().default('gaming_cafe'),
  status: tenantStatus('status').notNull().default('trial'),
  currency: text('currency').notNull().default('INR'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    timezone: text('timezone'),
    isPrimary: boolean('is_primary').notNull().default(false),
    status: branchStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('branches_tenant_name_key').on(t.tenantId, t.name),
    index('idx_branches_tenant').on(t.tenantId),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    role: memberRole('role').notNull().default('cashier'),
    status: memberStatus('status').notNull().default('active'),
    fullName: text('full_name'),
    email: text('email'),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('memberships_tenant_user_key').on(t.tenantId, t.userId),
    index('idx_memberships_user').on(t.userId),
    index('idx_memberships_tenant').on(t.tenantId),
  ],
)

// ── booking module (migration 0003) ─────────────────────────────────────────
export const resourceStatus = pgEnum('resource_status', ['available', 'maintenance', 'inactive'])
export const bookingStatus = pgEnum('booking_status', [
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show',
])
export const bookingSource = pgEnum('booking_source', ['walk_in', 'staff', 'online'])

export const resourceTypes = pgTable(
  'resource_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }).notNull().default('0'),
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    capacity: integer('capacity'),
    color: text('color'),
    imageUrl: text('image_url'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('resource_types_tenant_name_key').on(t.tenantId, t.name),
    index('idx_resource_types_tenant').on(t.tenantId),
  ],
)

export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    resourceTypeId: uuid('resource_type_id')
      .notNull()
      .references(() => resourceTypes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    hourlyRateOverride: numeric('hourly_rate_override', { precision: 10, scale: 2 }),
    status: resourceStatus('status').notNull().default('available'),
    imageUrl: text('image_url'),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    // Unguessable public identifier for the QR-at-station ordering entry
    // point — see 0048_resource_qr_token.sql for why this can't just be id.
    qrToken: uuid('qr_token').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('resources_tenant_name_key').on(t.tenantId, t.name),
    unique('resources_tenant_qr_key').on(t.tenantId, t.qrToken),
    index('idx_resources_branch').on(t.tenantId, t.branchId),
    index('idx_resources_type').on(t.resourceTypeId),
  ],
)

export const workingHours = pgTable(
  'working_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week').notNull(),
    openTime: text('open_time').notNull().default('10:00'),
    closeTime: text('close_time').notNull().default('22:00'),
    isClosed: boolean('is_closed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('working_hours_branch_day_key').on(t.branchId, t.dayOfWeek),
    index('idx_working_hours_branch').on(t.tenantId, t.branchId),
  ],
)

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    bookingNumber: text('booking_number').notNull(),
    // Unguessable public identifier — see 0026_booking_confirmation_token.sql
    // for why this can't just be bookingNumber.
    confirmationToken: uuid('confirmation_token').notNull().defaultRandom(),
    // Snapshot of what the guest gave at the time (migration 0003) …
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    // … and the directory entry it belongs to (migration 0007). Nullable: a
    // booking taken without a phone, or one whose customer was later removed.
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    status: bookingStatus('status').notNull().default('confirmed'),
    source: bookingSource('source').notNull().default('staff'),
    subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull().default('0'),
    discount: numeric('discount', { precision: 10, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 10, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 10, scale: 2 }).notNull().default('0'),
    deposit: numeric('deposit', { precision: 10, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /**
     * Raised (migration 0047) when a CUSTOMER cancels a booking the venue is
     * holding a deposit against. Nothing is refunded automatically — this is
     * the staff work queue, and only staff ever lower it.
     */
    depositReviewRequired: boolean('deposit_review_required').notNull().default(false),
    // M17 (0071): an open-ended table session's guest count and its direct
    // resource link (in place of booking_slots — see that migration's
    // comment). Null for every timed booking in every other industry.
    coverCount: integer('cover_count'),
    resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'restrict' }),
    // M17 (0072): when the table's bill was requested. Null for every
    // non-restaurant booking.
    billRequestedAt: timestamp('bill_requested_at', { withTimezone: true }),
  },
  (t) => [
    unique('bookings_tenant_number_key').on(t.tenantId, t.bookingNumber),
    unique('bookings_tenant_token_key').on(t.tenantId, t.confirmationToken),
    // Target of the composite (tenant_id, booking_id) FK on invoices (0010).
    unique('bookings_tenant_id_key').on(t.tenantId, t.id),
    index('idx_bookings_branch').on(t.tenantId, t.branchId),
    index('idx_bookings_status').on(t.tenantId, t.status),
    index('idx_bookings_customer').on(t.tenantId, t.customerId),
    // Partial (resource_id is not null) in the DB — see 0071_table_sessions.sql.
    index('idx_bookings_resource').on(t.tenantId, t.resourceId),
  ],
)

export const bookingSlots = pgTable(
  'booking_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /**
     * Null when this row is an EVENT RESOURCE BLOCK (M15 #4, migration 0094).
     * `booking_slots_one_owner` CHECKs that exactly one of bookingId/eventId is
     * set, so a slot always has exactly one lifecycle that releases it.
     */
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'cascade' }),
    /**
     * Set when this row reserves a resource for an EVENT rather than a
     * customer (0094). The booking_slots_no_overlap exclusion constraint treats
     * both identically — which is the whole mechanism by which an event and a
     * booking cannot occupy one resource at the same time.
     */
    eventId: uuid('event_id'),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    rateApplied: numeric('rate_applied', { precision: 10, scale: 2 }).notNull().default('0'),
    slotTotal: numeric('slot_total', { precision: 10, scale: 2 }).notNull().default('0'),
    resourceName: text('resource_name').notNull(),
    resourceTypeName: text('resource_type_name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_booking_slots_booking').on(t.bookingId),
    index('idx_booking_slots_resource_time').on(t.resourceId, t.startsAt),
  ],
)

// ── employee management (migration 0006) ────────────────────────────────────
export const attendance = pgTable(
  'attendance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    workDate: date('work_date').notNull(),
    clockIn: timestamp('clock_in', { withTimezone: true }),
    clockOut: timestamp('clock_out', { withTimezone: true }),
    isManual: boolean('is_manual').notNull().default(false),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_attendance_date').on(t.tenantId, t.workDate),
    index('idx_attendance_member').on(t.membershipId),
  ],
)

// ── shifts & roster (migration 0007) ─────────────────────────────────────────
export const shiftType = pgEnum('shift_type', ['morning', 'evening', 'night'])

export const rosters = pgTable(
  'rosters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    weekStart: date('week_start').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('rosters_branch_week_key').on(t.branchId, t.weekStart)],
)

export const shifts = pgTable(
  'shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    rosterId: uuid('roster_id').references(() => rosters.id, { onDelete: 'set null' }),
    shiftDate: date('shift_date').notNull(),
    type: shiftType('type').notNull(),
    starts: time('starts').notNull(),
    ends: time('ends').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_shifts_member_date').on(t.membershipId, t.shiftDate)],
)

// ── tasks (migration 0008) ───────────────────────────────────────────────────
export const taskStatus = pgEnum('task_status', ['open', 'in_progress', 'done'])

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    assignedTo: uuid('assigned_to').references(() => memberships.id, { onDelete: 'set null' }),
    status: taskStatus('status').notNull().default('open'),
    dueDate: date('due_date'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_tasks_assignee').on(t.assignedTo)],
)

/**
 * A named pay component — HRA, PF, etc. `amount` is numeric(10,2)-shaped as a
 * string, same convention as TaxBreakupLine below: money in JSON is never a
 * float.
 */
export type SalaryComponent = {
  label: string
  amount: string
}

// ── salary structures (migration 0027) ──────────────────────────────────────
// Versioned by effective_from — see 0027_salary_structures.sql for why a raise
// is a new row rather than an edit of the old one.
export const salaryStructures = pgTable(
  'salary_structures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    base: numeric('base', { precision: 10, scale: 2 }).notNull().default('0'),
    allowances: jsonb('allowances').$type<SalaryComponent[]>().notNull().default([]),
    deductions: jsonb('deductions').$type<SalaryComponent[]>().notNull().default([]),
    effectiveFrom: date('effective_from').notNull(),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('salary_structures_member_effective_key').on(t.membershipId, t.effectiveFrom),
    index('idx_salary_structures_member').on(t.membershipId, t.effectiveFrom),
  ],
)

// ── employee advances (migration 0028) ───────────────────────────────────────
// The plan (this table) vs. the ledger (employeeAdvanceRecoveries) — outstanding
// is always derived as amount minus the sum of recoveries, never stored. See
// 0028_employee_advances.sql for why the recoveries grant is insert-only.
export const employeeAdvances = pgTable(
  'employee_advances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    instalmentAmount: numeric('instalment_amount', { precision: 10, scale: 2 }).notNull(),
    note: text('note'),
    givenAt: date('given_at').notNull(),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employee_advances_tenant_id_key').on(t.tenantId, t.id),
    index('idx_employee_advances_member').on(t.membershipId),
  ],
)

export const employeeAdvanceRecoveries = pgTable(
  'employee_advance_recoveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    advanceId: uuid('advance_id').notNull(),
    // Signed like wallet/loyalty: positive = recovery, negative = a
    // correction. Never updated or deleted — see the migration.
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'employee_advance_recoveries_advance_tenant_fkey',
      columns: [t.tenantId, t.advanceId],
      foreignColumns: [employeeAdvances.tenantId, employeeAdvances.id],
    }).onDelete('cascade'),
    index('idx_employee_advance_recoveries_advance').on(t.advanceId),
  ],
)

// ── payslips (migration 0029, RLS widened 0030) ──────────────────────────────
// The payroll run's output — a frozen snapshot per (membership, period), never
// rewritten by a later salary-structure edit or attendance correction. See
// 0029_payroll_runs.sql for the idempotency and net-pay-floor reasoning.
// SELECT is self-service (a staff member sees their own rows) plus
// owner/manager (see everyone's) — see 0030_payslips_self_view.sql. INSERT
// stays owner-only: only the payroll run writes these.
export const payslips = pgTable(
  'payslips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    /** Calendar month this payslip covers, 'YYYY-MM'. */
    period: text('period').notNull(),
    base: numeric('base', { precision: 10, scale: 2 }).notNull(),
    allowances: jsonb('allowances').$type<SalaryComponent[]>().notNull().default([]),
    deductions: jsonb('deductions').$type<SalaryComponent[]>().notNull().default([]),
    daysInPeriod: smallint('days_in_period').notNull(),
    daysPresent: smallint('days_present').notNull(),
    gross: numeric('gross', { precision: 10, scale: 2 }).notNull(),
    deductionsTotal: numeric('deductions_total', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    advanceInstalment: numeric('advance_instalment', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    netPay: numeric('net_pay', { precision: 10, scale: 2 }).notNull().default('0'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payslips_membership_period_key').on(t.membershipId, t.period),
    index('idx_payslips_tenant_period').on(t.tenantId, t.period),
    index('idx_payslips_member').on(t.membershipId),
  ],
)

// ── tax rates (migration 0009) ───────────────────────────────────────────────
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    percent: numeric('percent', { precision: 5, scale: 2 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('tax_rates_tenant_name_key').on(t.tenantId, t.name)],
)

// ── menu (migration 0010) ────────────────────────────────────────────────────
export const menuItemStatus = pgEnum('menu_item_status', ['available', 'out_of_stock', 'hidden'])
export const discountType = pgEnum('discount_type', ['percentage', 'fixed'])

export const menuCategories = pgTable(
  'menu_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('menu_categories_tenant_name_key').on(t.tenantId, t.name)],
)

export const menuItems = pgTable(
  'menu_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => menuCategories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'set null' }),
    status: menuItemStatus('status').notNull().default('available'),
    imageUrl: text('image_url'),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    happyHourEligible: boolean('happy_hour_eligible').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_menu_items_tenant').on(t.tenantId, t.categoryId)],
)

// ── modifiers (migration 0076) ───────────────────────────────────────────────
// Structured per-item choices — size, add-ons, "no onions" — as opposed to
// specialInstructions' free text. A group (e.g. "Size") holds options (e.g.
// "Small"/"Large", each with its own price_delta); menu_item_modifier_groups
// is the many-to-many attaching groups to the items that offer them, so
// "Spice Level" can be defined once and reused across a dozen dishes.
export const modifierGroups = pgTable(
  'modifier_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // How many options from this group an order must/may carry. `required`
    // is a display convenience (minSelect >= 1 is the actual enforcement,
    // re-derived in lib/orders/service.ts — never trust this flag alone).
    minSelect: integer('min_select').notNull().default(0),
    maxSelect: integer('max_select').notNull().default(1),
    required: boolean('required').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('modifier_groups_tenant_name_key').on(t.tenantId, t.name)],
)

export const modifierOptions = pgTable(
  'modifier_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => modifierGroups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    priceDelta: numeric('price_delta', { precision: 10, scale: 2 }).notNull().default('0'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_modifier_options_group').on(t.groupId)],
)

export const menuItemModifierGroups = pgTable(
  'menu_item_modifier_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => modifierGroups.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    unique('menu_item_modifier_groups_item_group_key').on(t.menuItemId, t.groupId),
    index('idx_menu_item_modifier_groups_item').on(t.menuItemId),
  ],
)

export const happyHours = pgTable('happy_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  daysOfWeek: smallint('days_of_week').array().notNull().default([]),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  discountType: discountType('discount_type').notNull(),
  discountValue: numeric('discount_value', { precision: 10, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── orders (migration 0012) ──────────────────────────────────────────────────
export const orderStatus = pgEnum('order_status', ['open', 'billed', 'cancelled'])
// Who placed it (migration 0054) — 'staff' for the POS flow, 'online' for a
// customer ordering from a station's QR entry point.
export const orderChannel = pgEnum('order_channel', ['staff', 'online'])
// Staff accept/reject gate for online orders (migration 0057) — defaults to
// 'accepted' so every staff/POS order (and every pre-existing row) skips the
// gate entirely; only an online order can ever be inserted as 'pending'.
// 'awaiting_payment' (migration 0058) — a standalone pay-now order between
// being placed and its webhook confirming payment. Distinct from 'pending'
// (the staff accept/reject queue) and invisible to it the same way; distinct
// from 'accepted' (visible to /kitchen) until the webhook flips it there.
export const orderAcceptanceStatus = pgEnum('order_acceptance_status', [
  'pending',
  'accepted',
  'rejected',
  'awaiting_payment',
])

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    orderNumber: text('order_number').notNull(),
    status: orderStatus('status').notNull().default('open'),
    // Attribution (migration 0054): channel always set; customerId/resourceId
    // nullable — a staff order has neither, an online order may have either
    // or both. See lib/booking/attribution.ts for how resourceId resolves
    // bookingId when the station has an active booking.
    channel: orderChannel('channel').notNull().default('staff'),
    // Accept/reject gate (migration 0057) — see lib/orders/service.ts's
    // acceptOrderCore/rejectOrderCore. rejectionReason is only ever set
    // alongside acceptanceStatus: 'rejected'.
    acceptanceStatus: orderAcceptanceStatus('acceptance_status').notNull().default('accepted'),
    rejectionReason: text('rejection_reason'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    // Idempotency (migration 0065, column type fixed in 0068) — a
    // client-generated key (lib/utils/idempotency-key.ts's newIdempotencyKey,
    // NOT crypto.randomUUID — see 0068 for why), reused verbatim on any retry
    // of the SAME checkout/take-order attempt, so createOrderCore can
    // recognise a retry and hand back the original order instead of creating
    // a second one. Null for rows that predate this column.
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('orders_tenant_number_key').on(t.tenantId, t.orderNumber),
    // Target of payment_intents' composite (tenant_id, order_id) FK
    // (migration 0058) — same device bookings/invoices/payment_intents
    // themselves use for the same purpose.
    unique('orders_tenant_id_key').on(t.tenantId, t.id),
    // NULLs are never equal to each other under a UNIQUE constraint, so a
    // caller that omits idempotencyKey never collides with any other row.
    unique('orders_tenant_idempotency_key').on(t.tenantId, t.idempotencyKey),
    index('idx_orders_branch').on(t.tenantId, t.branchId),
    index('idx_orders_booking').on(t.bookingId),
    index('idx_orders_customer').on(t.tenantId, t.customerId),
    index('idx_orders_resource').on(t.resourceId),
  ],
)

// Void/comp (migration 0073). See lib/orders/service.ts's voidOrderItemCore —
// 'voided' (removed, ordered by mistake) and 'comped' (given free) are both
// excluded from billing identically; the status is only what tells them
// apart on the void/comp report (M20).
export const orderItemVoidStatus = pgEnum('order_item_void_status', ['active', 'voided', 'comped'])

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    menuItemId: uuid('menu_item_id').references(() => menuItems.id, { onDelete: 'set null' }),
    itemName: text('item_name').notNull(),
    unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    qty: integer('qty').notNull(),
    lineTotal: numeric('line_total', { precision: 10, scale: 2 }).notNull(),
    specialInstructions: text('special_instructions'),
    // Happy-hour snapshot (migration 0021). Null when no rule applied. Frozen
    // at order time so an edited/deleted rule never reprices a past line.
    happyHourId: uuid('happy_hour_id').references(() => happyHours.id, { onDelete: 'set null' }),
    happyHourName: text('happy_hour_name'),
    originalUnitPrice: numeric('original_unit_price', { precision: 10, scale: 2 }),
    happyHourDiscountType: discountType('happy_hour_discount_type'),
    happyHourDiscountValue: numeric('happy_hour_discount_value', { precision: 10, scale: 2 }),
    voidStatus: orderItemVoidStatus('void_status').notNull().default('active'),
    voidReason: text('void_reason'),
    voidedBy: uuid('voided_by').references(() => memberships.id, { onDelete: 'set null' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
  },
  (t) => [index('idx_order_items_order').on(t.orderId)],
)

// ── order item modifiers (migration 0076) ───────────────────────────────────
// The chosen modifiers for one order_items line, snapshotted at order time —
// same discipline as the happy-hour columns above (group_name/option_name/
// price_delta are frozen text/numbers, never re-read from modifier_options
// later), except one-to-MANY (a burger can carry several), so a child table
// rather than more columns on order_items. modifier_option_id is kept only as
// a soft pointer (on delete set null) for reporting — nothing re-reads it to
// reprice. order_items.unit_price already has every selected delta folded in
// (see createOrderCore), so billing needs no separate awareness of this table.
export const orderItemModifiers = pgTable(
  'order_item_modifiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    modifierOptionId: uuid('modifier_option_id').references(() => modifierOptions.id, { onDelete: 'set null' }),
    groupName: text('group_name').notNull(),
    optionName: text('option_name').notNull(),
    priceDelta: numeric('price_delta', { precision: 10, scale: 2 }).notNull(),
  },
  (t) => [index('idx_order_item_modifiers_order_item').on(t.orderItemId)],
)

// ── order item void/comp requests (migration 0074) ──────────────────────────
// A waiter-raised request awaiting manager approval — see
// lib/orders/service.ts's requestVoidOrderItemCore/decideVoidRequestCore.
// Approval flips the linked order_items row above; rejection leaves it
// untouched. Kept forever either way, for the void/comp report (M20).
export const orderItemVoidRequestMode = pgEnum('order_item_void_request_mode', ['void', 'comp'])
export const orderItemVoidRequestStatus = pgEnum('order_item_void_request_status', [
  'pending',
  'approved',
  'rejected',
])

export const orderItemVoidRequests = pgTable(
  'order_item_void_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    mode: orderItemVoidRequestMode('mode').notNull(),
    reason: text('reason').notNull(),
    status: orderItemVoidRequestStatus('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').references(() => memberships.id, { onDelete: 'set null' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => memberships.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
  },
  (t) => [index('idx_order_item_void_requests_pending').on(t.tenantId, t.requestedAt)],
)

// ── kots (migration 0013) ────────────────────────────────────────────────────
export const kotStatus = pgEnum('kot_status', [
  'pending',
  'preparing',
  'ready',
  'served',
  'cancelled',
])

export const kots = pgTable(
  'kots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kotNumber: text('kot_number').notNull(),
    status: kotStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('kots_tenant_number_key').on(t.tenantId, t.kotNumber),
    index('idx_kots_open').on(t.tenantId, t.branchId, t.status),
  ],
)

// ── notifications (migration 0061) ───────────────────────────────────────────
// A minimal outbox, forward-compatible with the roadmap's eventual M3-C
// design (notification_settings + notifications + retry) — see
// lib/notifications/service.ts. No real SMS/WhatsApp provider is wired in
// yet, so every row today is expected to land at status='skipped'.
export const notificationChannel = pgEnum('notification_channel', ['sms'])
export const notificationStatus = pgEnum('notification_status', ['sent', 'skipped', 'failed'])

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    channel: notificationChannel('channel').notNull(),
    kind: text('kind').notNull(),
    recipientPhone: text('recipient_phone'),
    messageBody: text('message_body').notNull(),
    status: notificationStatus('status').notNull(),
    skipReason: text('skip_reason'),
    providerMessageId: text('provider_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_notifications_order').on(t.tenantId, t.orderId)],
)

// ── customer module (migration 0006) ─────────────────────────────────────────
// `phone` is stored NORMALISED to E.164 by lib/customers/phone.ts and is the
// tenant-scoped identity key — see the unique index below.
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    name: text('name'),
    email: text('email'),
    dob: date('dob'),
    tags: text('tags').array().notNull().default([]),
    membershipStatus: text('membership_status'),
    // Explicit, revisable opt-in for "order ready" texts (migration 0061) —
    // checked by default at checkout; see lib/notifications/service.ts.
    notifyOrderReady: boolean('notify_order_ready').notNull().default(true),
    /**
     * Communication preferences (migration 0048), edited by the customer in the
     * portal. Consent for messages about their OWN bookings — not a marketing
     * opt-in — which is why both default to true rather than false.
     */
    smsOptIn: boolean('sms_opt_in').notNull().default(true),
    emailOptIn: boolean('email_opt_in').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customers_tenant_phone_key').on(t.tenantId, t.phone),
    index('idx_customers_tenant').on(t.tenantId),
  ],
)

export const customerNotes = pgTable(
  'customer_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Notes are editable (migration 0009); the set_updated_at() trigger keeps
    // this fresh, so app code never writes it.
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_customer_notes_customer').on(t.customerId)],
)

// Append-only ledger. `amount` is signed (+ credit / − debit); the wallet
// balance is sum(amount) — there is deliberately no balance column.
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    reason: text('reason'),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_wallet_tx_customer').on(t.customerId)],
)

// Append-only ledger. `points` is signed (+ earned / − redeemed); the loyalty
// balance is sum(points) — there is deliberately no total column.
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    points: integer('points').notNull(),
    reason: text('reason'),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_loyalty_tx_customer').on(t.customerId),
    // THE idempotency rule (0029): one entry per (tenant, purpose, source),
    // so an invoice can earn once and be redeemed against once.
    uniqueIndex('idx_loyalty_tx_source')
      .on(t.tenantId, t.sourceType, t.sourceId)
      .where(sql`${t.sourceId} is not null`),
    index('idx_loyalty_tx_tenant_customer').on(t.tenantId, t.customerId),
  ],
)

// ── customer auth (migration 0044) ───────────────────────────────────────────
// The customer-portal twin of `sessions`/`users` above. Separate tables,
// separate cookie, separate resolver — a staff token is meaningless here and a
// customer token is meaningless to the staff surface.

// Short-lived phone-verification challenge. `codeHash` is an HMAC-SHA-256 of
// the issued code (lib/otp/challenge.ts) — the code itself is never stored.
export const customerOtpChallenges = pgTable(
  'customer_otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Always E.164, same CHECK as customers.phone. */
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_customer_otp_tenant_phone').on(t.tenantId, t.phone, t.createdAt),
    index('idx_customer_otp_expires').on(t.expiresAt),
  ],
)

// Reached ONLY through the owner connection (not granted to arena_app), exactly
// like `sessions`. `id` is the SHA-256 of the token held in the cookie.
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // (tenant_id, customer_id) → customers(tenant_id, id): a session pointing
    // at another tenant's customer is structurally impossible (0016's trick).
    foreignKey({
      name: 'customer_sessions_customer_tenant_fkey',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    index('idx_customer_sessions_customer').on(t.tenantId, t.customerId),
    index('idx_customer_sessions_expires').on(t.expiresAt),
  ],
)

// ── business profile (migration 0012) ────────────────────────────────────────
// The tenant's legal identity, as printed on a GST invoice. `tenantId` is the
// primary key, so there is exactly one row per tenant by construction.
export const businessProfiles = pgTable('business_profiles', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  legalName: text('legal_name'),
  gstin: text('gstin'),
  address: text('address'),
  logoUrl: text('logo_url'),
  /** Feeds invoice numbering. Capped at 4 chars — see the migration's CHECK. */
  invoicePrefix: text('invoice_prefix').notNull().default('INV'),
  placeOfSupply: text('place_of_supply'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const businessProfilesRelations = relations(businessProfiles, ({ one }) => ({
  tenant: one(tenants, { fields: [businessProfiles.tenantId], references: [tenants.id] }),
}))

// ── promo codes (migration 0011) ─────────────────────────────────────────────
// Declared before `invoices` because invoices carries the composite FK onto it.
// `discountType` is the SAME Postgres enum the happy-hours module declares above
// (both are 'percentage' | 'fixed'), so it is declared once and shared — and
// migration 0011 creates the type guarded, in case 0010_menu got there first.
//
// `code` is matched case-insensitively: the unique index is on upper(code), so
// WELCOME10 / welcome10 / Welcome10 are one promo per tenant, while the same
// string in another tenant is a different promo.
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    discountType: discountType('discount_type').notNull(),
    discountValue: numeric('discount_value', { precision: 10, scale: 2 }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    /** null = unlimited. */
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite (tenant_id, promo_code_id) FK on invoices.
    unique('promo_codes_tenant_id_key').on(t.tenantId, t.id),
    uniqueIndex('idx_promo_code').on(t.tenantId, sql`upper(${t.code})`),
  ],
)

// ── webhook delivery log (migration 0024) ────────────────────────────────────
// One row per verified gateway delivery. `event_id` is the DELIVERY identity
// (cheap replay short-circuit + audit); payment idempotency lives on
// payment_intents.gateway_payment_id, which is the MONEY identity.
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gateway: text('gateway').notNull().default('razorpay'),
    eventId: text('event_id'),
    eventType: text('event_type').notNull(),
    /** Resolved from our own payment intent, never from the payload. */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: text('order_id'),
    paymentId: text('payment_id'),
    /** 'processed' | 'duplicate' | 'ignored' | 'rejected' */
    outcome: text('outcome').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_webhook_events_event')
      .on(t.gateway, t.eventId)
      .where(sql`${t.eventId} is not null`),
    index('idx_webhook_events_tenant').on(t.tenantId, t.receivedAt),
  ],
)

// ── payment intents (migration 0023) ─────────────────────────────────────────
// A gateway order awaiting confirmation. Created by AROS-49 when a deposit
// checkout is opened; settled by AROS-50 when the webhook signature verifies.
// `status` stays 'pending' here — creating an order is not receiving money.
export const paymentIntentStatus = pgEnum('payment_intent_status', [
  'pending',
  'paid',
  'failed',
  'cancelled',
])
// 'order_payment' (migration 0058) — pay-now for a standalone order with no
// booking to add-to-bill against. See payment_intents' order_id/booking_id
// note below for how the two purposes stay mutually exclusive.
export const paymentIntentPurpose = pgEnum('payment_intent_purpose', [
  'booking_deposit',
  'order_payment',
  // An event entry fee (migration 0092) — the third target, same table, same
  // webhook, same tenant BYO credentials.
  'event_registration',
])

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    // Exactly one of bookingId/orderId is set (migration 0058's
    // payment_intents_exactly_one_target check) — a booking deposit or a
    // standalone order's pay-now, never both, never neither.
    bookingId: uuid('booking_id'),
    orderId: uuid('order_id'),
    // The third target (migration 0092) — an event entry fee. Same one-of-N
    // rule: payment_intents_exactly_one_target now counts three columns.
    eventRegistrationId: uuid('event_registration_id'),
    purpose: paymentIntentPurpose('purpose').notNull().default('booking_deposit'),
    gateway: text('gateway').notNull().default('razorpay'),
    /** Razorpay `order_…`. Written only after the gateway call returns. */
    gatewayOrderId: text('gateway_order_id').notNull(),
    /** Filled by AROS-50 from the verified webhook, never at order creation. */
    gatewayPaymentId: text('gateway_payment_id'),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('INR'),
    status: paymentIntentStatus('status').notNull().default('pending'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_intents_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'payment_intents_booking_tenant_fkey',
      columns: [t.tenantId, t.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'payment_intents_order_tenant_fkey',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }).onDelete('cascade'),
    // At most ONE pending intent per booking+purpose, and separately at most
    // ONE per order+purpose — the idempotency rule, split in two (migration
    // 0058) because bookingId/orderId are each null on the other's rows and a
    // single index could no longer assume bookingId was always set.
    uniqueIndex('idx_payment_intents_one_pending_booking')
      .on(t.tenantId, t.bookingId, t.purpose)
      .where(sql`${t.status} = 'pending' and ${t.bookingId} is not null`),
    uniqueIndex('idx_payment_intents_one_pending_order')
      .on(t.tenantId, t.orderId, t.purpose)
      .where(sql`${t.status} = 'pending' and ${t.orderId} is not null`),
    // AROS-50's webhook lookup. Deliberately not tenant-scoped: a Razorpay
    // order id is globally unique and must resolve to exactly one intent.
    uniqueIndex('idx_payment_intents_gateway_order').on(t.gateway, t.gatewayOrderId),
    // AROS-50's idempotency guarantee: one Razorpay payment settles one intent,
    // enforced by Postgres so concurrent deliveries cannot both win.
    uniqueIndex('idx_payment_intents_gateway_payment')
      .on(t.gateway, t.gatewayPaymentId)
      .where(sql`${t.gatewayPaymentId} is not null`),
    uniqueIndex('idx_payment_intents_one_pending_event_registration')
      .on(t.tenantId, t.eventRegistrationId, t.purpose)
      .where(sql`${t.status} = 'pending' and ${t.eventRegistrationId} is not null`),
    index('idx_payment_intents_booking').on(t.tenantId, t.bookingId),
    index('idx_payment_intents_order').on(t.tenantId, t.orderId),
    index('idx_payment_intents_event_registration').on(t.tenantId, t.eventRegistrationId),
  ],
)

// ── customer memberships (migration 0026) ────────────────────────────────────
// A plan a customer has BOUGHT, as opposed to membershipPlans (what the venue
// sells) and memberships (a staff seat). Every benefit column is a SNAPSHOT
// taken at purchase: repricing the plan later must not change what an existing
// member already paid for, so no benefit is ever read through `planId`.
export const customerMembershipStatus = pgEnum('customer_membership_status', [
  'active',
  'expired',
  'cancelled',
])

export const customerMemberships = pgTable(
  'customer_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    /** Provenance only — never the source of a benefit value. */
    planId: uuid('plan_id').notNull(),

    // ── snapshot, mirroring membershipPlans exactly ────────────────────────
    planName: text('plan_name').notNull(),
    pricePaid: numeric('price_paid', { precision: 10, scale: 2 }).notNull(),
    durationMonths: integer('duration_months').notNull(),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    freeHours: numeric('free_hours', { precision: 10, scale: 2 }).notNull().default('0'),
    walletCredit: numeric('wallet_credit', { precision: 10, scale: 2 }).notNull().default('0'),
    /** Drawdown of the free-hours benefit; consumed by AROS-61. */
    freeHoursUsed: numeric('free_hours_used', { precision: 10, scale: 2 }).notNull().default('0'),

    // ── lifecycle ───────────────────────────────────────────────────────────
    status: customerMembershipStatus('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    /** Reserved for the ticket that adds a non-booking GST invoice path. */
    invoiceId: uuid('invoice_id'),
    soldBy: uuid('sold_by').references(() => memberships.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_memberships_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'customer_memberships_customer_tenant_fkey',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'customer_memberships_plan_tenant_fkey',
      columns: [t.tenantId, t.planId],
      foreignColumns: [membershipPlans.tenantId, membershipPlans.id],
    }),
    // At most ONE active membership per customer — what makes "which discount
    // applies?" have a single answer.
    uniqueIndex('idx_customer_memberships_one_active')
      .on(t.tenantId, t.customerId)
      .where(sql`${t.status} = 'active'`),
    index('idx_customer_memberships_customer').on(t.tenantId, t.customerId, t.startsAt),
    index('idx_customer_memberships_expiry').on(t.tenantId, t.status, t.expiresAt),
    index('idx_customer_memberships_plan').on(t.tenantId, t.planId),
  ],
)

// ── booking cancellation settings (migration 0047) ───────────────────────────
// The per-tenant self-service cancellation rule, read by the customer portal.
// tenant_id IS the primary key, so there is exactly one row per tenant by
// construction — the same shape loyalty_settings and payment_settings use.
// A tenant with no row falls back to the defaults encoded here.
export const bookingCancellationSettings = pgTable('booking_cancellation_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  customerCancellationEnabled: boolean('customer_cancellation_enabled').notNull().default(true),
  /** Hours before the start time after which self-service cancellation closes. */
  cutoffHours: integer('cutoff_hours').notNull().default(24),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── loyalty tiers (migration 0049) ───────────────────────────────────────────
// The per-tenant tier ladder. A tier is DERIVED from the ledger on read — there
// is no tier column on customers and no cached points total anywhere. Thresholds
// are compared against LIFETIME POINTS EARNED, not the spendable balance; see
// lib/loyalty/tiers.ts for why those differ.
export const loyaltyTiers = pgTable(
  'loyalty_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Lifetime points earned at or above which this tier is held. */
    threshold: integer('threshold').notNull(),
    /** Display only — this ticket carries no benefit LOGIC. */
    perk: text('perk'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Makes "the highest qualifying tier" a single unambiguous answer.
    unique('loyalty_tiers_tenant_threshold_key').on(t.tenantId, t.threshold),
    unique('loyalty_tiers_tenant_name_key').on(t.tenantId, t.name),
    index('idx_loyalty_tiers_tenant').on(t.tenantId, t.threshold),
  ],
)

// ── loyalty settings (migration 0029) ───────────────────────────────────────────────────────────────────────────────
// The per-tenant earn/redeem rule. The LEDGER (loyaltyTransactions, 0007) stays
// the source of truth for the balance; this only says how points are earned and
// what they are worth. Defaults encode "1 point per ₹100" and "1 point = ₹1".
export const loyaltySettings = pgTable('loyalty_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  pointsPerUnit: integer('points_per_unit').notNull().default(1),
  unitAmount: numeric('unit_amount', { precision: 10, scale: 2 }).notNull().default('100.00'),
  pointValue: numeric('point_value', { precision: 10, scale: 2 }).notNull().default('1.00'),
  minRedeemPoints: integer('min_redeem_points').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── order settings (migration 0057) ──────────────────────────────────────────
// Singleton per tenant, same shape as loyaltySettings above. Off by default —
// a venue must opt in to skipping the accept/reject step for an online order.
export const orderSettings = pgTable('order_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  autoAcceptOnlineOrders: boolean('auto_accept_online_orders').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── payment settings (migration 0022) ────────────────────────────────────────
// Per-tenant Razorpay credentials. `razorpayKeyId` is publishable (Checkout
// needs it in the browser); `razorpayKeySecretEncrypted` holds AES-256-GCM
// ciphertext from lib/security/encryption.ts and must NEVER be selected into
// anything client-facing. Read it only through
// lib/settings/razorpay-credentials.ts, which decrypts server-side.
export const paymentSettings = pgTable('payment_settings', {
  // tenant_id IS the primary key: exactly one row per tenant.
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  razorpayKeyId: text('razorpay_key_id'),
  razorpayKeySecretEncrypted: text('razorpay_key_secret_encrypted'),
  /**
   * The WEBHOOK signing secret (migration 0024) — a separate Razorpay
   * credential from the API key secret above, with its own rotation. Same
   * AES-256-GCM storage contract; never selected into anything client-facing.
   */
  razorpayWebhookSecretEncrypted: text('razorpay_webhook_secret_encrypted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── membership plans (migration 0021) ────────────────────────────────────────
// The CUSTOMER-facing product catalogue (Gold, Silver, …). Not to be confused
// with `memberships` above, which is a staff member's seat in a tenant.
// Benefits are structured columns so billing (AROS-61) can read them directly
// rather than parsing a JSON blob or a display string.
export const membershipPlans = pgTable(
  'membership_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    durationMonths: integer('duration_months').notNull(),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    freeHours: numeric('free_hours', { precision: 10, scale: 2 }).notNull().default('0'),
    walletCredit: numeric('wallet_credit', { precision: 10, scale: 2 }).notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite (tenant_id, plan_id) FK customer_memberships will carry.
    unique('membership_plans_tenant_id_key').on(t.tenantId, t.id),
    // One LIVE plan per name per tenant; retired plans keep their name for history.
    uniqueIndex('idx_membership_plans_active_name')
      .on(t.tenantId, sql`lower(btrim(${t.name}))`)
      .where(sql`${t.isActive}`),
    index('idx_membership_plans_tenant').on(t.tenantId, t.isActive),
  ],
)

// ── billing module (migration 0010) ──────────────────────────────────────────
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'paid', 'void'])
export const paymentMethod = pgEnum('payment_method', ['cash', 'card', 'upi', 'online', 'wallet'])
export const paymentStatus = pgEnum('payment_status', ['pending', 'captured', 'failed', 'refunded'])

/**
 * One line of `invoices.tax_breakup` — the per-rate GST split that adds up to
 * `tax_total`. Intra-state sales carry cgst+sgst; inter-state carry igst.
 * Amounts are strings for the same reason numeric columns are: no float money.
 *
 * `taxable` is optional: priceBill() (lib/billing/pricing.ts) returns the tax
 * split per rate but not the discounted taxable value behind each rate, and the
 * billing path must never recompute money it did not get from priceBill. When
 * per-rate taxable value is needed on the printed invoice, widen PricingResult
 * to carry it rather than deriving it at the write site.
 */
export type TaxBreakupLine = {
  rate: number
  taxable?: string
  cgst?: string
  sgst?: string
  igst?: string
}

// Money is snapshotted here and never recomputed from live prices. The
// booking/customer links are composite (tenant_id, …) FKs so a row can never
// point at another tenant's record — FKs are not subject to RLS.
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    invoiceNumber: text('invoice_number').notNull(),
    // Nullable: a counter sale has no booking, and an invoice outlives the
    // booking/customer it was raised for (both FKs are ON DELETE SET NULL).
    bookingId: uuid('booking_id'),
    customerId: uuid('customer_id'),
    subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull().default('0'),
    discount: numeric('discount', { precision: 10, scale: 2 }).notNull().default('0'),
    // Composite FK onto promo_codes (migration 0011) — see below.
    promoCodeId: uuid('promo_code_id'),
    /**
     * The membership benefit actually applied (migration 0027). A SNAPSHOT:
     * never recomputed, so the bill stays explicable after the membership
     * expires or the plan is repriced. `membershipDiscount` is one component
     * of `discount` above, never an extra amount alongside it.
     */
    customerMembershipId: uuid('customer_membership_id'),
    membershipDiscount: numeric('membership_discount', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    membershipDiscountPercent: numeric('membership_discount_percent', {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default('0'),
    membershipPlanName: text('membership_plan_name'),
    /**
     * The loyalty half of `discount` (migration 0029), frozen at issue —
     * including the rate honoured, so a reprint never consults today's
     * loyalty_settings. `loyaltyPointsEarned` is filled when the invoice
     * settles.
     */
    loyaltyPointsRedeemed: integer('loyalty_points_redeemed').notNull().default(0),
    loyaltyDiscount: numeric('loyalty_discount', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    loyaltyPointValue: numeric('loyalty_point_value', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    loyaltyPointsEarned: integer('loyalty_points_earned').notNull().default(0),

    /**

     * Cumulative "already undone" counters (migration 0030). A refund

     * reversal writes only the DELTA against these, so reconciliation is

     * idempotent and many partial refunds sum correctly.

     */

    loyaltyPointsReversed: integer('loyalty_points_reversed').notNull().default(0),

    walletCreditReversed: numeric('wallet_credit_reversed', { precision: 10, scale: 2 })
      .notNull()

      .default('0'),
    taxTotal: numeric('tax_total', { precision: 10, scale: 2 }).notNull().default('0'),
    taxBreakup: jsonb('tax_breakup').$type<TaxBreakupLine[]>().notNull().default([]),
    total: numeric('total', { precision: 10, scale: 2 }).notNull().default('0'),
    status: invoiceStatus('status').notNull().default('draft'),
    placeOfSupply: text('place_of_supply'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoices_tenant_number_key').on(t.tenantId, t.invoiceNumber),
    // Target of the composite FKs on invoice_items and payments.
    unique('invoices_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'invoices_booking_tenant_fkey',
      columns: [t.tenantId, t.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }),
    foreignKey({
      name: 'invoices_customer_tenant_fkey',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    // Composite so an invoice can never cite another tenant's promo (0011).
    foreignKey({
      name: 'invoices_promo_fk',
      columns: [t.tenantId, t.promoCodeId],
      foreignColumns: [promoCodes.tenantId, promoCodes.id],
    }),
    index('idx_invoices_branch').on(t.tenantId, t.branchId),
  ],
)

// Every column is a snapshot. `sourceId` is a soft pointer at whatever produced
// the line (booking slot, order item, membership) — deliberately no FK, so the
// line survives that row's deletion.
export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').notNull(),
    // Mirrors invoice_items_kind_check. 'wallet_topup' (migration 0028) is money
    // received in ADVANCE, not revenue — kept distinct so reporting can exclude
    // it from sales.
    kind: text('kind')
      .$type<'booking' | 'food' | 'membership' | 'adjustment' | 'wallet_topup'>()
      .notNull(),
    sourceId: uuid('source_id'),
    description: text('description').notNull(),
    qty: numeric('qty', { precision: 10, scale: 2 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull().default('0'),
    // A percentage, not money — hence numeric(5,2), matching tax_rates.percent.
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 10, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'invoice_items_invoice_tenant_fkey',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('cascade'),
    index('idx_invoice_items_invoice').on(t.invoiceId),
  ],
)

// One row per TENDER — a bill settled part-cash part-UPI is two rows against the
// same invoice (split payments). `amount > 0` is a CHECK in the migration.
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').notNull(),
    method: paymentMethod('method').notNull(),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    gateway: text('gateway'),
    gatewayOrderId: text('gateway_order_id'),
    gatewayPaymentId: text('gateway_payment_id'),
    gatewaySignature: text('gateway_signature'),
    collectedBy: uuid('collected_by').references(() => memberships.id, { onDelete: 'set null' }),

    /**

     * Client-supplied retry token (migration 0030). A double-clicked or

     * retried submission carries the SAME key, so the second attempt

     * recognises itself and returns the first result instead of taking the

     * money again. Null on gateway paths, which are already idempotent

     * through gateway_payment_id.

     */

    idempotencyKey: text('idempotency_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },

  (t) => [
    // Target of the composite FK on refunds.

    unique('payments_tenant_id_key').on(t.tenantId, t.id),

    uniqueIndex('idx_payments_idempotency')
      .on(t.tenantId, t.idempotencyKey)

      .where(sql`${t.idempotencyKey} is not null`),
    foreignKey({
      name: 'payments_invoice_tenant_fkey',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('cascade'),
    index('idx_payments_invoice').on(t.invoiceId),
    // AROS-51: one Razorpay payment may appear on at most one payments row, so
    // a deposit cannot be carried onto an invoice twice — by the webhook and by
    // invoice creation racing each other.
    uniqueIndex('idx_payments_gateway_payment')
      .on(t.gateway, t.gatewayPaymentId)
      .where(sql`${t.gatewayPaymentId} is not null`),
    index('idx_payments_tenant_gateway_payment')
      .on(t.tenantId, t.gatewayPaymentId)
      .where(sql`${t.gatewayPaymentId} is not null`),
  ],
)

// Append-only, owner/manager only — `arena_app` is granted select+insert alone,
// so there is no path that updates or deletes a refund record.
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').notNull(),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'refunds_payment_tenant_fkey',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }).onDelete('cascade'),
    index('idx_refunds_payment').on(t.paymentId),
  ],
)

// The counter behind booking/invoice/KOT numbers. `period` scopes the run
// ('2026', '20260807', or '-' for never-resetting); an upsert on the primary key
// is what makes the increment atomic and the numbering gap-free per scope.
export const sequences = pgTable(
  'sequences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'booking' | 'invoice' | 'kot' | 'order'>().notNull(),
    period: text('period').notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'sequences_pkey', columns: [t.tenantId, t.kind, t.period] })],
)

// Append-only trail of sensitive actions (refunds, voids, role changes). Only
// select + insert policies exist, and only those two are granted.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Nullable so the entry survives the staff member leaving.
    actorMembershipId: uuid('actor_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_audit_log_tenant_created').on(t.tenantId, t.createdAt)],
)

// ── reporting (migration 0043) ───────────────────────────────────────────────
// The ONLY reporting object the app may read. `.existing()` because the view is
// authored in SQL — it carries a security_barrier and an auth_tenant_ids()
// predicate that Drizzle cannot express, exactly like the RLS policies on every
// table above; this declaration exists purely so report queries are typed.
//
// The materialized view behind it (public.mv_daily_revenue) is deliberately
// ABSENT from this file: arena_app has no SELECT on it, so any query Drizzle
// could build against it would fail. Read 0043_reporting.sql before changing
// either one.
//
// `day` is a plain date (mode 'string' → 'YYYY-MM-DD'), already resolved to the
// branch's local calendar day by the aggregate, so a report filters it as a
// date with no timezone conversion. The money columns are numeric and arrive as
// strings, like every other numeric in this schema.
export const vDailyRevenue = pgView('v_daily_revenue', {
  tenantId: uuid('tenant_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  day: date('day').notNull(),
  gross: numeric('gross', { precision: 14, scale: 2 }).notNull(),
  discount: numeric('discount', { precision: 14, scale: 2 }).notNull(),
  tax: numeric('tax', { precision: 14, scale: 2 }).notNull(),
  net: numeric('net', { precision: 14, scale: 2 }).notNull(),
  invoiceCount: integer('invoice_count').notNull(),
}).existing()

// ── report refresh log (migration 0050) ──────────────────────────────────────
// When each reporting materialized view was last rebuilt, so a report can state
// its own age rather than implying freshness it does not have. One global row
// per view — a refresh covers every tenant at once, so there is no tenant_id
// here and deliberately no RLS. Read-only to arena_app; the only writer is the
// SECURITY DEFINER refresh function.
export const reportRefreshLog = pgTable('report_refresh_log', {
  viewName: text('view_name').primaryKey(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── expenses module (migration 0033) ─────────────────────────────────────────
// Settings-shaped catalogues plus the ledger that spends against them, the same
// read-all / manager-write split as the menu tables. `amount` is numeric, so it
// arrives as a STRING like every other money column in this schema.
export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite (tenant_id, category_id) FK expenses carries.
    unique('expense_categories_tenant_id_key').on(t.tenantId, t.id),
    // One LIVE category per name per tenant; retired ones keep theirs for history.
    uniqueIndex('idx_expense_categories_active_name')
      .on(t.tenantId, sql`lower(btrim(${t.name}))`)
      .where(sql`${t.isActive}`),
    index('idx_expense_categories_tenant').on(t.tenantId, t.isActive),
  ],
)

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite (tenant_id, vendor_id) FK expenses carries.
    unique('vendors_tenant_id_key').on(t.tenantId, t.id),
    uniqueIndex('idx_vendors_active_name')
      .on(t.tenantId, sql`lower(btrim(${t.name}))`)
      .where(sql`${t.isActive}`),
    index('idx_vendors_tenant').on(t.tenantId, t.isActive),
  ],
)

/** Only 'monthly' today (AROS-109); an enum so adding 'weekly' is an ALTER TYPE. */
export const expenseCadence = pgEnum('expense_cadence', ['monthly'])

/**
 * Recurring expense templates (migration 0034). A template is not itself an
 * expense — the generation job turns each due period into an ordinary row in
 * `expenses`, tagged with recurringExpenseId + recurrencePeriod.
 */
export const recurringExpenses = pgTable(
  'recurring_expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull(),
    // Nullable for the same reason expenses.vendorId is.
    vendorId: uuid('vendor_id'),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    cadence: expenseCadence('cadence').notNull().default('monthly'),
    dayOfMonth: smallint('day_of_month').notNull(),
    /** Concrete due DATE of the next period, already month-end adjusted. */
    nextRun: date('next_run').notNull(),
    note: text('note'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'recurring_expenses_category_tenant_fkey',
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [expenseCategories.tenantId, expenseCategories.id],
    }),
    foreignKey({
      name: 'recurring_expenses_vendor_tenant_fkey',
      columns: [t.tenantId, t.vendorId],
      foreignColumns: [vendors.tenantId, vendors.id],
    }).onDelete('set null'),
    // Target of the composite (tenant_id, recurring_expense_id) FK on expenses.
    unique('recurring_expenses_tenant_id_key').on(t.tenantId, t.id),
    index('idx_recurring_expenses_due').on(t.nextRun).where(sql`${t.isActive}`),
    index('idx_recurring_expenses_tenant').on(t.tenantId, t.isActive),
  ],
)

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull(),
    // Nullable: rent and salaries have no supplier to name.
    vendorId: uuid('vendor_id'),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    // A plain date, not an instant: the day is the tenant's, not a timezone's.
    spentOn: date('spent_on').notNull(),
    note: text('note'),
    receiptUrl: text('receipt_url'),
    // Provenance (migration 0034). Both null for a hand-entered expense; the
    // paired CHECK in SQL keeps them all-or-nothing.
    recurringExpenseId: uuid('recurring_expense_id'),
    /** The period this row represents, as that period's FIRST day. */
    recurrencePeriod: date('recurrence_period'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite FKs carry tenant_id INSIDE the key, so an expense can never
    // point at another tenant's category or vendor. No delete rule on the
    // category: deleting one that has been spent against must fail loudly.
    foreignKey({
      name: 'expenses_category_tenant_fkey',
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [expenseCategories.tenantId, expenseCategories.id],
    }),
    foreignKey({
      name: 'expenses_vendor_tenant_fkey',
      columns: [t.tenantId, t.vendorId],
      foreignColumns: [vendors.tenantId, vendors.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'expenses_recurring_tenant_fkey',
      columns: [t.tenantId, t.recurringExpenseId],
      foreignColumns: [recurringExpenses.tenantId, recurringExpenses.id],
    }).onDelete('set null'),
    index('idx_expenses_tenant_spent_on').on(t.tenantId, t.spentOn.desc()),
    index('idx_expenses_category').on(t.tenantId, t.categoryId),
    index('idx_expenses_vendor').on(t.tenantId, t.vendorId),
    // THE duplicate guard: one generated expense per (template, period).
    // NULLs are distinct, so manual expenses are unconstrained.
    uniqueIndex('idx_expenses_recurrence_period').on(t.recurringExpenseId, t.recurrencePeriod),
    index('idx_expenses_recurring').on(t.tenantId, t.recurringExpenseId),
  ],
)

export const expenseCategoriesRelations = relations(expenseCategories, ({ one, many }) => ({
  tenant: one(tenants, { fields: [expenseCategories.tenantId], references: [tenants.id] }),
  expenses: many(expenses),
}))

export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  tenant: one(tenants, { fields: [vendors.tenantId], references: [tenants.id] }),
  expenses: many(expenses),
}))

export const recurringExpensesRelations = relations(recurringExpenses, ({ one, many }) => ({
  tenant: one(tenants, { fields: [recurringExpenses.tenantId], references: [tenants.id] }),
  category: one(expenseCategories, {
    fields: [recurringExpenses.tenantId, recurringExpenses.categoryId],
    references: [expenseCategories.tenantId, expenseCategories.id],
  }),
  vendor: one(vendors, {
    fields: [recurringExpenses.tenantId, recurringExpenses.vendorId],
    references: [vendors.tenantId, vendors.id],
  }),
  generated: many(expenses),
}))

export const expensesRelations = relations(expenses, ({ one }) => ({
  tenant: one(tenants, { fields: [expenses.tenantId], references: [tenants.id] }),
  category: one(expenseCategories, {
    fields: [expenses.tenantId, expenses.categoryId],
    references: [expenseCategories.tenantId, expenseCategories.id],
  }),
  vendor: one(vendors, {
    fields: [expenses.tenantId, expenses.vendorId],
    references: [vendors.tenantId, vendors.id],
  }),
}))

// ── billing relations ────────────────────────────────────────────────────────
// Declared for the billing tables only; the `one()` sides carry their own
// fields/references, so no reverse declaration is needed on the older tables.
export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [invoices.tenantId], references: [tenants.id] }),
  branch: one(branches, { fields: [invoices.branchId], references: [branches.id] }),
  booking: one(bookings, {
    fields: [invoices.tenantId, invoices.bookingId],
    references: [bookings.tenantId, bookings.id],
  }),
  customer: one(customers, {
    fields: [invoices.tenantId, invoices.customerId],
    references: [customers.tenantId, customers.id],
  }),
  promo: one(promoCodes, {
    fields: [invoices.tenantId, invoices.promoCodeId],
    references: [promoCodes.tenantId, promoCodes.id],
  }),
  items: many(invoiceItems),
  payments: many(payments),
}))

export const promoCodesRelations = relations(promoCodes, ({ one, many }) => ({
  tenant: one(tenants, { fields: [promoCodes.tenantId], references: [tenants.id] }),
  invoices: many(invoices),
}))

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceItems.tenantId, invoiceItems.invoiceId],
    references: [invoices.tenantId, invoices.id],
  }),
}))

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  invoice: one(invoices, {
    fields: [payments.tenantId, payments.invoiceId],
    references: [invoices.tenantId, invoices.id],
  }),
  branch: one(branches, { fields: [payments.branchId], references: [branches.id] }),
  collectedByMembership: one(memberships, {
    fields: [payments.collectedBy],
    references: [memberships.id],
  }),
  refunds: many(refunds),
}))

export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, {
    fields: [refunds.tenantId, refunds.paymentId],
    references: [payments.tenantId, payments.id],
  }),
  createdByMembership: one(memberships, {
    fields: [refunds.createdBy],
    references: [memberships.id],
  }),
}))

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  tenant: one(tenants, { fields: [auditLog.tenantId], references: [tenants.id] }),
  actor: one(memberships, {
    fields: [auditLog.actorMembershipId],
    references: [memberships.id],
  }),
}))

export const sequencesRelations = relations(sequences, ({ one }) => ({
  tenant: one(tenants, { fields: [sequences.tenantId], references: [tenants.id] }),
}))

// ── website builder (migration 0051, M13/AROS-A) ─────────────────────────────
export const websiteSectionType = pgEnum('website_section_type', [
  'text',
  'image',
  'image_text',
  'video',
  'video_text',
  'resources',
  'menu',
  'hours',
  'map',
  // 'events' (migration 0090) — the M15 upcoming-events section.
  'events',
])

/** Draft content — the future editor (AROS-C/D) mutates these rows directly. */
export const websiteSections = pgTable(
  'website_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: websiteSectionType('type').notNull(),
    heading: text('heading'),
    // Real per-type shape is enforced by zod at the action boundary
    // (lib/website/types.ts), not here — it depends on `type`.
    content: jsonb('content').$type<Record<string, unknown>>().notNull().default({}),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_website_sections_tenant').on(t.tenantId, t.position)],
)

/** Draft branding (logo/accent/hero) — one row per tenant; consumed by AROS-F. */
export const websiteSettings = pgTable('website_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  logoUrl: text('logo_url'),
  accentColor: text('accent_color'),
  heroImageUrl: text('hero_image_url'),
  heroHeading: text('hero_heading'),
  heroSubheading: text('hero_subheading'),
  heroCtaText: text('hero_cta_text'),
  heroCtaUrl: text('hero_cta_url'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Publish state — the only one of the three tables the public homepage ever
 * reads. `publishedSnapshot` is null until the first publish (AROS-E) and is
 * validated app-side (lib/website/types.ts) on every read.
 */
export const websitePages = pgTable('website_pages', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  publishedSnapshot: jsonb('published_snapshot').$type<Record<string, unknown>>(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
})

// ── events (migration 0088) ──────────────────────────────────────────────────
// M15 tournaments & events. One table for all five kinds; `type` carries the
// meaning and `tournamentFormat` is constrained to tournaments in the database.
export const eventType = pgEnum('event_type', ['tournament', 'class', 'meetup', 'watch_party', 'party'])
export const tournamentFormat = pgEnum('tournament_format', [
  'single_elim',
  'double_elim',
  'round_robin',
  'points',
])
// Does one person enter, or one team? (migration 0091) — the question neither
// `type` nor `tournamentFormat` answers.
export const eventRegistrationMode = pgEnum('event_registration_mode', ['solo', 'team'])
export const eventStatus = pgEnum('event_status', [
  'draft',
  'published',
  'registration_open',
  'full',
  'in_progress',
  'completed',
  'cancelled',
])

/** What an event reserves. See migration 0094. */
export const eventResourceScope = pgEnum('event_resource_scope', ['none', 'branch', 'specific'])

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Tenant-safe composite FK in SQL — (tenant_id, branch_id) references
    // branches(tenant_id, id), so an event can never point at another tenant's
    // branch. Drizzle models the column; the constraint lives in 0088.
    branchId: uuid('branch_id').notNull(),
    title: text('title').notNull(),
    type: eventType('type').notNull(),
    description: text('description'),
    // Public URL from lib/storage/s3.ts uploadImage().
    bannerUrl: text('banner_url'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    // NULL = unlimited.
    capacity: integer('capacity'),
    entryFee: numeric('entry_fee', { precision: 10, scale: 2 }).notNull().default('0'),
    tournamentFormat: tournamentFormat('tournament_format'),
    // Solo vs team entry (migration 0091). `teamSize` is players per team and
    // is NULL exactly when the mode is 'solo' — the events_team_size CHECK.
    registrationMode: eventRegistrationMode('registration_mode').notNull().default('solo'),
    teamSize: integer('team_size'),
    status: eventStatus('status').notNull().default('draft'),
    /**
     * What the event reserves (M15 #4, migration 0094). 'none' by default, so
     * every event written before 0094 keeps behaving exactly as it did.
     * 'branch' blocks every bookable resource in the branch; 'specific' blocks
     * the stations listed in `eventResources`.
     */
    resourceScope: eventResourceScope('resource_scope').notNull().default('none'),
    /**
     * Which recurring series produced this occurrence, and for which LOCAL date
     * (M15 #8, migration 0100). Both null for a hand-created event. The unique
     * index on the pair is what makes generation idempotent.
     */
    seriesId: uuid('series_id'),
    occurrencePeriod: date('occurrence_period'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_events_tenant_starts').on(t.tenantId, t.startsAt),
    index('idx_events_branch').on(t.branchId),
  ],
)

// ── recurring event series (migration 0100, M15 #8) ─────────────────────────
// A TEMPLATE. scripts/run-recurring-events.ts copies its snapshot fields onto
// ordinary `events` rows, so a generated occurrence works with registration,
// check-in, resource blocking, brackets and the public pages with no special
// case anywhere. Editing a series never alters an occurrence already generated.
export const eventCadence = pgEnum('event_cadence', ['weekly', 'monthly'])

export const eventSeries = pgTable(
  'event_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Tenant-safe composite FK to branches(tenant_id, id) lives in 0100.
    branchId: uuid('branch_id').notNull(),
    cadence: eventCadence('cadence').notNull(),
    /** 0 = Sunday … 6 = Saturday, matching EXTRACT(dow). Null for monthly. */
    weekday: integer('weekday'),
    /** 1–31, clamped to the month's last day by the job. Null for weekly. */
    dayOfMonth: integer('day_of_month'),
    /** Local wall-clock start in the TENANT's timezone — survives DST. */
    startTime: time('start_time').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    nextRun: date('next_run').notNull(),
    /** Generation stops after this local date. Null = indefinite. */
    untilDate: date('until_date'),
    isActive: boolean('is_active').notNull().default(true),
    // ── the snapshot copied onto each occurrence ──────────────────────────
    title: text('title').notNull(),
    type: eventType('type').notNull(),
    description: text('description'),
    bannerUrl: text('banner_url'),
    capacity: integer('capacity'),
    entryFee: numeric('entry_fee', { precision: 10, scale: 2 }).notNull().default('0'),
    tournamentFormat: tournamentFormat('tournament_format'),
    registrationMode: eventRegistrationMode('registration_mode').notNull().default('solo'),
    teamSize: integer('team_size'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('event_series_tenant_id_key').on(t.tenantId, t.id),
    index('idx_event_series_tenant').on(t.tenantId, t.createdAt.desc()),
  ],
)

// ── event matches (migration 0098, M15 #6) ──────────────────────────────────
// The bracket ENGINE is pure TypeScript in lib/events/bracket.ts; this is only
// where its output lives. Participants are event_registrations ids — the same
// identity the check-in list returns — so a team match and a solo match have
// the same shape and no participant data is duplicated here.
export const eventMatchSide = pgEnum('event_match_side', [
  'winners',
  'losers',
  'final',
  'round_robin',
  'points',
])

export const eventMatchStatus = pgEnum('event_match_status', [
  'pending',
  'ready',
  'completed',
  'bye',
  'void',
])

export const eventMatches = pgTable(
  'event_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Composite FKs to (tenant_id, id) on events / event_registrations live in
    // 0098 — Drizzle models the columns, the database makes cross-tenant
    // impossible.
    eventId: uuid('event_id').notNull(),
    side: eventMatchSide('side').notNull(),
    round: integer('round').notNull(),
    position: integer('position').notNull(),
    participantA: uuid('participant_a'),
    participantB: uuid('participant_b'),
    status: eventMatchStatus('status').notNull().default('pending'),
    scoreA: integer('score_a'),
    scoreB: integer('score_b'),
    winner: uuid('winner'),
    /**
     * The topology, written once at generation. Advancement FOLLOWS these
     * pointers rather than recomputing bracket maths at result time, so a
     * winner cannot land in the wrong slot.
     */
    winnerNextMatchId: uuid('winner_next_match_id'),
    winnerNextSlot: text('winner_next_slot'),
    /** Non-null only in double elimination (and the grand final → reset). */
    loserNextMatchId: uuid('loser_next_match_id'),
    loserNextSlot: text('loser_next_slot'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('event_matches_tenant_id_key').on(t.tenantId, t.id),
    // ONE match per coordinate — the database half of idempotent generation.
    unique('event_matches_coordinate_key').on(t.eventId, t.side, t.round, t.position),
    index('idx_event_matches_event').on(t.eventId, t.side, t.round, t.position),
    index('idx_event_matches_tenant').on(t.tenantId),
  ],
)

// ── event resource selection (migration 0094, M15 #4) ───────────────────────
// WHICH stations a 'specific'-scope event claims. This is the SELECTION, not
// the reservation: the reservation lives in `bookingSlots` rows carrying
// `eventId`, and only exists while the event status blocks. Keeping them apart
// is what lets a DRAFT event have a chosen line-up and reserve nothing.
export const eventResources = pgTable(
  'event_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Composite FKs to (tenant_id, id) on events / resources live in 0094 —
    // Drizzle models the columns, the database makes cross-tenant impossible.
    eventId: uuid('event_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('event_resources_event_id_resource_id_key').on(t.eventId, t.resourceId),
    index('idx_event_resources_event').on(t.eventId),
    index('idx_event_resources_resource').on(t.tenantId, t.resourceId),
  ],
)

// ── event registrations, teams (migration 0091, M15 #3) ──────────────────────
// Capacity counts REGISTRATIONS: one entry per person for a solo event, one
// entry per TEAM for a team event. See the migration header for why, and for
// why every customer write goes through the SECURITY DEFINER functions rather
// than through a row policy — the rule is a table-level count under a lock,
// which no WITH CHECK can express.
export const eventRegistrationStatus = pgEnum('event_registration_status', [
  // Holds a place while the entrant pays; expires and releases it.
  'pending_payment',
  'registered',
  // Holds nothing, is never charged.
  'waitlisted',
  'cancelled',
  'checked_in',
])

export const eventTeamStatus = pgEnum('event_team_status', ['active', 'withdrawn'])

export const eventTeams = pgTable(
  'event_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Composite FKs to (tenant_id, id) on events / customers live in 0091 —
    // Drizzle models the columns, the database makes cross-tenant impossible.
    eventId: uuid('event_id').notNull(),
    name: text('name').notNull(),
    captainCustomerId: uuid('captain_customer_id').notNull(),
    status: eventTeamStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('event_teams_tenant_id_key').on(t.tenantId, t.id),
    // The target event_team_members FKs onto, so a member's team and a member's
    // event are provably the same event.
    unique('event_teams_event_id_key').on(t.tenantId, t.eventId, t.id),
    foreignKey({
      name: 'event_teams_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'event_teams_captain_fk',
      columns: [t.tenantId, t.captainCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('restrict'),
    index('idx_event_teams_event').on(t.tenantId, t.eventId),
  ],
)

export const eventTeamMembers = pgTable(
  'event_team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Carried here as well as on the team: it is what the three-column FK below
    // needs, and what makes "one team per event per customer" expressible.
    eventId: uuid('event_id').notNull(),
    teamId: uuid('team_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    isCaptain: boolean('is_captain').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'event_team_members_team_fk',
      columns: [t.tenantId, t.eventId, t.teamId],
      foreignColumns: [eventTeams.tenantId, eventTeams.eventId, eventTeams.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'event_team_members_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    uniqueIndex('idx_event_team_members_unique').on(t.teamId, t.customerId),
    uniqueIndex('idx_event_team_members_one_per_event').on(t.tenantId, t.eventId, t.customerId),
    uniqueIndex('idx_event_team_members_captain').on(t.teamId).where(sql`${t.isCaptain}`),
    index('idx_event_team_members_customer').on(t.tenantId, t.customerId),
  ],
)

export const eventRegistrations = pgTable(
  'event_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    /** The M9 customer. There is no second registrant identity. */
    customerId: uuid('customer_id').notNull(),
    /** NULL for a solo entry; the team this entry IS, for a team event. */
    teamId: uuid('team_id'),
    status: eventRegistrationStatus('status').notNull(),
    /** Money RECEIVED, not money owed. The fee owed is always events.entryFee. */
    paidAmount: numeric('paid_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    /** Razorpay `pay_…`, written only by the verified-webhook path. */
    paymentReference: text('payment_reference'),
    /** The capacity hold; set exactly while status is 'pending_payment'. */
    paymentHoldExpiresAt: timestamp('payment_hold_expires_at', { withTimezone: true }),
    /** Money arrived, place could not be honoured. Twin of bookings.depositReviewRequired. */
    refundRequired: boolean('refund_required').notNull().default(false),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    waitlistedAt: timestamp('waitlisted_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    /**
     * Unguessable bearer credential for day-of QR check-in (M15 #5, migration
     * 0095). Same pattern as bookings.confirmationToken (0026): a v4 uuid,
     * never derived from any id, resolved only as (tenantId, checkInToken)
     * under a staff session. The QR encodes this and nothing else.
     */
    checkInToken: uuid('check_in_token').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('event_registrations_tenant_id_key').on(t.tenantId, t.id),
    unique('event_registrations_tenant_token_key').on(t.tenantId, t.checkInToken),
    foreignKey({
      name: 'event_registrations_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'event_registrations_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'event_registrations_team_fk',
      columns: [t.tenantId, t.eventId, t.teamId],
      foreignColumns: [eventTeams.tenantId, eventTeams.eventId, eventTeams.id],
    }).onDelete('cascade'),
    // THE duplicate-registration rule: at most one LIVE entry per customer per
    // event. Partial, so a cancelled entry does not block re-registering.
    uniqueIndex('idx_event_registrations_active')
      .on(t.tenantId, t.eventId, t.customerId)
      .where(sql`${t.status} in ('pending_payment','registered','waitlisted','checked_in')`),
    index('idx_event_registrations_event_status').on(t.eventId, t.status),
    index('idx_event_registrations_waitlist')
      .on(t.eventId, t.createdAt, t.id)
      .where(sql`${t.status} = 'waitlisted'`),
    index('idx_event_registrations_customer').on(t.tenantId, t.customerId, t.createdAt),
  ],
)

export const eventTeamsRelations = relations(eventTeams, ({ one, many }) => ({
  tenant: one(tenants, { fields: [eventTeams.tenantId], references: [tenants.id] }),
  event: one(events, { fields: [eventTeams.eventId], references: [events.id] }),
  members: many(eventTeamMembers),
}))

export const eventTeamMembersRelations = relations(eventTeamMembers, ({ one }) => ({
  team: one(eventTeams, { fields: [eventTeamMembers.teamId], references: [eventTeams.id] }),
  customer: one(customers, { fields: [eventTeamMembers.customerId], references: [customers.id] }),
}))

export const eventRegistrationsRelations = relations(eventRegistrations, ({ one }) => ({
  tenant: one(tenants, { fields: [eventRegistrations.tenantId], references: [tenants.id] }),
  event: one(events, { fields: [eventRegistrations.eventId], references: [events.id] }),
  customer: one(customers, { fields: [eventRegistrations.customerId], references: [customers.id] }),
  team: one(eventTeams, { fields: [eventRegistrations.teamId], references: [eventTeams.id] }),
}))
