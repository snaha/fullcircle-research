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
  uploadBlocksAndBuildManifest,
  type BlockRecord,
  type UploadResult,
  type UploadOptions,
} from './swarm.js'

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
