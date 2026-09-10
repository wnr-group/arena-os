import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { ConfirmDialogProvider } from '@/components/ui/ConfirmDialog'
import { dashboardFallbackFont } from '@/lib/fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'Arena OS — Smart Booking & POS Platform',
  description:
    'Multi-tenant booking, POS and operations platform for gaming cafes, studios and experience centres.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={dashboardFallbackFont.variable}>
      <body>
        <ConfirmDialogProvider>
          {children}
          <Toaster richColors closeButton position="top-right" />
        </ConfirmDialogProvider>
      </body>
    </html>
  )
}
