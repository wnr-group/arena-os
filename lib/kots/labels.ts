import type { KotStatus } from '@/lib/kots/service'

/** Shared between the kitchen dashboard (client) and the print slip (server) — a
 * plain value module so the server page never has to import a 'use client' file. */
export const STATUS_LABEL: Record<KotStatus, string> = {
  pending: 'Pending',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
}
