import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { daysSince, isStale, STALE_AFTER_MS } from '../src/syncState.js'
import {
    backfillNifs,
    jobLocks,
    planStartupJobs,
    resetJobLocks,
    syncContracts,
    syncIncrementalV2,
    v2WindowDays,
    yearHasContracts,
} from '../src/sync.js'
import { createMemoryContract } from './helpers.js'
import { V2_FETCH_MAX_DAYS } from '../src/queryLimits.js'

afterEach(() => {
    resetJobLocks()
})

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
        const noopFresh = async () => ({})
        const first = await backfillNifs(null, {
            Contract: Model,
            batchSize: 10,
            markDone: async () => {},
            getFreshness: noopFresh,
        })
        assert.equal(first.processed, 1)
        assert.deepEqual(Model.store.find(d => d.id === 'a').awardedNifs, ['519459369'])
        assert.equal(Model.store.find(d => d.id === 'a').nifsBackfilled, true)

        const second = await backfillNifs(null, {
            Contract: Model,
            batchSize: 10,
            markDone: async () => {},
            getFreshness: noopFresh,
        })
        assert.equal(second.processed, 0)
    })

    it('skips when another backfill is already running', async () => {
        jobLocks.nifBackfill = true
        const result = await backfillNifs(null, {
            Contract: createMemoryContract([{ id: 'a' }]),
            markDone: async () => {},
            getFreshness: async () => ({}),
        })
        assert.equal(result.skipped, true)
        assert.equal(result.reason, 'in_progress')
        assert.equal(result.processed, 0)
    })

    it('skips when nif_backfill_at is set and nothing is left', async () => {
        const Model = createMemoryContract([
            { id: 'a', nifsBackfilled: true, contractingNifs: ['1'] },
        ])
        const result = await backfillNifs(null, {
            Contract: Model,
            markDone: async () => {
                throw new Error('should not mark done')
            },
            getFreshness: async () => ({ nif_backfill_at: new Date() }),
        })
        assert.equal(result.skipped, true)
        assert.equal(result.reason, 'already_done')
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
                    assert.equal(params.numDias, V2_FETCH_MAX_DAYS)
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

    it('caps the V2 window well below the API max of 90 days', () => {
        assert.equal(v2WindowDays(null), V2_FETCH_MAX_DAYS)
        assert.equal(v2WindowDays(new Date('2026-07-08'), Date.parse('2026-11-12')), V2_FETCH_MAX_DAYS)
        assert.equal(v2WindowDays(new Date('2026-11-11'), Date.parse('2026-11-12')), 2)
    })
})

describe('planStartupJobs / sync lock', () => {
    it('never schedules a NIF backfill at startup', () => {
        assert.deepEqual(planStartupJobs({ count: 0, lastSuccess: null }), {
            nifBackfill: false,
            sync: 'backfill',
        })
        assert.deepEqual(planStartupJobs({ count: 100, lastSuccess: new Date() }), {
            nifBackfill: false,
            sync: null,
        })
        assert.equal(planStartupJobs({
            count: 100,
            lastSuccess: new Date(Date.now() - STALE_AFTER_MS - 1000),
        }).sync, 'incremental')
    })

    it('refuses a second syncContracts while one is running', async () => {
        jobLocks.sync = true
        const result = await syncContracts(null, 'incremental')
        assert.equal(result.skipped, true)
        assert.equal(result.reason, 'in_progress')
    })

    it('uses the date index range to detect a year, not a full count', async () => {
        const Model = createMemoryContract([
            { id: '1', date: '2024-06-01' },
        ])
        assert.equal(await yearHasContracts(2024, Model), true)
        assert.equal(await yearHasContracts(2023, Model), false)
    })
})
