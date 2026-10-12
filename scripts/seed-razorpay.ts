/**
 * Test fixture: give a tenant stored Razorpay credentials (encrypted the real
 * way). Since M36 #2 a pay-online booking is refused for a venue that cannot
 * take payment, so tests that exercise pay-now must seed a gateway first.
 * Optionally sets the booking payment mode.
 */
export async function seedRazorpay(
  query: (text: string, params?: unknown[]) => Promise<unknown>,
  tenantId: string,
  mode: 'optional_full' | 'venue' | 'advance' | 'full' = 'optional_full',
  advance?: { type: 'fixed' | 'percent'; value: number },
): Promise<void> {
  const { encryptSecret } = await import('../lib/security/encryption')
  await query(
    `insert into payment_settings (tenant_id, razorpay_key_id, razorpay_key_secret_encrypted, online_payment_mode, advance_type, advance_value)
     values ($1,'rzp_test_seed',$2,$3,$4,$5)
     on conflict (tenant_id) do update set razorpay_key_id=excluded.razorpay_key_id,
       razorpay_key_secret_encrypted=excluded.razorpay_key_secret_encrypted,
       online_payment_mode=excluded.online_payment_mode, advance_type=excluded.advance_type, advance_value=excluded.advance_value`,
    [tenantId, encryptSecret('seed-secret', tenantId), mode, advance?.type ?? null, advance?.value ?? null],
  )
}
