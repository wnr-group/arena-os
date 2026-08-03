import 'server-only'
import { hash, verify } from '@node-rs/argon2'

// Argon2id with sensible interactive parameters. @node-rs/argon2 ships prebuilt
// native binaries, so there's no node-gyp build step.
const OPTS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTS)
  } catch {
    return false
  }
}
