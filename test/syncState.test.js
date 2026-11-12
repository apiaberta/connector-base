import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { daysSince, isStale, STALE_AFTER_MS } from '../src/syncState.js'
import { backfillNifs, syncIncrementalV2 } from '../src/sync.js'
import { createMemoryContract } from './helpers.js'

describe('isStale / daysSince', () => {
    it('treats missing last_success as stale', () => {
        assert.equal(isStale(null), true)
        assert.equal(isStale(new Date()), false)
        assert.equal(isStale(new Date(Date.now() - STALE_AFTER_MS - 1000)), true)
        assert.equal(daysSince(null), Infinity)
        assert.ok(daysSince(new Date('2026-07-08'), Date.parse('2026-11-12')) > 90)
    })
})

describe('backfillNifs', () => {
    it('is idempotent and fills contractingNifs/awardedNifs from labels', async () => {
        const Model = createMemoryContract([
            {
                id: 'a',
                contractingEntity: '501501501 - Instituto',
                awarded: '519459369 - BOUNDLESS INTELLIGENCE GROUP LDA',
            },
            {
                id: 'b',
                contractingEntity: '501501501 - Instituto',
                awarded: '500500500 - Fornecedor',
                contractingNifs: ['501501501'],
                awardedNifs: ['500500500'],
                nifsBackfilled: true,
            },
        ])
        const first = await backfillNifs(null, { Contract: Model, batchSize: 10, markDone: async () => {} })
        assert.equal(first.processed, 1)
        assert.deepEqual(Model.store.find(d => d.id === 'a').awardedNifs, ['519459369'])
        assert.equal(Model.store.find(d => d.id === 'a').nifsBackfilled, true)

        const second = await backfillNifs(null, { Contract: Model, batchSize: 10, markDone: async () => {} })
        assert.equal(second.processed, 0)
    })
})

describe('syncIncrementalV2', () => {
    it('skips without BASE_API_KEY', async () => {
        const previous = process.env.BASE_API_KEY
        delete process.env.BASE_API_KEY
        try {
            const result = await syncIncrementalV2(null)
            assert.equal(result.skipped, true)
            assert.equal(result.reason, 'no_api_key')
        } finally {
            if (previous === undefined) delete process.env.BASE_API_KEY
            else process.env.BASE_API_KEY = previous
        }
    })

    it('returns errors instead of throwing when V2 fails', async () => {
        const previous = process.env.BASE_API_KEY
        process.env.BASE_API_KEY = 'test-key'
        try {
            const result = await syncIncrementalV2(null, {
                getFreshness: async () => ({ last_success: new Date('2026-07-08') }),
                fetchOfficial: async (params) => {
                    assert.equal(params.numDias, 90)
                    throw new Error('BASE API timeout after 120000ms')
                },
            })
            assert.equal(result.skipped, false)
            assert.equal(result.errors.length, 1)
            assert.match(result.errors[0].error, /timeout/)
        } finally {
            if (previous === undefined) delete process.env.BASE_API_KEY
            else process.env.BASE_API_KEY = previous
        }
    })
})
