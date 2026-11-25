import { afterEach, describe, expect, test, vi } from 'vitest'
import { codeBudget } from '#server/code-budget.ts'

afterEach(() => vi.useRealTimers())

describe('codeBudget', () => {
  test('gives an address its sends in a window, then none until the window passes', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    const budget = codeBudget({ perAddress: 3, windowMs: 60_000, buckets: 1024 })
    expect([1, 2, 3, 4].map(() => budget.take('carol@example.com'))).toEqual([true, true, true, false])
    expect(budget.take('dave@example.com')).toBe(true)

    vi.setSystemTime(1_000_000 + 60_001)
    expect(budget.take('carol@example.com')).toBe(true)
  })

  test('in full memory, a flood of other addresses never gives an address more', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    const budget = codeBudget({ perAddress: 2, windowMs: 60_000, buckets: 4 })
    expect([1, 2, 3].map(() => budget.take('carol@example.com'))).toEqual([true, true, false])
    for (let i = 0; i < 1000; i++) budget.take(`flood-${i}@example.com`)
    expect(budget.take('carol@example.com')).toBe(false)
  })
})
