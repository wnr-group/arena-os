import type { ZodError } from 'zod'

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
