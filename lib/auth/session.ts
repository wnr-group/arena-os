import 'server-only'
import { cache } from 'react'
import { randomBytes, createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { eq, and, gt } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { sessions, users } from '@/db/schema'
import { SESSION_COOKIE as COOKIE } from './cookie'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

export type CurrentUser = {
  id: string
  email: string
  fullName: string | null
  isPlatformAdmin: boolean
}

// The cookie carries an opaque random token; the DB stores only its SHA-256, so
// a database read never yields a usable session token.
function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Create a session for a user and set the httpOnly cookie. Uses the OWNER
 * connection — sessions are identity infrastructure, not tenant data.
 */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await ownerDb.insert(sessions).values({
    id: tokenId(token),
    userId,
    expiresAt,
  })

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
}

/**
 * Resolve the logged-in user from the session cookie, or null.
 * Wrapped in React cache() so repeated calls within one request hit the DB once.
 */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null

  const rows = await ownerDb
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenId(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)

  return rows[0] ?? null
})

/** Destroy the current session (DB row + cookie). */
export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) {
    await ownerDb.delete(sessions).where(eq(sessions.id, tokenId(token)))
  }
  jar.delete(COOKIE)
}
