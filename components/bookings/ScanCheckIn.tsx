'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Camera, CheckCircle2, Loader2, ScanLine, X } from 'lucide-react'
import { checkInBookingByToken, type CheckInResult } from '@/lib/actions/bookings'

/** Minimal shape of the browser's native QR/barcode decoder — not yet in
 * TypeScript's DOM lib, and only available in Chromium-based browsers.
 * Feature-detected at runtime; the text input (keyboard-wedge scanner or
 * manual paste) always works regardless of browser support. */
type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null
}

type LastScan = { at: number; result: CheckInResult }

/**
 * Front-desk check-in: type/paste a code (or feed it from a keyboard-wedge
 * USB/Bluetooth scanner, which types the decoded text + Enter into whatever
 * has focus), or scan with the device camera where the browser supports
 * BarcodeDetector. Either path calls the same server action.
 */
export function ScanCheckIn() {
  const [code, setCode] = useState('')
  const [pending, startTransition] = useTransition()
  const [last, setLast] = useState<LastScan | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cameraSupported = getBarcodeDetectorCtor() !== null

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function submit(raw: string) {
    const value = raw.trim()
    if (!value || pending) return
    startTransition(async () => {
      const result = await checkInBookingByToken(value)
      setLast({ at: Date.now(), result })
      if (result.error) toast.error(result.error)
      else if (result.booking?.alreadyCheckedIn) toast(`${result.booking.customerName ?? 'Guest'} was already checked in.`)
      else toast.success(`${result.booking?.customerName ?? 'Guest'} checked in.`)
      setCode('')
      inputRef.current?.focus()
    })
  }

  // Camera scanning: poll video frames for a QR code while the stream is
  // live, stop as soon as one decodes. Cleans up the stream on unmount too,
  // not just on explicit stop, so navigating away never leaves the camera on.
  useEffect(() => {
    if (!cameraOn) return
    const DetectorCtor = getBarcodeDetectorCtor()
    if (!DetectorCtor) return

    let cancelled = false
    let frame = 0
    const detector = new DetectorCtor({ formats: ['qr_code'] })

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }

        const tick = async () => {
          if (cancelled || !videoRef.current) return
          try {
            const codes = await detector.detect(videoRef.current)
            if (codes[0]?.rawValue) {
              setCameraOn(false)
              submit(codes[0].rawValue)
              return
            }
          } catch {
            // A frame that fails to decode just isn't a hit — try the next one.
          }
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
      })
      .catch(() => setCameraError('Could not access the camera. Check permissions, or use the code field below.'))

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit is stable enough for a scan loop; re-running on every render would restart the camera
  }, [cameraOn])

  return (
    <div className="mt-6 space-y-6">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        {cameraSupported && (
          <div className="mb-4">
            {cameraOn ? (
              <div className="relative overflow-hidden rounded-xl border border-border bg-black">
                <video ref={videoRef} muted playsInline className="aspect-square w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setCameraOn(false)}
                  className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm"
                  aria-label="Stop camera"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCameraError(null)
                  setCameraOn(true)
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-8 text-sm font-semibold text-muted-foreground transition hover:border-primary/40 hover:text-primary"
              >
                <Camera size={18} /> Scan with camera
              </button>
            )}
            {cameraError && <p className="mt-2 text-sm text-destructive">{cameraError}</p>}
          </div>
        )}

        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <ScanLine size={14} /> Booking code
          </span>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit(code)
              }}
              placeholder="Scan, paste, or type a booking code"
              autoComplete="off"
              className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
            <button
              type="button"
              onClick={() => submit(code)}
              disabled={pending || !code.trim()}
              className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending && <Loader2 size={16} className="animate-spin" />}
              Check in
            </button>
          </div>
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          A USB/Bluetooth barcode scanner works too — it just types the code here and hits Enter.
        </p>
      </div>

      {last && (
        <div
          key={last.at}
          className={`rounded-2xl border p-5 shadow-sm ${
            last.result.error
              ? 'border-destructive/40 bg-destructive/10'
              : 'border-primary/20 bg-primary/5'
          }`}
        >
          {last.result.error ? (
            <p className="text-sm font-semibold text-destructive">{last.result.error}</p>
          ) : (
            last.result.booking && (
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <CheckCircle2 size={20} />
                </span>
                <div className="min-w-0">
                  <p className="font-bold text-foreground">
                    {last.result.booking.customerName ?? 'Guest'}
                    {last.result.booking.alreadyCheckedIn && (
                      <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Already checked in
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Booking #{last.result.booking.bookingNumber}
                    {last.result.booking.resourceName && ` · ${last.result.booking.resourceName}`}
                  </p>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
