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
 * ONE deliberate exception, applied via canBillBooking() below, not here:
 * raising the bill for a WALK-IN booking is also open to on-shift floor
 * staff/receptionist (M21 #7, product-owner confirmed), so they can close
 * out and bill a walk-in they started or extended themselves without a
 * cashier handoff. Every OTHER billing entry point — every RESERVED
 * booking, payments, memberships, split bills, comps — still gates on plain
 * canBill with no exception. checkoutWalkin itself (lib/actions/bookings.ts)
 * no longer raises the invoice at all; it only closes the session out
 * (prices it, freezes the slot) and hands off to the bill screen, same as a
 * reserved booking — see canBillBooking's own doc comment for how the
 * exception now applies there instead.
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
 * Checking out only closes the session (prices it, freezes the slot) — it no
 * longer raises the invoice by itself, see canBillBooking below for the
 * (still deliberate, product-owner-confirmed) exception that lets this same
 * set of roles also raise the bill for a walk-in, without a cashier handoff.
 */
export const WALKIN_ROLES: MemberRole[] = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff']

export function canManageWalkins(role: MemberRole | null | undefined): boolean {
  return !!role && WALKIN_ROLES.includes(role)
}

/**
 * Whether `role` may raise the bill for a booking on `channel` — plain
 * canBill (owner/manager/cashier) for a RESERVED booking, same as always,
 * but ALSO canManageWalkins (+ receptionist/floor_staff) for a WALK-IN.
 *
 * M21 #7's "close the tab yourself, no cashier handoff" carve-out used to
 * live entirely inside checkoutWalkin, which raised the invoice itself under
 * canManageWalkins. Now that walk-in checkout only closes the session and
 * hands off to the same POS bill screen a reserved booking uses (so staff
 * get the same review-amount/discount/promo step before the invoice is
 * raised, instead of it happening silently), that screen's OWN billing
 * actions (createInvoiceForBooking, previewPromoCodeForBooking — both in
 * lib/actions/billing.ts) need to keep honouring the exception for a
 * walk-in, while every RESERVED booking on that same screen still requires
 * plain canBill. `channel` must come from a trusted, server-side read of the
 * booking row (bookings.channel) — never from the client — exactly like
 * every other input these actions never trust the browser for.
 */
export function canBillBooking(role: MemberRole | null | undefined, channel: string): boolean {
  if (canBill(role)) return true
  return channel === 'walkin' && canManageWalkins(role)
}
