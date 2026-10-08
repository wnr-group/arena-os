/** Booking rule violations the caller is allowed to show verbatim. Lives in
 *  its own module so lib/booking/addons.ts and lib/booking/service.ts can both
 *  use it without importing each other. */
export class BookingError extends Error {}
