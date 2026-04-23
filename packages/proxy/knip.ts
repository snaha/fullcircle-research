import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/**/*.test.ts'],
  ignoreExportsUsedInFile: true,
}

export default config
