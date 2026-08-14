import type { ZodError } from 'zod'

/**
 * Postgres error code (and constraint name, when present), dug out of
 * however many wrappers sit on top of it.
 *
 * Drizzle re-throws driver errors wrapped in its own Error whose `message` is
 * just `Failed query: insert into …` — the SQLSTATE and constraint name live
 * on `cause`. Matching on message text instead silently never fires, and the
 * raw SQL error ends up shown to the user.
 */
export function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const o = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof o.code === 'string') {
      return { code: o.code, constraint: typeof o.constraint === 'string' ? o.constraint : undefined }
    }
    cur = o.cause
  }
  return {}
}

function humanizeField(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Turns the first Zod validation issue into a plain-English message, e.g. "Hourly rate: Number must be greater than or equal to 0." */
export function zodErrorMessage(e: ZodError): string {
  const issue = e.issues[0]
  if (!issue) return 'Check the values entered.'
  const field = issue.path[0]
  return typeof field === 'string' ? `${humanizeField(field)}: ${issue.message}` : issue.message
}
