/**
 * Drizzle schema — the TypeScript source of truth for typed queries.
 *
 * The DATABASE structure (including RLS policies, helper functions, roles and
 * grants that Drizzle cannot express) is authored as SQL in db/migrations. Keep
 * the table/column shapes here in sync with those migrations.
 */
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
  unique,
  index,
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
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
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
    index('idx_bookings_branch').on(t.tenantId, t.branchId),
    index('idx_bookings_status').on(t.tenantId, t.status),
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
