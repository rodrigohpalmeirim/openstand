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
      includeAssets: ['favicon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mjs}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
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
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: '/',
            accept: {
              'application/pdf': ['.pdf'],
              'text/plain': ['.txt', '.cho', '.chopro', '.chordpro', '.crd', '.pro', '.abc'],
              'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
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
