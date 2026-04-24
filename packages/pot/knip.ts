import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['test/**/*.test.ts'],
  ignoreExportsUsedInFile: true,
}

export default config
