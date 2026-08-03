import 'server-only'
import { eq } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { users } from '@/db/schema'
import { hashPassword } from '@/lib/auth/password'

/**
 * Find a global user by email, or create one. Runs on the OWNER connection —
 * user identity is platform infrastructure. Returns the user id and whether it
 * was newly created. When creating, a password is required.
 */
export async function findOrCreateUser(input: {
  email: string
  fullName?: string | null
  password?: string
}): Promise<{ userId: string; created: boolean }> {
  const email = input.email.trim().toLowerCase()

  const [existing] = await ownerDb.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing) return { userId: existing.id, created: false }

  if (!input.password) throw new Error('A password is required to create this user.')
  const passwordHash = await hashPassword(input.password)
  const [created] = await ownerDb
    .insert(users)
    .values({ email, passwordHash, fullName: input.fullName ?? null })
    .returning({ id: users.id })
  return { userId: created.id, created: true }
}
