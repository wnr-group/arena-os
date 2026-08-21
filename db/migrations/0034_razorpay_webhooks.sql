-- ============================================================================
-- Arena OS — 0024: Razorpay webhook secret + webhook idempotency (AROS-50)
--
-- Three things, all in service of "only a signed webhook may confirm a payment":
--
--   1. payment_settings gains the WEBHOOK secret. Razorpay issues this
--      separately from the API key secret — they are different credentials with
--      different rotation lifecycles, and 0022 deliberately left a note saying
--      so. Reusing the key secret to verify signatures would be wrong AND would
--      couple two independent rotations together.
--
--   2. payment_intents.gateway_payment_id becomes UNIQUE. This is the
--      idempotency guarantee: a Razorpay payment id may be delivered any number
--      of times (retries, replays, at-least-once delivery) and can settle
--      exactly one intent, enforced by Postgres rather than by an application
--      `if (!exists)` that two concurrent requests would both pass.
--
--   3. webhook_events records every accepted delivery, keyed on Razorpay's own
--      event id. See the comment on that table for why this is a SECOND key
--      rather than a replacement for the payment id.
-- ============================================================================

-- ── 1. the webhook secret ────────────────────────────────────────────────────
-- Same storage contract as razorpay_key_secret_encrypted: AES-256-GCM
-- ciphertext from lib/security/encryption.ts, sealed with the tenant id as AAD,
-- under the master key in PAYMENT_SETTINGS_ENCRYPTION_KEY. The CHECK makes a
-- plaintext write fail at the database rather than succeed quietly.
alter table public.payment_settings
  add column if not exists razorpay_webhook_secret_encrypted text;

do $$ begin
  alter table public.payment_settings
    add constraint payment_settings_webhook_secret_is_encrypted
    check (
      razorpay_webhook_secret_encrypted is null
      or razorpay_webhook_secret_encrypted ~ '^v[0-9]+:[^:]+:[^:]+:[^:]+$'
    );
exception when duplicate_object then null; end $$;

-- The narrow SECURITY DEFINER reader, mirroring payment_secret_ciphertext()
-- from 0022. The webhook route has NO user session, so it cannot go through
-- auth_tenant_ids() — it reads with the owner connection instead, and this
-- function exists so that an authenticated member path (a future "test my
-- webhook" button) has a non-owner route to the ciphertext.
create or replace function public.payment_webhook_secret_ciphertext(p_tenant uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select razorpay_webhook_secret_encrypted
    from public.payment_settings
   where tenant_id = p_tenant
     and p_tenant in (select public.auth_tenant_ids());
$$;

grant execute on function public.payment_webhook_secret_ciphertext(uuid) to arena_app;

-- ── 2. payment id uniqueness — THE idempotency rule ─────────────────────────
-- Partial, because the column is null until a webhook settles the intent and
-- many intents legitimately sit unpaid. Not tenant-scoped: a Razorpay payment
-- id is globally unique, and two tenants claiming one would mean something has
-- gone badly wrong rather than being a legitimate collision.
create unique index if not exists idx_payment_intents_gateway_payment
  on public.payment_intents(gateway, gateway_payment_id)
  where gateway_payment_id is not null;

-- ── 3. the delivery log ─────────────────────────────────────────────────────
-- Razorpay sends an `x-razorpay-event-id` header and delivers at least once.
--
-- Why BOTH keys, when the payment id already prevents a double payment:
--   * payment id is the MONEY identity. It is what guarantees a rupee is
--     captured once, and it is the one that must never be relaxed. One payment
--     can arrive under several event ids (a retry after a 500, an
--     `order.paid` alongside a `payment.captured`), so event id alone would let
--     the same money through twice.
--   * event id is the DELIVERY identity. It short-circuits a repeat delivery
--     before any work happens, gives replay a cheap and explicit answer, and
--     records events we deliberately do not act on (payment.failed, refunds)
--     so an operator can see what arrived.
-- Neither subsumes the other, so both exist.
create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  gateway      text not null default 'razorpay',
  -- Razorpay's event id. Null-tolerant: the header is not contractually
  -- guaranteed, and a delivery without one must still be processable (the
  -- payment id then carries idempotency on its own).
  event_id     text,
  event_type   text not null,
  -- Resolved from OUR payment intent after signature verification, never from
  -- the payload. Null for a verified event we could not attribute.
  tenant_id    uuid references public.tenants(id) on delete cascade,
  order_id     text,
  payment_id   text,
  -- What we did: 'processed' | 'duplicate' | 'ignored' | 'rejected'
  outcome      text not null,
  received_at  timestamptz not null default now()
);

-- One row per delivered event. The insert is what CLAIMS an event id, so a
-- concurrent redelivery loses the race here rather than at the payment.
create unique index if not exists idx_webhook_events_event
  on public.webhook_events(gateway, event_id)
  where event_id is not null;

create index if not exists idx_webhook_events_tenant
  on public.webhook_events(tenant_id, received_at desc);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- The webhook route itself writes with the OWNER connection (it has no user
-- session — see lib/payments/webhook.ts for why that is unavoidable and how it
-- is contained). These policies exist so the in-app surfaces that will read the
-- delivery log are tenant-scoped like everything else.
alter table public.webhook_events enable row level security;

drop policy if exists webhook_events_select on public.webhook_events;
create policy webhook_events_select on public.webhook_events
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Read-only for the app role. Nothing reachable from a browser may write or
-- alter the delivery log; only the owner-connection webhook path appends to it.
grant select on public.webhook_events to arena_app;
