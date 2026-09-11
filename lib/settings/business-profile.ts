/**
 * The tenant's business profile — legal identity for GST invoices.
 *
 * Takes a `tx` (like lib/billing/invoice.ts and lib/customers/service.ts) so
 * the billing transaction can read the invoice prefix without opening a second
 * connection, and so this is testable without a request context.
 *
 * lib/settings/business.ts is the ctx-taking reader on top of it.
 */
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { businessProfiles } from '@/db/schema'
import {
  normalizeWhatsappGroupUrl,
  whatsappGroupFields,
  WHATSAPP_GROUP_ENABLED_MESSAGE,
} from './whatsapp-group'
import {
  normalizeGoogleReviewUrl,
  googleReviewFields,
  GOOGLE_REVIEW_ENABLED_MESSAGE,
} from './google-review'

type Db = NodePgDatabase<typeof schema>

export type BusinessProfile = typeof businessProfiles.$inferSelect

/**
 * Prefix used when a tenant has not configured one (and the column default).
 *
 * This is the ONLY place the string 'INV' appears in the codebase.
 */
export const DEFAULT_INVOICE_PREFIX = 'INV'

/**
 * A GST invoice number may not exceed 16 characters, and the format in
 * lib/billing/invoice.ts is `PREFIX/YYYY/NNNNNN` — 12 characters plus the
 * prefix. Mirrored by a CHECK constraint in migration 0012.
 */
export const MAX_INVOICE_PREFIX_LENGTH = 4

/** Trim to null so '' and '   ' never reach the database as empty strings. */
function blankToNull(v: string | null | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} is too long.`).optional().nullable()

/**
 * The save contract. GSTIN is deliberately loose — the project has no GSTIN
 * validator, and inventing one would reject legitimate edge cases (SEZ,
 * UIN-holders) for no benefit at this stage. Length only.
 */
export const businessProfileSchema = z.object({
  legalName: optionalText(200, 'Legal name'),
  gstin: optionalText(20, 'GSTIN'),
  address: optionalText(500, 'Address'),
  logoUrl: z
    .string()
    .trim()
    .max(2000, 'That logo URL is too long.')
    .url('Enter a valid logo URL.')
    .optional()
    .nullable()
    .or(z.literal('')),
  invoicePrefix: z
    .string()
    .trim()
    .min(1, 'An invoice prefix is required.')
    .max(
      MAX_INVOICE_PREFIX_LENGTH,
      `Keep the prefix to ${MAX_INVOICE_PREFIX_LENGTH} characters — a GST invoice number cannot exceed 16.`,
    ),
  placeOfSupply: optionalText(100, 'Place of supply'),
  ...whatsappGroupFields,
  ...googleReviewFields,
})
  /**
   * The one rule ABOUT the pair, which neither field can state alone: the
   * invite cannot be switched on with nothing to point at. Mirrored by
   * business_profiles_whatsapp_group_enabled in 0104 — this copy exists so the
   * owner gets a sentence instead of a constraint violation, exactly as
   * validateEventFields() does for the event CHECKs.
   */
  /** Same pair rule as WhatsApp: the prompt cannot be on with nothing to point at. */
  .refine((v) => !v.googleReviewEnabled || !!v.googleReviewUrl?.trim(), {
    path: ['googleReviewUrl'],
    message: GOOGLE_REVIEW_ENABLED_MESSAGE,
  })
  .refine((v) => !v.whatsappGroupEnabled || !!v.whatsappGroupUrl?.trim(), {
    path: ['whatsappGroupUrl'],
    message: WHATSAPP_GROUP_ENABLED_MESSAGE,
  })

export type BusinessProfileInput = z.infer<typeof businessProfileSchema>

/** The tenant's profile, or null when it has never been configured. */
export async function loadBusinessProfile(
  tx: Db,
  tenantId: string,
): Promise<BusinessProfile | null> {
  const [row] = await tx
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.tenantId, tenantId))
    .limit(1)
  return row ?? null
}

/**
 * The prefix invoice numbering should use, falling back to the default when the
 * tenant has not configured a profile. Read inside the billing transaction, so
 * a prefix change and an invoice raised at the same moment cannot interleave.
 */
export async function loadInvoicePrefix(tx: Db, tenantId: string): Promise<string> {
  const [row] = await tx
    .select({ prefix: businessProfiles.invoicePrefix })
    .from(businessProfiles)
    .where(eq(businessProfiles.tenantId, tenantId))
    .limit(1)
  const prefix = row?.prefix?.trim()
  return prefix ? prefix : DEFAULT_INVOICE_PREFIX
}

/**
 * Create or update the tenant's single profile.
 *
 * `tenant_id` is the primary key and the conflict target, so this can only ever
 * touch the caller's own row — and `created_at` is never in the update set, so
 * the original configuration date survives every edit.
 */
export async function upsertBusinessProfile(
  tx: Db,
  tenantId: string,
  input: BusinessProfileInput,
): Promise<BusinessProfile> {
  const whatsappUrl = normalizeWhatsappGroupUrl(input.whatsappGroupUrl)
  const googleUrl = normalizeGoogleReviewUrl(input.googleReviewUrl)
  const values = {
    legalName: blankToNull(input.legalName),
    gstin: blankToNull(input.gstin),
    address: blankToNull(input.address),
    logoUrl: blankToNull(input.logoUrl),
    invoicePrefix: input.invoicePrefix.trim(),
    placeOfSupply: blankToNull(input.placeOfSupply),
    // Stored CANONICAL, never as typed: normalize drops the query and fragment,
    // so the value the confirmation page redirects to can carry nothing that
    // was not part of the invite. A link that does not validate is stored as
    // null rather than rejected here — the schema above has already refused it
    // for any caller that went through the action.
    whatsappGroupUrl: whatsappUrl,
    // `&& whatsappUrl !== null` is not belt-and-braces for the schema, it is
    // what makes the 0104 CHECK unfireable from this writer even if a future
    // caller skips the schema. The flag itself is REQUIRED on the input (see
    // whatsappGroupFields), so this cannot quietly default to off.
    whatsappGroupEnabled: input.whatsappGroupEnabled && whatsappUrl !== null,
    // Stored canonical, and enabled only alongside a real link — so the 0105
    // CHECK is unfireable from this writer even if a caller skips the schema.
    googleReviewUrl: googleUrl,
    googleReviewEnabled: input.googleReviewEnabled && googleUrl !== null,
  }

  const [row] = await tx
    .insert(businessProfiles)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: businessProfiles.tenantId, set: values })
    .returning()

  return row
}
