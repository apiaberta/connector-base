import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { officialContractUrl, officialContractsUrl } from '../src/baseApi.js'
import { fetchOfficialContracts } from '../src/official.js'
import { jsonResponse } from './helpers.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const v2 = JSON.parse(readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/contrato-v2.json'),
    'utf8'
))

describe('officialContractsUrl', () => {
    it('builds nif, numDias and Ano filters on GetInfoContrato', () => {
        assert.equal(
            officialContractUrl('12345'),
            'https://www.base.gov.pt/APIBase2V2/GetInfoContrato?idContrato=12345'
        )
        assert.equal(
            officialContractsUrl({ nifEntidade: '519459369' }),
            'https://www.base.gov.pt/APIBase2V2/GetInfoContrato?nifEntidade=519459369'
        )
        assert.equal(
            officialContractsUrl({ numDias: 90, ano: 2026 }),
            'https://www.base.gov.pt/APIBase2V2/GetInfoContrato?numDias=90&Ano=2026'
        )
        assert.ok(!officialContractsUrl({ nifEntidade: '1' }).toLowerCase().includes('q='))
    })
})

describe('fetchOfficialContracts', () => {
    it('is disabled without a key and does not call fetchFn', async () => {
        let called = 0
        const result = await fetchOfficialContracts(
            { nifEntidade: '519459369' },
            { apiKey: '', fetchFn: async () => { called += 1 } }
        )
        assert.equal(result.disabled, true)
        assert.equal(called, 0)
        assert.deepEqual(result.records, [])
    })

    it('maps V2 records through the official parser', async () => {
        const result = await fetchOfficialContracts(
            { nifEntidade: '500500500' },
            {
                apiKey: 'test-key',
                fetchFn: async (url, options) => {
                    assert.match(url, /nifEntidade=500500500/)
                    assert.equal(options.headers._AcessToken, 'test-key')
                    assert.equal(options.timeout, 20_000)
                    return jsonResponse([v2])
                },
            }
        )
        assert.equal(result.disabled, false)
        assert.equal(result.records[0].id, '12345')
        assert.equal(result.records[0].awardedEntities[0].nif, '500500500')
    })

    it('throws on HTTP errors so callers can degrade', async () => {
        await assert.rejects(
            () => fetchOfficialContracts(
                { numDias: 7 },
                {
                    apiKey: 'test-key',
                    fetchFn: async () => ({
                        ok: false,
                        status: 500,
                        async text() { return 'boom' },
                    }),
                }
            ),
            /HTTP 500/
        )
    })
})
