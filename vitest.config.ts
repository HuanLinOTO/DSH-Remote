import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { bundledLanguagesInfo } from 'shiki/langs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])])

export default defineConfig({
  define: {
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
})
