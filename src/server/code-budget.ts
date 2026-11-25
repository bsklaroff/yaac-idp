/**
 * How many sign-in codes each address may be sent in a window, in fixed
 * memory and fixed work per request.
 *
 * Addresses share `buckets` slots by a keyed hash, each slot holding the
 * times of its last `perAddress` sends. Two addresses in one slot share its
 * budget, so a flood of other addresses can only make an address's limit
 * stricter, never forget its sends. The key is random per process, so no
 * one can choose which slot their flood lands in.
 */
import { createHmac, randomBytes } from 'node:crypto'

export interface CodeBudget {
  /** Takes a send for `address`, or answers false when its slot has none left. */
  take: (address: string) => boolean
}

export function codeBudget(opts: { perAddress: number, windowMs: number, buckets: number }): CodeBudget {
  const key = randomBytes(32)
  const sentAt = new Float64Array(opts.buckets * opts.perAddress)
  return {
    take(address) {
      const start = (createHmac('sha256', key).update(address).digest().readUInt32BE(0) % opts.buckets) * opts.perAddress
      let oldest = start
      for (let i = start + 1; i < start + opts.perAddress; i++) if (sentAt[i]! < sentAt[oldest]!) oldest = i
      const now = Date.now()
      if (sentAt[oldest]! > now - opts.windowMs) return false
      sentAt[oldest] = now
      return true
    },
  }
}
