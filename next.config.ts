import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
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
