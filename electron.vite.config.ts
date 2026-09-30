import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// The renderer's libraries (React, Streamdown) live in devDependencies because Vite bundles
// them; only native modules like uiohook-napi stay in dependencies and ship in node_modules.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      // The audio worklet must be a real file: our CSP (script-src 'self') blocks data: URLs.
      assetsInlineLimit: (file) => (file.endsWith('.worklet.js') ? false : undefined),
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
