import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

const eslintConfig = [
  // Flat config only ignores node_modules and .git by default, so `eslint .`
  // walked the whole build output and reported tens of thousands of errors in
  // generated bundles — drowning the handful of real ones in this repo.
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'tsconfig.tsbuildinfo'],
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
