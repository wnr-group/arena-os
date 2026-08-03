'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, Trash2 } from 'lucide-react'
import { inviteStaff, updateMemberRole, removeMember } from '@/lib/actions/team'
import { ROLE_LABELS, type MemberRole } from '@/lib/auth/roles'

type Member = { id: string; fullName: string | null; email: string | null; role: string; status: string }

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const ROLES: MemberRole[] = ['owner', 'manager', 'cashier', 'kitchen_staff', 'floor_staff', 'receptionist']

export function TeamManager({
  members,
  currentMembershipId,
  currentRole,
}: {
  members: Member[]
  currentMembershipId: string
  currentRole: MemberRole
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function run(fn: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        after?.()
        router.refresh()
      }
    })
  }

  // Managers can grant every role except owner; owners can grant everything.
  const grantableRoles = currentRole === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner')

  return (
    <div className="mt-6">
      {error && (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <tbody>
            {members.map((m) => {
              const isSelf = m.id === currentMembershipId
              return (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">
                      {m.fullName || '—'} {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">{m.email || '—'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className="rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-60"
                      value={m.role}
                      disabled={pending || isSelf}
                      onChange={(e) => run(() => updateMemberRole(m.id, e.target.value as MemberRole))}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r} disabled={r === 'owner' && currentRole !== 'owner'}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{m.status}</td>
                  <td className="px-4 py-3 text-right">
                    {!isSelf && (
                      <button
                        disabled={pending}
                        onClick={() => run(() => removeMember(m.id))}
                        className="text-destructive hover:opacity-80 disabled:opacity-50"
                        aria-label="Remove"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <InviteForm grantableRoles={grantableRoles} pending={pending} run={run} />
    </div>
  )
}

function InviteForm({
  grantableRoles,
  pending,
  run,
}: {
  grantableRoles: MemberRole[]
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>, after?: () => void) => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('cashier')
  const [password, setPassword] = useState('')

  return (
    <div className="mt-4 rounded-md border border-dashed p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <UserPlus size={14} /> Add a team member
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <input className={input} placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <input className={input} placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className={input} value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
          {grantableRoles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <input className={input} placeholder="Temp password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button
          disabled={pending || !email || !fullName}
          onClick={() =>
            run(
              () => inviteStaff({ email, fullName, role, password: password || undefined }),
              () => {
                setFullName('')
                setEmail('')
                setPassword('')
              },
            )
          }
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Set a temporary password only if this email is new to Arena OS.
      </p>
    </div>
  )
}
