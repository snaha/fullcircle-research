import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/bin.ts'],
  ignoreExportsUsedInFile: true,
}

export default config
