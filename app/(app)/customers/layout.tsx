import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { canViewCustomers } from '@/lib/auth/roles'

/**
 * Role guard for the whole /customers segment
 */
export default async function CustomersLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getActiveContext()
  if (ctx && !canViewCustomers(ctx.role)) redirect('/dashboard')
  return <>{children}</>
}
