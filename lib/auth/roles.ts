/**
 * Role model mirrored from the SQL enum public.member_role.
 * Keep this list in sync with migrations.
 */
export type MemberRole =
  | 'owner'
  | 'manager'
  | 'cashier'
  | 'kitchen_staff'
  | 'floor_staff'
  | 'receptionist'

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  kitchen_staff: 'Kitchen Staff',
  floor_staff: 'Floor Staff',
  receptionist: 'Receptionist',
}

export const MANAGER_ROLES: MemberRole[] = ['owner', 'manager']

export function isManager(role: MemberRole | null | undefined): boolean {
  return role === 'owner' || role === 'manager'
}

/** Strictly the owner. Used for the business's legal identity (migration 0012). */
export function isOwner(role: MemberRole | null | undefined): boolean {
  return role === 'owner'
}

/**
 * Roles that may view and edit the customer directory, per the permissions.
 */
export const CUSTOMER_ROLES: MemberRole[] = [
  'owner',
  'manager',
  'cashier',
  'receptionist',
  'floor_staff',
]

export function canViewCustomers(role: MemberRole | null | undefined): boolean {
  return !!role && CUSTOMER_ROLES.includes(role)
}

/**
 * Roles that may raise a bill — "cashier and up". Kitchen, floor and reception
 * staff work bookings and orders but never issue a GST invoice.
 *
 * ONE deliberate exception: walk-in checkout (M21 #7, product-owner
 * confirmed) lets on-shift floor staff/receptionist close out a walk-in they
 * started or extended themselves, even though that raises a real invoice —
 * see checkoutWalkin's own doc comment (lib/actions/bookings.ts) for why.
 * Every OTHER billing entry point (createInvoiceForBooking, payments,
 * memberships, …) still gates on canBill with no exception.
 */
export const BILLING_ROLES: MemberRole[] = ['owner', 'manager', 'cashier']

export function canBill(role: MemberRole | null | undefined): boolean {
  return !!role && BILLING_ROLES.includes(role)
}

/**
 * Roles that may advance a kitchen ticket's status — kitchen staff and up.
 * Matches the kots_update RLS policy (migration 0013).
 */
export const KITCHEN_ROLES: MemberRole[] = ['owner', 'manager', 'kitchen_staff']

export function canManageKitchen(role: MemberRole | null | undefined): boolean {
  return !!role && KITCHEN_ROLES.includes(role)
}

/**
 * Roles that may see and act on the incoming online-order queue (accept /
 * reject) — front-of-house roles, not kitchen staff: an online order isn't
 * kitchen business until it's been accepted, at which point it's just a KOT
 * like any other and kitchen_staff handles it on /kitchen as usual.
 */
export const INCOMING_ORDER_ROLES: MemberRole[] = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff']

export function canManageIncomingOrders(role: MemberRole | null | undefined): boolean {
  return !!role && INCOMING_ORDER_ROLES.includes(role)
}

/**
 * Roles that may start, extend, AND check out a walk-in session (M21, #7) —
 * the same front-of-house set as INCOMING_ORDER_ROLES: kitchen staff never
 * runs the front desk, so they never see or start a walk-in either.
 *
 * Checkout raises a real GST invoice, which is otherwise cashier-and-up only
 * (see BILLING_ROLES) — including receptionist/floor_staff here for that
 * action too is a deliberate, product-owner-confirmed exception, not an
 * oversight. See checkoutWalkin's own doc comment (lib/actions/bookings.ts).
 */
export const WALKIN_ROLES: MemberRole[] = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff']

export function canManageWalkins(role: MemberRole | null | undefined): boolean {
  return !!role && WALKIN_ROLES.includes(role)
}
