/**
 * Lets the standalone tsx tests import server actions that reach for the
 * Next.js request runtime.
 *
 * Companion to ./server-only-hook.mjs and built the same way, for the same
 * reason: `next/headers` and `next/cache` are request-scoped, so outside a
 * request `cookies()` and `revalidatePath()` throw and every server action
 * becomes untestable — including the ones whose whole job is an authorization
 * guard.
 *
 * Both halves are needed: tsx transpiles these scripts to CommonJS, so the
 * `require` path must be patched as well as the ESM resolver.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-platform-billing.ts
 *
 * See ./next-runtime-stub.cjs for exactly what is and is not replaced — no
 * guard, no policy and no business rule is among it.
 */
import { createRequire } from 'node:module'

const STUBBED = new Set(['next/headers', 'next/cache'])

const require = createRequire(import.meta.url)
const Module = require('node:module')
const STUB = require.resolve('./next-runtime-stub.cjs')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (STUBBED.has(request)) return STUB
  return originalResolve.call(this, request, ...rest)
}

export async function resolve(specifier, context, next) {
  if (STUBBED.has(specifier)) {
    return { url: `file://${STUB.replace(/\\/g, '/')}`, format: 'commonjs', shortCircuit: true }
  }
  return next(specifier, context)
}
