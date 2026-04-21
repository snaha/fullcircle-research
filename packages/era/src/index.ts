export {
  ERAE_TYPE,
  fetchEraeFile,
  parseEraeFile,
  buildEraeIndex,
  type EraeBlock,
  type EraeFile,
  type EraeIndex,
} from './erae.js'

export {
  hexToBytes,
  readBlocksNdjson,
  openManifest,
  addBlocksToManifest,
  saveManifest,
  type BlockRecord,
  type UploadResult,
  type UploadOptions,
  type AddBlocksResult,
} from './swarm.js'

export {
  openPotIndexes,
  addBlocksToPot,
  savePotIndexes,
  type PotIndexes,
  type PotIndexRefs,
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
