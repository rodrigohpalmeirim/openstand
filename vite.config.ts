/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-maskable-512.png'],
      workbox: {
        // pdf.js standard fonts, ICC profiles and WASM image decoders (JBIG2/JPEG 2000 scans) are precached so
        // any PDF renders offline; the large CJK character maps are cached on first use instead.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mjs}', 'pdfjs/{standard_fonts,wasm,iccs}/*.{pfb,ttf,wasm,icc,js}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/pdfjs/cmaps/'),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-cmaps', expiration: { maxEntries: 200 } },
          },
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Face gestures load MediaPipe on demand; don't precache it for everyone.
        globIgnores: ['**/vision_bundle-*.js'],
      },
      manifest: {
        name: 'OpenStand',
        short_name: 'OpenStand',
        description: 'Open-source sheet music reader, library and performance tool',
        theme_color: '#111214',
        background_color: '#111214',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: '/',
            accept: {
              'application/pdf': ['.pdf'],
              'text/plain': ['.txt', '.cho', '.chopro', '.chordpro', '.crd', '.pro', '.abc'],
              'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
              'application/x-openstand-package': ['.ospkg', '.osbackup'],
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
