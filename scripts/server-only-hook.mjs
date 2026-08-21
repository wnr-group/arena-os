/**
 * Lets the standalone tsx scripts in this directory import app modules that are
 * marked `import 'server-only'`.
 *
 * That specifier is a BUILD-TIME contract: Next.js aliases it to a module that
 * throws if it is ever pulled into a client bundle. Nothing installs it as a
 * real package, so a script importing such a module dies on "Cannot find
 * module 'server-only'" — even though the module runs fine under plain Node.
 *
 * Stubbing it here does NOT weaken the guarantee. The marker still does its job
 * in the real build, which is the only place a client bundle exists.
 *
 * Both halves are needed: tsx transpiles these scripts to CommonJS, so the
 * `require` path must be patched as well as the ESM resolver.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-encryption.ts
 */
import { createRequire } from 'node:module'

const STUBBED = new Set(['server-only', 'client-only'])

const require = createRequire(import.meta.url)
const Module = require('node:module')
const STUB = require.resolve('./server-only-stub.cjs')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (STUBBED.has(request)) return STUB
  return originalResolve.call(this, request, ...rest)
}

export async function resolve(specifier, context, next) {
  if (STUBBED.has(specifier)) {
    return { url: 'data:text/javascript,export{}', shortCircuit: true }
  }
  return next(specifier, context)
}
