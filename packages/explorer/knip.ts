import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/app.html', 'src/routes/**/*'],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  ignore: [
    'src/lib/components/ui/**',
    'src/lib/utils.ts',
    // Vendored POT JS browser runtime; loaded at runtime via <script src>.
    'static/pot-web.js',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
