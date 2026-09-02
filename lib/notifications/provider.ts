/**
 * Pluggable send seam for outbound customer notifications (M14 #7, v2).
 *
 * No real SMS/WhatsApp provider is wired into this codebase yet — M3-C
 * (notification_settings, notifications outbox, SMS provider integration) is
 * still unbuilt on the roadmap. getConfiguredProvider() returns null until a
 * real one is added here, so every send gracefully no-ops for now — see
 * lib/notifications/service.ts, which records that outcome rather than
 * treating it as an error.
 */

export type NotificationProvider = {
  send(to: string, body: string): Promise<{ providerMessageId?: string }>
}

export function getConfiguredProvider(): NotificationProvider | null {
  // When a real provider (e.g. MSG91, Twilio, Gupshup) is wired up, construct
  // and return it here, gated on its own env credentials. None exists yet.
  return null
}
