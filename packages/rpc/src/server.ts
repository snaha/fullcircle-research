// Minimal JSON-RPC 2.0 HTTP server. Accepts POST / with a single request or
// a batch array. Node's built-in `http` is enough — no framework needed.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  ethBlockNumber,
  ethChainId,
  ethGetBlockByHash,
  ethGetBlockByNumber,
  ethGetBlockTransactionCountByHash,
  ethGetBlockTransactionCountByNumber,
  ethGetUncleCountByBlockHash,
  ethGetUncleCountByBlockNumber,
  ethSyncing,
  netVersion,
  RpcError,
  web3ClientVersion,
  type RpcParams,
} from './handlers.js'
import type { DataStore } from './store.js'

type Handler = (store: DataStore, params: RpcParams) => Promise<unknown>

const METHODS: Record<string, Handler> = {
  eth_blockNumber: ethBlockNumber,
  eth_chainId: ethChainId,
  eth_getBlockByNumber: ethGetBlockByNumber,
  eth_getBlockByHash: ethGetBlockByHash,
  eth_getBlockTransactionCountByNumber: ethGetBlockTransactionCountByNumber,
  eth_getBlockTransactionCountByHash: ethGetBlockTransactionCountByHash,
  eth_getUncleCountByBlockNumber: ethGetUncleCountByBlockNumber,
  eth_getUncleCountByBlockHash: ethGetUncleCountByBlockHash,
  eth_syncing: ethSyncing,
  net_version: netVersion,
  web3_clientVersion: web3ClientVersion,
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}

interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string }
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export interface RpcServerOptions {
  store: DataStore
  host?: string
  port?: number
}

export function createRpcServer(options: RpcServerOptions): Server {
  const { store } = options
  return createServer((req, res) => {
    void handle(req, res, store).catch((err) => {
      console.error('unhandled', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, store: DataStore): Promise<void> {
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' }).end('method not allowed')
    return
  }

  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    writeJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    })
    return
  }

  if (Array.isArray(body)) {
    const results = await Promise.all(body.map((item) => dispatch(store, item)))
    writeJson(
      res,
      200,
      results.filter((r): r is JsonRpcResponse => r !== null),
    )
    return
  }

  const result = await dispatch(store, body)
  if (result === null) {
    res.writeHead(204).end()
    return
  }
  writeJson(res, 200, result)
}

async function dispatch(store: DataStore, body: unknown): Promise<JsonRpcResponse | null> {
  const req = (body ?? {}) as JsonRpcRequest
  const id = req.id ?? null
  // Notifications (no id) aren't part of the spec we care about; respond anyway
  // so viem sees a complete reply if it ever sends one.
  if (typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } }
  }
  const handler = METHODS[req.method]
  if (!handler) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    }
  }
  const params = Array.isArray(req.params) ? (req.params as RpcParams) : []
  try {
    const result = await handler(store, params)
    return { jsonrpc: '2.0', id, result }
  } catch (err) {
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } }
    }
    console.error(`${req.method} failed`, err)
    const message = err instanceof Error ? err.message : 'internal error'
    return { jsonrpc: '2.0', id, error: { code: -32603, message } }
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
