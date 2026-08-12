import { Bee } from '@ethersphere/bee-js'

const bee = new Bee('http://localhost:1633')
const batchId = 'e74ff0579173504fb0e478239073de39ec81bc1120bab415f5e71b0f6665be03'

console.log('test 1: single uploadChunk via bee-js')
const t1 = Date.now()
// 4096 zero bytes + 8 byte span
const span = new Uint8Array(8)
const data = new Uint8Array(4096)
const chunkData = new Uint8Array(8 + 4096)
chunkData.set(span)
chunkData.set(data, 8)
try {
  const res = await Promise.race([
    bee.uploadChunk(batchId, chunkData),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000))
  ])
  console.log('  ok, ref:', res.toHex(), 'in', Date.now() - t1, 'ms')
} catch (e) {
  console.log('  FAIL:', e.message, 'after', Date.now() - t1, 'ms')
}

console.log('\ntest 2: 64 parallel uploadChunk calls')
const t2 = Date.now()
const promises = []
for (let i = 0; i < 64; i++) {
  const sp = new Uint8Array(8)
  sp[0] = i + 1  // span = i+1 to make each chunk unique
  const d = new Uint8Array(4096)
  d[0] = i
  const cd = new Uint8Array(8 + 4096)
  cd.set(sp); cd.set(d, 8)
  promises.push(bee.uploadChunk(batchId, cd))
}
try {
  const results = await Promise.race([
    Promise.all(promises),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000))
  ])
  console.log('  ok 64 parallel uploads in', Date.now() - t2, 'ms')
} catch (e) {
  console.log('  FAIL:', e.message, 'after', Date.now() - t2, 'ms')
}
