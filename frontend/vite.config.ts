import { rename, mkdir } from 'fs/promises'
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Post-build plugin: moves popup-callback.html from dist root to dist/auth/
// so it lines up with the /auth/popup-callback.html registered redirect URI.
function movePopupCallback(): import('vite').Plugin {
  return {
    name: 'move-popup-callback',
    apply: 'build',
    closeBundle: async () => {
      const src = resolve(__dirname, 'dist/popup-callback.html')
      const destDir = resolve(__dirname, 'dist/auth')
      const dest = resolve(destDir, 'popup-callback.html')
      try {
        await mkdir(destDir, { recursive: true })
        await rename(src, dest)
      } catch {
        // If the file wasn't emitted (e.g., during watch), silently skip.
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), movePopupCallback()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Dedicated popup callback entry so MSAL can relay the auth response
        // back to the opener via BroadcastChannel (required by MSAL browser v5).
        'popup-callback': resolve(__dirname, 'popup-callback.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    clearMocks: true,
  },
  server: {
    // Local dev convenience so frontend can use relative /api/v1 without extra env setup.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})