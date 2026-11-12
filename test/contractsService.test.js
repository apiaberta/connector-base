import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
    buildListQuery,
    listContracts,
    searchContracts,
    shouldFetchLive,
    textMatchClause,
    upsertOfficial,
} from '../src/contractsService.js'
import { searchDateRange, clampPageLimit } from '../src/queryLimits.js'
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
                { date: { $gte: '2026-01-01', $lte: '2026-12-31' } },
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

    it('restricts text search to the date window and keeps older docs out', async () => {
        const Contract = createMemoryContract([
            {
                id: 'new',
                description: 'Aquisição de hospital',
                contractingEntity: 'Instituto',
                awarded: 'Fornecedor',
                date: '2026-10-01',
            },
            {
                id: 'old',
                description: 'Aquisição de hospital',
                contractingEntity: 'Instituto',
                awarded: 'Fornecedor',
                date: '2015-10-01',
            },
        ])
        const result = await searchContracts({
            q: 'hospital',
            Contract,
            fetchOfficial: async () => ({ disabled: true, records: [] }),
            getFreshness: async () => ({ last_success: new Date() }),
            now: new Date('2026-11-12T00:00:00.000Z'),
        })
        assert.equal(result.total, 1)
        assert.equal(result.data[0].id, 'new')
        assert.equal(result.limit, 25)
    })

    it('searches a calendar year when year is passed', async () => {
        const Contract = createMemoryContract([
            { id: 'y15', description: 'obras', date: '2015-03-01' },
            { id: 'y16', description: 'obras', date: '2016-03-01' },
        ])
        const result = await searchContracts({
            q: 'obras',
            year: 2015,
            Contract,
            fetchOfficial: async () => ({ disabled: true, records: [] }),
            getFreshness: async () => ({ last_success: new Date() }),
        })
        assert.equal(result.total, 1)
        assert.equal(result.data[0].id, 'y15')
    })

    it('does not apply a date window to NIF-only search', async () => {
        const Contract = createMemoryContract([
            {
                id: 'old-nif',
                description: 'old',
                awardedNifs: ['519459369'],
                date: '2012-01-01',
            },
        ])
        const result = await searchContracts({
            nif: '519459369',
            Contract,
            fetchOfficial: async () => ({ disabled: true, records: [] }),
            getFreshness: async () => ({ last_success: new Date() }),
            now: new Date('2026-11-12T00:00:00.000Z'),
        })
        assert.equal(result.total, 1)
        assert.equal(result.data[0].id, 'old-nif')
    })

    it('clamps limit to 100', async () => {
        const result = await searchContracts({
            q: 'obras',
            limit: 500,
            Contract: createMemoryContract([]),
            fetchOfficial: async () => ({ disabled: true, records: [] }),
            getFreshness: async () => ({ last_success: new Date() }),
        })
        assert.equal(result.limit, 100)
    })
})

describe('query bounds helpers', () => {
    it('builds a default search window from today', () => {
        const range = searchDateRange({ now: new Date('2026-11-12T12:00:00.000Z') })
        assert.equal(range.$lte, '2026-11-12')
        assert.equal(range.$gte, '2025-11-12')
    })

    it('clamps page/limit', () => {
        assert.deepEqual(clampPageLimit(0, 0), { page: 1, limit: 1 })
        assert.deepEqual(clampPageLimit(2, 500), { page: 2, limit: 100 })
    })

    it('ANDs words across description and entity fields', () => {
        const clause = textMatchClause('hospital lisboa')
        assert.equal(clause.$and.length, 2)
        assert.equal(clause.$and[0].$or.length, 3)
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

    it('bulkWrites in batches instead of one giant array', async () => {
        const sizes = []
        const Contract = createMemoryContract([])
        const orig = Contract.bulkWrite.bind(Contract)
        Contract.bulkWrite = async (ops) => {
            sizes.push(ops.length)
            return orig(ops)
        }
        const records = Array.from({ length: 5 }, (_, i) => ({
            ...mapOfficialContract(v2),
            id: String(i + 1),
        }))
        const n = await upsertOfficial(records, Contract, { batchSize: 2 })
        assert.equal(n, 5)
        assert.deepEqual(sizes, [2, 2, 1])
    })
})

describe('listContracts unfiltered count', () => {
    it('uses estimatedDocumentCount when the query has no filters', async () => {
        let estimated = 0
        let counted = 0
        const Contract = createMemoryContract([
            { id: '1', date: '2026-01-01', description: 'a' },
            { id: '2', date: '2026-01-02', description: 'b' },
        ])
        const origEst = Contract.estimatedDocumentCount.bind(Contract)
        const origCount = Contract.countDocuments.bind(Contract)
        Contract.estimatedDocumentCount = () => {
            estimated += 1
            return origEst()
        }
        Contract.countDocuments = (filter) => {
            counted += 1
            return origCount(filter)
        }
        const result = await listContracts({
            Contract,
            fetchOfficial: async () => ({ disabled: true, records: [] }),
            getFreshness: async () => ({ last_success: new Date() }),
        })
        assert.equal(result.total, 2)
        assert.equal(estimated, 1)
        assert.equal(counted, 0)
    })
})
