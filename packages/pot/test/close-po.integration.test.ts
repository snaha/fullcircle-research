// Regression test for the `setBitMap` wrap-around bug (PO >= 8 requires
// explicit `7 - (n % 8)` in JS to avoid negative shift counts).
//
// Before the fix, close-PO keys like [1, 2, 3] saved a bitmap with wrong
// bits set — so on reload the decoded fork count was too low, the value
// offset was off by one fork-size slot, and reads returned corrupted bytes.

import { describe, expect, it } from 'vitest'
import { createPotCompat } from '../src/compat.js'

const enabled = Boolean(process.env.BEE_URL && process.env.BEE_STAMP)
const describeIf = enabled ? describe : describe.skip

describeIf('compat multi-entry save+reload (gated on BEE_URL/BEE_STAMP)', () => {
  it('preserves values for 3 close numeric keys through save+reload', async () => {
    const pot = createPotCompat()
    const kvs = await pot.new(process.env.BEE_URL!, process.env.BEE_STAMP!)
    for (const k of [1, 2, 3]) await kvs.put(k, `v${k}`)
    const ref = await kvs.save()
    kvs.close()
    const r = await pot.load(ref, process.env.BEE_URL!, process.env.BEE_STAMP!)
    try {
      for (const k of [1, 2, 3]) expect(await r.get(k)).toBe(`v${k}`)
    } finally {
      r.close()
    }
  }, 30_000)

  it('preserves values for 6 close numeric keys through save+reload', async () => {
    const pot = createPotCompat()
    const kvs = await pot.new(process.env.BEE_URL!, process.env.BEE_STAMP!)
    for (const k of [1, 2, 3, 4, 5, 6]) await kvs.put(k, `v${k}`)
    const ref = await kvs.save()
    kvs.close()
    const r = await pot.load(ref, process.env.BEE_URL!, process.env.BEE_STAMP!)
    try {
      for (const k of [1, 2, 3, 4, 5, 6]) expect(await r.get(k)).toBe(`v${k}`)
    } finally {
      r.close()
    }
  }, 30_000)
})
