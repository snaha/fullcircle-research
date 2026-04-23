import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const refsPath = resolve(__dirname, '../../data/latest-refs.json')
const latestRefs: { publisher?: string; manifest?: string; pot?: string; sqlite?: string } =
  existsSync(refsPath) ? JSON.parse(readFileSync(refsPath, 'utf8')) : {}

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  define: {
    __BUILD_PUBLISHER__: JSON.stringify(latestRefs.publisher ?? ''),
    __BUILD_MANIFEST__: JSON.stringify(latestRefs.manifest ?? ''),
    __BUILD_POT__: JSON.stringify(latestRefs.pot ?? ''),
    __BUILD_SQLITE__: JSON.stringify(latestRefs.sqlite ?? ''),
    __BUILD_BEE_URL__: JSON.stringify(process.env.FULLCIRCLE_BEE_URL ?? 'http://localhost:1633'),
  },
  server: {
    port: 5318,
  },
})
