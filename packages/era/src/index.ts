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
  addBalanceEventsToManifest,
  saveManifest,
  getManifestBlockRange,
  writeBlockRangeMeta,
  type BlockRecord,
  type Manifest,
  type ManifestRefs,
  type UploadOptions,
  type AddBlocksResult,
  type AddBalanceEventsResult,
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

export { FEED_TOPIC_STRINGS, FEED_TOPICS, type FeedKind } from './feed-topics.js'

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
