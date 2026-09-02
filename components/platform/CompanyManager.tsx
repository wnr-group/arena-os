'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ExternalLink, Loader2, Trash2, UserPlus } from 'lucide-react'
import {
  setCompanyStatus,
  updateCompany,
  addCompanyMember,
  removeCompanyMember,
  deleteCompany,
} from '@/lib/actions/platform'
import { ROLE_LABELS, type MemberRole } from '@/lib/auth/roles'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type Tenant = {
  id: string
  slug: string
  name: string
  industry: string
  status: string
  currency: string
  timezone: string
}
type Member = { id: string; role: string; status: string; fullName: string | null; email: string }

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const label = 'text-xs font-medium text-muted-foreground'
const INDUSTRIES = [
  ['gaming_cafe', 'Gaming Cafe'],
  ['recording_studio', 'Recording Studio'],
  ['podcast_studio', 'Podcast Studio'],
  ['dance_studio', 'Dance Studio'],
  ['vr_centre', 'VR Centre'],
  ['other', 'Other'],
] as const
const ROLES: MemberRole[] = ['owner', 'manager', 'cashier', 'kitchen_staff', 'floor_staff', 'receptionist']
const STATUSES = ['active', 'trial', 'suspended', 'cancelled'] as const

export function CompanyManager({
  domain,
  tenant,
  members,
}: {
  domain: string
  tenant: Tenant
  members: Member[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [statusUpdating, setStatusUpdating] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  function run(fn: () => Promise<{ error?: string }>, after?: () => void, onSettled?: () => void) {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        after?.()
        router.refresh()
      }
      onSettled?.()
    })
  }

  return (
    <div>
      <Link href="/admin" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={15} /> All companies
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{tenant.name}</h1>
          <a
            href={`http://${tenant.slug}.${domain}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {tenant.slug}.{domain} <ExternalLink size={13} />
          </a>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              disabled={pending || tenant.status === s}
              onClick={() => {
                setStatusUpdating(s)
                run(
                  () => setCompanyStatus(tenant.id, s),
                  undefined,
                  () => setStatusUpdating(null),
                )
              }}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium capitalize transition disabled:opacity-100 ${
                tenant.status === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted disabled:opacity-50'
              }`}
            >
              {statusUpdating === s && <Loader2 size={12} className="animate-spin" />}
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* details */}
      <CompanyDetails tenant={tenant} pending={pending} run={run} />

      {/* members */}
      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Owners &amp; staff
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border">
          <table className="w-full text-base">
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{m.fullName || '—'}</p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{ROLE_LABELS[m.role as MemberRole] ?? m.role}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.status}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      disabled={pending}
                      onClick={() => {
                        setRemovingId(m.id)
                        run(
                          () => removeCompanyMember(m.id, tenant.id),
                          undefined,
                          () => setRemovingId(null),
                        )
                      }}
                      className="text-destructive hover:opacity-80 disabled:opacity-50"
                      aria-label="Remove"
                    >
                      {removingId === m.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AddMemberForm tenantId={tenant.id} pending={pending} run={run} />
      </section>

      {/* danger */}
      <section className="mt-12 rounded-lg border border-destructive/30 p-4">
        <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Deleting a company permanently removes its data, bookings and members.
        </p>
        <button
          disabled={pending}
          onClick={() => {
            confirm({
              title: `Delete "${tenant.name}" and all its data?`,
              description: 'This cannot be undone.',
              confirmText: 'Delete company',
              onConfirm: async () => {
                setError(null)
                const r = await deleteCompany(tenant.id)
                if (r.error) setError(r.error)
                else router.push('/admin')
              },
            })
          }}
          className="mt-3 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          Delete company
        </button>
      </section>
    </div>
  )
}

function CompanyDetails({
  tenant,
  pending,
  run,
}: {
  tenant: Tenant
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>, after?: () => void, onSettled?: () => void) => void
}) {
  const [name, setName] = useState(tenant.name)
  const [industry, setIndustry] = useState(tenant.industry)
  const [currency, setCurrency] = useState(tenant.currency)
  const [timezone, setTimezone] = useState(tenant.timezone)
  const [saving, setSaving] = useState(false)

  return (
    <section className="mt-8 rounded-lg border p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Details</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2">
          <label className={label}>Name</label>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className={label}>Industry</label>
          <select className={input} value={industry} onChange={(e) => setIndustry(e.target.value)}>
            {INDUSTRIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Currency</label>
          <input className={input} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </div>
        <div>
          <label className={label}>Timezone</label>
          <input className={input} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </div>
      </div>
      <button
        disabled={pending || !name}
        onClick={() => {
          setSaving(true)
          run(
            () =>
              updateCompany(tenant.id, {
                name,
                industry: industry as (typeof INDUSTRIES)[number][0],
                currency,
                timezone,
              }),
            undefined,
            () => setSaving(false),
          )
        }}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        Save details
      </button>
    </section>
  )
}

function AddMemberForm({
  tenantId,
  pending,
  run,
}: {
  tenantId: string
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>, after?: () => void, onSettled?: () => void) => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('manager')
  const [password, setPassword] = useState('')
  const [adding, setAdding] = useState(false)

  return (
    <div className="mt-3 rounded-md border border-dashed p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <UserPlus size={14} /> Add owner or staff
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <input className={input} placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <input className={input} placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className={input} value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <input className={input} placeholder="Password (new user)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button
          disabled={pending || !email || !fullName}
          onClick={() => {
            setAdding(true)
            run(
              () => addCompanyMember({ tenantId, email, fullName, role, password: password || undefined }),
              () => {
                setFullName('')
                setEmail('')
                setPassword('')
              },
              () => setAdding(false),
            )
          }}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {adding && <Loader2 size={14} className="animate-spin" />}
          Add
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Password is only needed when the email is new. Existing users are just linked to this company.
      </p>
    </div>
  )
}
