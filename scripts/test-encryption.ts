/**
 * lib/security/encryption.ts — AES-256-GCM secret encryption.
 *
 * Covers the properties the payment-settings ticket depends on:
 *   - round trip, and ciphertext that never resembles the plaintext
 *   - a fresh IV per call (the same plaintext encrypts differently every time)
 *   - authentication: any tampering with version/IV/tag/ciphertext FAILS
 *   - AAD binding: a value sealed for tenant A cannot be opened as tenant B
 *   - a missing or malformed master key is a safe configuration error, never a
 *     fallback to a generated key or to plaintext
 *
 * NOTHING here prints a plaintext secret, a ciphertext, or a key.
 *
 *   npx tsx scripts/test-encryption.ts
 */
import { randomBytes } from 'node:crypto'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

/** True when fn() throws an error whose constructor name matches. */
function throwsWith(fn: () => unknown, name: string): boolean {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof Error && e.name === name
  }
}

async function main() {
  loadEnv()

  // The module is `import 'server-only'`, which resolves to a throwing stub
  // outside a React Server Component build. tsx has no such condition applied,
  // so a plain dynamic import works here — the marker is a bundler contract,
  // not a runtime guard.
  const {
    encryptSecret,
    decryptSecret,
    resolveMasterKey,
    isEncryptedValue,
    assertEncryptionConfigured,
  } = await import('../lib/security/encryption')

  // A stand-in for a Razorpay key secret. Never printed.
  const SECRET = `test-secret-${randomBytes(12).toString('hex')}`
  const TENANT_A = '11111111-1111-4111-8111-111111111111'
  const TENANT_B = '22222222-2222-4222-8222-222222222222'

  // ── 1. configuration ──────────────────────────────────────────────────────
  {
    let configured = true
    try {
      assertEncryptionConfigured()
    } catch {
      configured = false
    }
    check('PAYMENT_SETTINGS_ENCRYPTION_KEY is configured for this run', configured)
    if (!configured) {
      console.log('\nSet PAYMENT_SETTINGS_ENCRYPTION_KEY (openssl rand -hex 32) and re-run.')
      process.exit(1)
    }

    check('the env var is NOT exposed as NEXT_PUBLIC_*', process.env.NEXT_PUBLIC_PAYMENT_SETTINGS_ENCRYPTION_KEY === undefined)

    // resolveMasterKey() takes an explicit value, so bad configuration can be
    // exercised without mutating the process environment.
    // The genuinely-missing case: resolveMasterKey() reads process.env at call
    // time and caches nothing, so unsetting the var exercises the real path.
    // (Passing `undefined` would just hit the default parameter and re-read the
    // configured value.)
    const saved = process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY
    delete process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY
    const missingThrows = throwsWith(() => resolveMasterKey(), 'EncryptionConfigError')
    let missingMsg = ''
    try {
      resolveMasterKey()
    } catch (e) {
      missingMsg = e instanceof Error ? e.message : ''
    }
    process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY = saved
    check('a MISSING key is a safe EncryptionConfigError', missingThrows)
    check('…naming the env var, with no fallback to a generated key', missingMsg.includes('PAYMENT_SETTINGS_ENCRYPTION_KEY'))
    check('an EMPTY key is rejected', throwsWith(() => resolveMasterKey('   '), 'EncryptionConfigError'))
    check('a SHORT key is rejected (16 bytes is not AES-256)', throwsWith(() => resolveMasterKey('a'.repeat(32)), 'EncryptionConfigError'))
    check('a non-hex, non-base64 key is rejected', throwsWith(() => resolveMasterKey('not a real key at all!!'), 'EncryptionConfigError'))
    check('an ALL-ZERO key is rejected', throwsWith(() => resolveMasterKey('0'.repeat(64)), 'EncryptionConfigError'))
    check('a valid 64-char hex key resolves to 32 bytes', resolveMasterKey(randomBytes(32).toString('hex')).length === 32)
    check('a valid base64 key resolves to 32 bytes', resolveMasterKey(randomBytes(32).toString('base64')).length === 32)

    // The error must explain the fault without echoing the value it was handed.
    const leaked = randomBytes(20).toString('hex')
    let msg = ''
    try {
      resolveMasterKey(leaked)
    } catch (e) {
      msg = e instanceof Error ? e.message : ''
    }
    check('…and the configuration error never echoes the value it was given', msg.length > 0 && !msg.includes(leaked))
  }

  // ── 2. round trip ─────────────────────────────────────────────────────────
  {
    const ct = encryptSecret(SECRET, TENANT_A)
    check('encrypting produces a value that is NOT the plaintext', ct !== SECRET)
    check('…and does not contain the plaintext anywhere in it', !ct.includes(SECRET))
    check('…tagged v1 with four colon-separated parts', ct.startsWith('v1:') && ct.split(':').length === 4)
    check('…recognised by isEncryptedValue()', isEncryptedValue(ct))
    check('…and the plaintext itself is NOT', !isEncryptedValue(SECRET))
    check('decrypting returns the original plaintext exactly', decryptSecret(ct, TENANT_A) === SECRET)

    // Realistic Razorpay-shaped and awkward inputs.
    for (const [label, value] of [
      ['a typical key secret length (24 chars)', randomBytes(12).toString('hex')],
      ['a long secret (400 chars)', randomBytes(200).toString('hex')],
      ['a single character', 'x'],
      ['unicode and symbols', 'π-secret_ÿ€/+=:key'],
    ] as const) {
      const round = decryptSecret(encryptSecret(value, TENANT_A), TENANT_A)
      check(`round trip survives ${label}`, round === value)
    }

    check('an EMPTY plaintext is refused (callers must store NULL)', throwsWith(() => encryptSecret('', TENANT_A), 'TypeError'))
  }

  // ── 3. a fresh IV every time ──────────────────────────────────────────────
  {
    const seen = new Set<string>()
    const ivs = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const ct = encryptSecret(SECRET, TENANT_A)
      seen.add(ct)
      ivs.add(ct.split(':')[1])
    }
    check('200 encryptions of the SAME plaintext give 200 DIFFERENT ciphertexts', seen.size === 200)
    check('…because the IV is fresh each time (200 distinct nonces)', ivs.size === 200)
    check('…and every one still decrypts to the original', [...seen].every((c) => decryptSecret(c, TENANT_A) === SECRET))
  }

  // ── 4. authentication — tampering must FAIL, never return partial data ────
  {
    const ct = encryptSecret(SECRET, TENANT_A)
    const [v, iv, tag, data] = ct.split(':')

    /** Flip one bit in a base64 blob and re-encode. */
    const corrupt = (b64: string) => {
      const buf = Buffer.from(b64, 'base64')
      buf[0] ^= 0x01
      return buf.toString('base64')
    }

    const cases: [string, string][] = [
      ['the CIPHERTEXT is altered', `${v}:${iv}:${tag}:${corrupt(data)}`],
      ['the AUTH TAG is altered', `${v}:${iv}:${corrupt(tag)}:${data}`],
      ['the IV is altered', `${v}:${corrupt(iv)}:${tag}:${data}`],
      ['the version claims v2', `v2:${iv}:${tag}:${data}`],
      ['the version is garbage', `<script>:${iv}:${tag}:${data}`],
      ['a part is missing', `${v}:${iv}:${data}`],
      ['there are extra parts', `${v}:${iv}:${tag}:${data}:extra`],
      ['the tag is truncated', `${v}:${iv}:${Buffer.from(tag, 'base64').subarray(0, 8).toString('base64')}:${data}`],
      ['the IV is the wrong length', `${v}:${Buffer.alloc(8).toString('base64')}:${tag}:${data}`],
      ['the value is plaintext', SECRET],
      ['the value is empty', ''],
    ]
    for (const [label, tampered] of cases) {
      check(`decryption FAILS when ${label}`, throwsWith(() => decryptSecret(tampered, TENANT_A), 'DecryptionError'))
    }

    // The unrecognised version tag must not be reflected back verbatim.
    let msg = ''
    try {
      decryptSecret(`<script>alert(1)</script>:${iv}:${tag}:${data}`, TENANT_A)
    } catch (e) {
      msg = e instanceof Error ? e.message : ''
    }
    check('…and a hostile version tag is not echoed into the error message', !msg.includes('<script>'))

    // No error may carry the plaintext or the ciphertext.
    let tamperMsg = ''
    try {
      decryptSecret(`${v}:${iv}:${tag}:${corrupt(data)}`, TENANT_A)
    } catch (e) {
      tamperMsg = e instanceof Error ? e.message : ''
    }
    check('…and the failure message leaks neither plaintext nor ciphertext', !tamperMsg.includes(SECRET) && !tamperMsg.includes(data))
  }

  // ── 5. AAD binds a ciphertext to its tenant ───────────────────────────────
  {
    const forA = encryptSecret(SECRET, TENANT_A)
    check("a ciphertext sealed for tenant A opens as tenant A", decryptSecret(forA, TENANT_A) === SECRET)
    check("…but NOT as tenant B — a row copied between tenants fails", throwsWith(() => decryptSecret(forA, TENANT_B), 'DecryptionError'))
    check('…and not with the AAD omitted entirely', throwsWith(() => decryptSecret(forA), 'DecryptionError'))
  }

  // ── 6. a different master key cannot read it ──────────────────────────────
  {
    // A ciphertext produced under a DIFFERENT key, injected as if the master key
    // had been rotated underneath the stored value. Built by hand rather than by
    // mutating the module's cached key, so the module under test is untouched.
    const { createCipheriv } = await import('node:crypto')
    const otherKey = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', otherKey, iv, { authTagLength: 16 })
    cipher.setAAD(Buffer.from(TENANT_A, 'utf8'))
    const body = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()])
    const foreign = `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`

    check('a value encrypted under a DIFFERENT master key cannot be decrypted', throwsWith(() => decryptSecret(foreign, TENANT_A), 'DecryptionError'))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  // Print the error TYPE only — a stack from this module could quote a value.
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
