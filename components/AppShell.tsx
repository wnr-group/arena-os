'use client'

import { useEffect, useState } from 'react'
import { LogOut, Menu, X, PanelRightOpen, PanelRightClose } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TopBarActions } from '@/components/TopBarActions'
import type { MemberRole } from '@/lib/auth/roles'
import { cn } from '@/lib/utils/cn'

const STORAGE_KEY = 'arena-os:sidebar-collapsed'

function initialsOf(name: string) {
  return (
    name
      .split(' ')
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'A'
  )
}

/** The tenant's mark in the sidebar header: their uploaded website logo
 *  (Settings → Website → Branding) when there is one, else the same
 *  initials badge this always showed — same size/shape either way so
 *  neither swap reflows the header. */
function TenantMark({ tenantName, logoUrl, gradient }: { tenantName: string; logoUrl: string | null; gradient?: boolean }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={tenantName}
        className="size-9 shrink-0 rounded-xl bg-accent object-contain shadow-md shadow-primary/20"
      />
    )
  }
  return (
    <div
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-primary-foreground shadow-md shadow-primary/20',
        gradient ? 'bg-gradient-to-tr from-primary to-primary-hover' : 'bg-primary',
      )}
    >
      {initialsOf(tenantName)}
    </div>
  )
}

/** Dashboard shell: sidebar nav, top bar and content frame shared across every authenticated tenant page. */
export function AppShell({
  industryLabel,
  industry,
  tenantName,
  logoUrl,
  role,
  userFullName,
  userEmail,
  roleLabel,
  signOutAction,
  walkinsEnabled,
  branchId,
  children,
}: {
  industryLabel: string
  industry: string
  tenantName: string
  /** The tenant's website logo, straight off the draft (Settings → Website →
   *  Branding) — shows the moment it's uploaded, with no separate Publish
   *  step required. Null when nothing's been uploaded yet, which falls back
   *  to the initials badge below. */
  logoUrl: string | null
  role: MemberRole
  userFullName: string | null
  userEmail: string
  roleLabel: string
  signOutAction: () => void | Promise<void>
  /** Gates the global time's-up alarm in the top bar — same rule as the
   *  Sessions nav entry (see Sidebar.tsx): non-restaurant + canManageWalkins. */
  walkinsEnabled: boolean
  /** The tenant's primary branch, for the alarm poll. Null when walkinsEnabled
   *  is false or no primary branch is configured yet. */
  branchId: string | null
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    if (window.localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true)
  }, [])

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground transition-colors duration-200">
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          'no-print relative hidden min-h-0 shrink-0 flex-col border-r border-border bg-accent backdrop-blur-md transition-all duration-300 ease-in-out sm:flex',
          collapsed ? 'w-[76px]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-3 border-b border-border px-5 py-4',
            collapsed && 'justify-center px-3',
          )}
        >
          <TenantMark tenantName={tenantName} logoUrl={logoUrl} />
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                {industryLabel}
              </p>
              <p className="truncate text-sm font-semibold tracking-tight text-primary">{tenantName}</p>
            </div>
          )}
        </div>

        <Sidebar role={role} industry={industry} collapsed={collapsed} />

        <div className={cn('mt-auto border-t border-border p-3 bg-muted/20', collapsed && 'flex flex-col items-center')}>
          {!collapsed && (
            <div className="mb-3 min-w-0 px-2">
              <p className="truncate text-xs font-semibold text-foreground/90">{userEmail}</p>
              <p className="text-[11px] font-medium text-muted-foreground">{roleLabel}</p>
            </div>
          )}
          <form action={signOutAction} className={cn(!collapsed && 'w-full')}>
            <button
              title="Sign out"
              className={cn(
                'flex items-center justify-center gap-2 rounded-lg border border-border bg-background text-sm font-medium text-muted-foreground transition-all hover:bg-muted hover:text-foreground hover:shadow-sm',
                collapsed ? 'size-9' : 'w-full px-3 py-2',
              )}
            >
              <LogOut size={15} />
              {!collapsed && 'Sign out'}
            </button>
          </form>
        </div>

        {/* Collapse/Expand Toggle Button */}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute right-2 top-16 z-20 flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md hover:text-foreground hover:bg-muted transition-all"
        >
          {collapsed ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
      </aside>

      {/* Mobile Drawer Sidebar Overlay */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-50 flex sm:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-300"
            onClick={() => setMobileOpen(false)}
          />

          {/* Drawer Panel */}
          <div className="relative flex w-72 max-w-[80vw] flex-1 flex-col bg-accent border-r border-border-strong shadow-2xl transition-transform duration-300 ease-out animate-in slide-in-from-left">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-3">
                <TenantMark tenantName={tenantName} logoUrl={logoUrl} gradient />
                <div className="min-w-0">
                  <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                    {industryLabel}
                  </p>
                  <p className="truncate text-sm font-semibold tracking-tight">{tenantName}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto" onClick={() => setMobileOpen(false)}>
              <Sidebar role={role} industry={industry} collapsed={false} />
            </div>

            <div className="border-t border-border p-4 bg-muted/20">
              <div className="mb-3 px-2">
                <p className="truncate text-xs font-semibold text-foreground/90">{userEmail}</p>
                <p className="text-[11px] font-medium text-muted-foreground">{roleLabel}</p>
              </div>
              <form action={signOutAction} className="w-full">
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Top bar — every page, every breakpoint (M21 #6 follow-up) */}
        <header className="no-print flex h-14 shrink-0 items-center justify-end gap-3 border-b border-border bg-accent backdrop-blur-md px-4">
          <div className="mr-auto flex items-center gap-3 sm:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-accent-foreground/60 transition-colors hover:bg-[rgba(139,34,66,0.07)] hover:text-primary"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <span className="font-semibold tracking-tight text-sm text-foreground">{tenantName}</span>
          </div>
          <TopBarActions
            userFullName={userFullName}
            userEmail={userEmail}
            roleLabel={roleLabel}
            signOutAction={signOutAction}
            walkinsEnabled={walkinsEnabled}
            branchId={branchId}
          />
        </header>

        <main id="app-main-scroll" className="min-w-0 flex-1 bg-background/50 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}

