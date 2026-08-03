'use server'

import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ownerDb } from '@/db'
import { users } from '@/db/schema'
import { verifyPassword } from '@/lib/auth/password'
import { createSession, destroySession } from '@/lib/auth/session'
import { currentTenantSlug } from '@/lib/tenant/context'

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export type LoginState = { error?: string }

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })
  if (!parsed.success) {
    return { error: 'Enter a valid email and password.' }
  }

  const { email, password } = parsed.data

  // Identity lookup uses the OWNER connection (RLS-exempt). Auth is a privileged
  // bootstrap that runs before any tenant context exists.
  const [user] = await ownerDb
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1)

  // Verify even when the user is missing to keep timing roughly uniform.
  const ok = user
    ? await verifyPassword(user.passwordHash, password)
    : await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
        password,
      )

  if (!user || !ok) {
    return { error: 'Invalid email or password.' }
  }

  await createSession(user.id)

  // On a tenant subdomain → the workspace; on the root/admin domain → the
  // platform admin panel (which itself checks the is_platform_admin flag).
  const slug = await currentTenantSlug()
  redirect(slug ? '/dashboard' : '/admin')
}

export async function signOut(): Promise<void> {
  await destroySession()
  redirect('/login')
}
