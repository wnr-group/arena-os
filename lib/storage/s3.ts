import 'server-only'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

/**
 * Generic S3-compatible object storage (AWS S3, Cloudflare R2, DigitalOcean
 * Spaces, MinIO, ...). The bucket must be configured for public read (bucket
 * policy / public-bucket setting) — object ACLs are handled differently across
 * providers (R2 doesn't support them at all), so we never pass one here.
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
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export async function uploadImage(file: File, keyPrefix: string): Promise<string> {
  const ext = ALLOWED_TYPES[file.type]
  if (!ext) throw new Error('Only JPEG, PNG, WEBP or GIF images are allowed.')
  if (file.size === 0) throw new Error('The selected file is empty.')
  if (file.size > MAX_BYTES) throw new Error('Image must be smaller than 5MB.')

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

/** Best-effort delete — never throws, so it's safe to call without awaiting the result. */
export async function deleteImage(url: string | null | undefined): Promise<void> {
  if (!url) return
  const base = (process.env.S3_PUBLIC_URL_BASE ?? '').replace(/\/$/, '')
  if (!base || !url.startsWith(base + '/')) return
  const key = url.slice(base.length + 1)
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }))
  } catch {
    // storage cleanup is not worth failing the caller's mutation over
  }
}
