import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
    buildListQuery,
    listContracts,
    searchContracts,
    shouldFetchLive,
    upsertOfficial,
} from '../src/contractsService.js'
import { mapOfficialContract } from '../src/baseApi.js'
import { createMemoryContract } from './helpers.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const v2 = JSON.parse(readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/contrato-v2.json'),
    'utf8'
))

const originalKey = process.env.BASE_API_KEY

afterEach(() => {
    if (originalKey === undefined) delete process.env.BASE_API_KEY
    else process.env.BASE_API_KEY = originalKey
})

describe('buildListQuery / shouldFetchLive', () => {
    it('matches nif on both sides without regex', () => {
        const query = buildListQuery({ nif: '519459369', year: 2026 })
        assert.deepEqual(query, {
            $and: [
                { date: { $regex: '^2026-' } },
                { $or: [{ contractingNifs: '519459369' }, { awardedNifs: '519459369' }] },
            ],
        })
    })

    it('only live-fetches nif queries when empty or stale and a key exists', () => {
        assert.equal(shouldFetchLive({ nif: '519459369', localCount: 0, lastSuccess: new Date(), hasKey: true }), true)
        assert.equal(shouldFetchLive({ nif: '519459369', localCount: 0, lastSuccess: new Date(), hasKey: false }), false)
        assert.equal(shouldFetchLive({ nif: null, localCount: 0, lastSuccess: null, hasKey: true }), false)
        assert.equal(shouldFetchLive({
            nif: '519459369',
            localCount: 3,
            lastSuccess: new Date(),
            hasKey: true,
        }), false)
        assert.equal(shouldFetchLive({
            nif: '519459369',
            localCount: 3,
            lastSuccess: new Date('2026-07-08'),
            hasKey: true,
        }), true)
    })
})

describe('listContracts live fallback', () => {
    const localDoc = {
        id: '1',
        description: 'Local',
        contractingEntity: '501501501 - Instituto',
        awarded: '519459369 - BOUNDLESS INTELLIGENCE GROUP LDA',
        contractingNifs: ['501501501'],
        awardedNifs: ['519459369'],
        value: 10,
        date: '2026-06-08',
        type: 'Ajuste direto',
    }

    it('returns local results with source local when the cache is fresh', async () => {
        process.env.BASE_API_KEY = 'test-key'
        let called = 0
        const result = await listContracts({
            nif: '519459369',
            Contract: createMemoryContract([localDoc]),
            fetchOfficial: async () => {
                called += 1
                return { disabled: false, records: [] }
            },
            getFreshness: async () => ({ last_success: new Date() }),
        })
        assert.equal(called, 0)
        assert.equal(result.source, 'local')
        assert.equal(result.total, 1)
        assert.equal(result.data[0].id, '1')
        assert.equal(result.warning, undefined)
    })

    it('does not call V2 without BASE_API_KEY', async () => {
        delete process.env.BASE_API_KEY
        let called = 0
        const result = await listContracts({
            nif: '519459369',
            Contract: createMemoryContract([]),
            fetchOfficial: async () => {
                called += 1
                return { disabled: false, records: [] }
            },
            getFreshness: async () => ({ last_success: new Date('2026-07-08') }),
        })
        assert.equal(called, 0)
        assert.equal(result.source, 'local')
        assert.equal(result.total, 0)
        assert.equal(result.warning, undefined)
    })

    it('fetches V2 on empty nif search, upserts, and marks source live', async () => {
        process.env.BASE_API_KEY = 'test-key'
        const Contract = createMemoryContract([])
        const mapped = mapOfficialContract(v2)
        const result = await listContracts({
            nif: '500500500',
            Contract,
            fetchOfficial: async (params) => {
                assert.equal(params.nifEntidade, '500500500')
                return { disabled: false, records: [mapped] }
            },
            getFreshness: async () => ({ last_success: new Date() }),
        })
        assert.equal(result.source, 'live')
        assert.equal(result.total, 1)
        assert.equal(Contract.store[0].id, '12345')
        assert.deepEqual(Contract.store[0].awardedNifs, ['500500500'])
    })

    it('returns local data plus warning when V2 fails, never 500', async () => {
        process.env.BASE_API_KEY = 'test-key'
        const result = await listContracts({
            nif: '519459369',
            Contract: createMemoryContract([localDoc]),
            fetchOfficial: async () => {
                throw new Error('BASE API timeout after 20000ms')
            },
            getFreshness: async () => ({ last_success: new Date('2026-07-08') }),
        })
        assert.equal(result.source, 'local')
        assert.equal(result.total, 1)
        assert.match(result.warning, /unavailable/)
    })

    it('rejects invalid nif with 400', async () => {
        await assert.rejects(
            () => listContracts({ nif: '12', Contract: createMemoryContract([]) }),
            err => err.statusCode === 400
        )
    })
})

describe('searchContracts', () => {
    it('treats a 9-digit q as nif and can live-fallback', async () => {
        process.env.BASE_API_KEY = 'test-key'
        const mapped = mapOfficialContract(v2)
        const Contract = createMemoryContract([])
        const result = await searchContracts({
            q: '500500500',
            Contract,
            fetchOfficial: async (params) => {
                assert.equal(params.nifEntidade, '500500500')
                return { disabled: false, records: [mapped] }
            },
            getFreshness: async () => ({ last_success: new Date() }),
        })
        assert.equal(result.source, 'live')
        assert.equal(result.total, 1)
    })

    it('does not call V2 for free-text search (V2 has no text filter)', async () => {
        process.env.BASE_API_KEY = 'test-key'
        let called = 0
        const result = await searchContracts({
            q: 'BOUNDLESS',
            Contract: createMemoryContract([]),
            fetchOfficial: async () => {
                called += 1
                return { disabled: false, records: [] }
            },
            getFreshness: async () => ({ last_success: new Date('2026-07-08') }),
        })
        assert.equal(called, 0)
        assert.equal(result.source, 'local')
        assert.equal(result.total, 0)
    })
})

describe('upsertOfficial', () => {
    it('writes list-shaped cache docs with nifs', async () => {
        const Contract = createMemoryContract([])
        const mapped = mapOfficialContract(v2)
        const n = await upsertOfficial([mapped], Contract)
        assert.equal(n, 1)
        assert.equal(Contract.store[0].contractingEntity, '501501501 - Instituto de Teste, EPE')
        assert.deepEqual(Contract.store[0].contractingNifs, ['501501501'])
    })
})
