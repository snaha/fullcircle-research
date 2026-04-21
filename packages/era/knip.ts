import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  // Vendored POT JS node runtime; loaded via `createRequire` in swarm-pot.ts
  // so knip can't see the dependency through static imports.
  ignore: ['vendor/pot/pot-node.js'],
}

export default config
