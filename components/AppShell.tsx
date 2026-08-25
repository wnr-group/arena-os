'use client'

import { useEffect, useState } from 'react'
import { LogOut, Menu, X, PanelRightOpen, PanelRightClose } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
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

export function AppShell({
  industryLabel,
  tenantName,
  role,
  userEmail,
  roleLabel,
  signOutAction,
  children,
}: {
  industryLabel: string
  tenantName: string
  role: MemberRole
  userEmail: string
  roleLabel: string
  signOutAction: () => void | Promise<void>
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
    <div className="flex h-screen overflow-hidden bg-background text-foreground transition-colors duration-200">
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          'no-print relative hidden shrink-0 flex-col border-r border-border bg-card/65 backdrop-blur-md transition-all duration-300 ease-in-out sm:flex',
          collapsed ? 'w-[76px]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-3 border-b border-border px-5 py-4',
            collapsed && 'justify-center px-3',
          )}
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary to-indigo-500 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20">
            {initialsOf(tenantName)}
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                {industryLabel}
              </p>
              <p className="truncate text-sm font-semibold tracking-tight">{tenantName}</p>
            </div>
          )}
        </div>

        <Sidebar role={role} collapsed={collapsed} />

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
          <div className="relative flex w-72 max-w-[80vw] flex-1 flex-col bg-card border-r border-border shadow-2xl transition-transform duration-300 ease-out animate-in slide-in-from-left">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary to-indigo-500 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20">
                  {initialsOf(tenantName)}
                </div>
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
              <Sidebar role={role} collapsed={false} />
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
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile Header */}
        <header className="no-print flex h-14 items-center justify-between border-b border-border bg-card/65 backdrop-blur-md px-4 sm:hidden">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <span className="font-semibold tracking-tight text-sm">{tenantName}</span>
          </div>
          <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-tr from-primary to-indigo-500 text-xs font-bold text-primary-foreground shadow-sm">
            {initialsOf(tenantName)}
          </div>
        </header>

        <main id="app-main-scroll" className="min-w-0 flex-1 bg-background/50 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}

