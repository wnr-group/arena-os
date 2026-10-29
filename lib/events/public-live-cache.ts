/** Cache tag for one event's public live view (see getPublicEventLive). */
export const liveTag = (eventId: string): string => `event-live:${eventId}`

/**
 * How long a viewer-facing snapshot may be reused, in seconds. Every spectator
 * polling the page used to cost a full server render and several transactions;
 * with this, the first request in each window pays and the rest share it.
 * Staff actions that change the bracket expire the tag immediately.
 */
export const LIVE_CACHE_SECONDS = 8
