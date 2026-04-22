export {
  ERAE_TYPE,
  fetchEraeFile,
  openEraeFile,
  parseEraeFile,
  buildEraeIndex,
  type EraeBlock,
  type EraeFile,
  type EraeIndex,
  type EraeReader,
} from './erae.js'

export {
  hexToBytes,
  readBlocksNdjson,
  openManifest,
  addBlocksToManifest,
  saveManifest,
  getManifestBlockRange,
  writeBlockRangeMeta,
  type BlockRecord,
  type UploadResult,
  type UploadOptions,
  type AddBlocksResult,
  type ManifestMeta,
} from './swarm.js'

export {
  openPotIndexes,
  addBlocksToPot,
  savePotIndexes,
  getPotBlockRange,
  writePotBlockRangeMeta,
  type PotIndexes,
  type PotIndexRefs,
  type PotMeta,
  type OpenPotIndexesOptions,
} from './swarm-pot.js'

export {
  encodeBlockBundle,
  decodeBlockBundle,
  decodeBlockHeader,
  decodeBlockBody,
  decodeTransaction,
  hashBlockHeader,
  type BlockBundle,
  type DecodedHeader,
  type DecodedBody,
  type DecodedTransaction,
} from './bundle.js'
