import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // lib/storage/s3.ts caps uploads at 5MB (menu images and expense
      // receipts alike). Next's own default is 1MB, which silently rejected
      // the request BEFORE that validation could run. Headroom above 5MB for
      // multipart encoding overhead.
      bodySizeLimit: '6mb',
    },
  },
  // The staff app is always reached on a tenant subdomain (demo.lvh.me:3000),
  // which Next treats as cross-origin to the dev server and blocks — so HMR
  // never connects and the browser silently keeps a stale page (including a
  // stale error overlay after a build failure). Allow the local wildcard host.
  allowedDevOrigins: ['lvh.me', '*.lvh.me', 'demo.lvh.me', 'localhost:3000'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.neon.tech' },
      { protocol: 'https', hostname: '*.amazonaws.com' },
      {
        // Local Supabase storage during development
        protocol: 'http',
        hostname: '127.0.0.1',
        port: '54321',
        pathname: '/storage/v1/object/public/**',
      },
    ],
    dangerouslyAllowLocalIP: process.env.NODE_ENV === 'development',
    formats: ['image/webp', 'image/avif'],
  },
}

export default nextConfig
