import { getActiveContext } from '@/lib/tenant/context'
import { ScanCheckIn } from '@/components/bookings/ScanCheckIn'

export default async function ScanCheckInPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Check-in Scan</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Scan a customer&apos;s booking QR — or type/paste their code — to mark them checked in.
      </p>
      <ScanCheckIn />
    </div>
  )
}
