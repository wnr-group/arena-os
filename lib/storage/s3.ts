import 'server-only'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

/**
 * Generic S3-compatible object storage (AWS S3, Cloudflare R2, DigitalOcean
 * Spaces, MinIO, ...). The bucket must be configured for public read (bucket
 * policy / public-bucket setting) — object ACLs are handled differently across
 * providers (R2 doesn't support them at all), so we never pass one here.
 *
 * ── WHAT MAY BE UPLOADED ────────────────────────────────────────────────────
 * Each caller passes an UploadPolicy naming the MIME types it accepts and its
 * size ceiling, so "menu images" and "expense receipts" can differ without one
 * loosening the other. The policy is enforced HERE, server-side: the browser's
 * filename, extension and declared type are all attacker-controlled, and the
 * extension written into the object key comes from our own table, never from
 * the upload.
 */

const globalForS3 = globalThis as unknown as { __s3Client?: S3Client }

function s3(): S3Client {
  if (!globalForS3.__s3Client) {
    const endpoint = process.env.S3_ENDPOINT || undefined
    globalForS3.__s3Client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint,
      forcePathStyle: !!endpoint,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    })
  }
  return globalForS3.__s3Client
}

const MAX_BYTES = 5 * 1024 * 1024

/** MIME → extension. The extension is taken from HERE, never from the upload's
 *  filename, so a `receipt.pdf.exe` cannot become the object key's suffix. */
export const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Expense receipts (AROS-110): every image the menu already accepts, plus PDF —
 * a bill is as often a scanned PDF as a phone photo.
 *
 * 5MB, the same ceiling images already use. It is comfortably more than a phone
 * photo or a scanned bill needs, and it must stay at or under the Server Action
 * body limit in next.config.ts (6MB, which leaves headroom for multipart
 * encoding) or the request would be rejected before this validation ever ran.
 */
export const RECEIPT_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  'application/pdf': 'pdf',
}

export type UploadPolicy = {
  /** MIME → extension. Anything absent is refused. */
  allowed: Record<string, string>
  maxBytes: number
  /** Used in the rejection messages, e.g. 'Image' / 'Receipt'. */
  label: string
  /** Human list for the "allowed types" message, e.g. 'JPEG, PNG, WEBP or PDF'. */
  allowedLabel: string
}

export const IMAGE_POLICY: UploadPolicy = {
  allowed: IMAGE_TYPES,
  maxBytes: MAX_BYTES,
  label: 'Image',
  allowedLabel: 'JPEG, PNG, WEBP or GIF images',
}

export const RECEIPT_POLICY: UploadPolicy = {
  allowed: RECEIPT_TYPES,
  maxBytes: MAX_BYTES,
  label: 'Receipt',
  allowedLabel: 'JPEG, PNG, WEBP, GIF or PDF files',
}

/**
 * Server-side validation, exported so it can be tested without touching S3.
 * Returns the extension to use; throws with a user-safe message otherwise.
 */
export function validateUpload(
  file: { type: string; size: number },
  policy: UploadPolicy,
): string {
  const ext = policy.allowed[file.type]
  if (!ext) throw new Error(`Only ${policy.allowedLabel} are allowed.`)
  if (file.size === 0) throw new Error('The selected file is empty.')
  if (file.size > policy.maxBytes) {
    throw new Error(`${policy.label} must be smaller than ${Math.round(policy.maxBytes / (1024 * 1024))}MB.`)
  }
  return ext
}

/**
 * Upload one file under `keyPrefix` and return its public URL.
 *
 * The object key is `${keyPrefix}/${uuid}.${ext}` — a random name, so the
 * caller's filename never reaches the key and two uploads can never collide.
 * ContentType is the validated MIME, so a PDF is served as `application/pdf`
 * and opens in the browser's viewer rather than downloading as octet-stream.
 */
export async function uploadFile(file: File, keyPrefix: string, policy: UploadPolicy): Promise<string> {
  const ext = validateUpload(file, policy)

  const key = `${keyPrefix}/${crypto.randomUUID()}.${ext}`
  const buf = Buffer.from(await file.arrayBuffer())

  await s3().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: file.type,
    }),
  )

  const base = (process.env.S3_PUBLIC_URL_BASE ?? '').replace(/\/$/, '')
  return `${base}/${key}`
}

/** Menu-item images (unchanged behaviour — same types, size and messages). */
export async function uploadImage(file: File, keyPrefix: string): Promise<string> {
  return uploadFile(file, keyPrefix, IMAGE_POLICY)
}

/** Expense receipts: images or PDF. */
export async function uploadReceipt(file: File, keyPrefix: string): Promise<string> {
  return uploadFile(file, keyPrefix, RECEIPT_POLICY)
}

/**
 * The object key a stored URL refers to, or null if it does not belong to us.
 *
 * THIS IS THE DELETION GUARD, and the reason nothing else derives keys by hand.
 * A URL only yields a key when it starts with our configured public base, so a
 * caller passing an arbitrary URL — including one pointing at another bucket,
 * or `…/../../other` — gets null and deletes nothing. Exported so the guard
 * itself can be tested.
 */
export function objectKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const base = (process.env.S3_PUBLIC_URL_BASE ?? '').replace(/\/$/, '')
  if (!base || !url.startsWith(base + '/')) return null
  const key = url.slice(base.length + 1)
  // Refuse traversal or an empty remainder even inside our own base.
  if (!key || key.includes('..')) return null
  return key
}

/** Best-effort delete — never throws, so it's safe to call without awaiting the result. */
export async function deleteObject(url: string | null | undefined): Promise<void> {
  const key = objectKeyFromUrl(url)
  if (!key) return
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }))
  } catch {
    // storage cleanup is not worth failing the caller's mutation over
  }
}

/** Existing name, kept so current callers (lib/actions/menu.ts) are unchanged. */
export const deleteImage = deleteObject
