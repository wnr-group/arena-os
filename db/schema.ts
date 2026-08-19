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
export const tenantStatus = pgEnum('tenant_status', [
  'trial',
  'active',
  'suspended',
  'cancelled',
])
export const tenantIndustry = pgEnum('tenant_industry', [
  'gaming_cafe',
  'recording_studio',
  'podcast_studio',
  'dance_studio',
  'vr_centre',
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
  (t) => [unique('branches_tenant_name_key').on(t.tenantId, t.name), index('idx_branches_tenant').on(t.tenantId)],
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
export const resourceStatus = pgEnum('resource_status', [
  'available',
  'maintenance',
  'inactive',
])
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('resources_tenant_name_key').on(t.tenantId, t.name),
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
    // … and the directory entry it belongs to (migration 0015). Nullable: a
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
  },
  (t) => [
    unique('bookings_tenant_number_key').on(t.tenantId, t.bookingNumber),
    unique('bookings_tenant_token_key').on(t.tenantId, t.confirmationToken),
    // Target of the composite (tenant_id, booking_id) FK on invoices (0010).
    unique('bookings_tenant_id_key').on(t.tenantId, t.id),
    index('idx_bookings_branch').on(t.tenantId, t.branchId),
    index('idx_bookings_status').on(t.tenantId, t.status),
    index('idx_bookings_customer').on(t.tenantId, t.customerId),
  ],
)

export const bookingSlots = pgTable(
  'booking_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
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
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('orders_tenant_number_key').on(t.tenantId, t.orderNumber),
    index('idx_orders_branch').on(t.tenantId, t.branchId),
    index('idx_orders_booking').on(t.bookingId),
  ],
)

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
  },
  (t) => [index('idx_order_items_order').on(t.orderId)],
)

// ── kots (migration 0013) ────────────────────────────────────────────────────
export const kotStatus = pgEnum('kot_status', ['pending', 'preparing', 'ready', 'served', 'cancelled'])

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

// ── customer module (migration 0014) ─────────────────────────────────────────
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
  (t) => [index('idx_loyalty_tx_customer').on(t.customerId)],
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

// ── billing module (migration 0010) ──────────────────────────────────────────
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'paid', 'void'])
export const paymentMethod = pgEnum('payment_method', [
  'cash',
  'card',
  'upi',
  'online',
  'wallet',
])
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'captured',
  'failed',
  'refunded',
])

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
    kind: text('kind').$type<'booking' | 'food' | 'membership' | 'adjustment'>().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite FK on refunds.
    unique('payments_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'payments_invoice_tenant_fkey',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('cascade'),
    index('idx_payments_invoice').on(t.invoiceId),
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
    kind: text('kind').$type<'booking' | 'invoice' | 'kot'>().notNull(),
    period: text('period').notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'sequences_pkey', columns: [t.tenantId, t.kind, t.period] }),
  ],
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
