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
