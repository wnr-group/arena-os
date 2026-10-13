-- ============================================================================
-- Arena OS — 0119: advance / full also require the webhook secret (review of 0114)
--
-- 0114 required only the Razorpay key id + key secret. Without the WEBHOOK secret
-- the signed payment.captured webhook is rejected (401), so a customer could pay
-- while the booking stayed pending_payment until the hold was released. A venue
-- can therefore not require online payment unless all three credentials exist.
--
-- Any row already in advance/full without a webhook secret is put back to
-- 'venue' first (clearing the advance fields the 0114 CHECK ties to the mode),
-- so the new constraint can be added safely.
-- ============================================================================

update public.payment_settings
   set online_payment_mode = 'venue', advance_type = null, advance_value = null
 where online_payment_mode in ('advance', 'full')
   and razorpay_webhook_secret_encrypted is null;

do $$ begin
  alter table public.payment_settings
    add constraint payment_settings_online_mode_needs_webhook_secret
    check (
      online_payment_mode not in ('advance', 'full')
      or razorpay_webhook_secret_encrypted is not null
    );
exception when duplicate_object then null; end $$;
