import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

const eslintConfig = [
  /**
   * Build output is not source and must not be linted.
   *
   * Flat config only ignores node_modules and .git by default, so `eslint .`
   * walks `.next/` as soon as any build has run and reports ~21,000 errors
   * from generated bundles, which buries every real finding and makes the
   * command useless in CI. Nothing here changes a single rule — it only stops
   * ESLint reading files nobody wrote.
   */
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'node_modules/**',
      'next-env.d.ts',
      'tsconfig.tsbuildinfo',
      // Git worktrees are whole checkouts of this repo. Linting them from the
      // parent reports every finding twice — once at `components/x.tsx` and
      // again at `.claude/worktrees/<name>/components/x.tsx` — and the count
      // grows with each worktree. A worktree is linted from inside itself.
      '.claude/worktrees/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // `_pct`, `_unused` — the conventional "declared deliberately, not read"
      // prefix used in this repo for placeholder parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
]

export default eslintConfig
