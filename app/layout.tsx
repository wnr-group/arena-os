import type { Metadata } from 'next'
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
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
