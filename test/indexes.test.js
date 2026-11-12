import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONTRACTS_TEXT_INDEX_NAME, dropContractsTextIndex } from '../src/models/contract.js'

describe('dropContractsTextIndex', () => {
    it('drops the legacy text index by name and is idempotent', async () => {
        const dropped = []
        let present = true
        const collection = {
            async indexes() {
                if (!present) return [{ name: '_id_' }, { name: 'date_-1' }]
                return [
                    { name: '_id_' },
                    {
                        name: CONTRACTS_TEXT_INDEX_NAME,
                        key: { _fts: 'text', _ftsx: 1 },
                        weights: { description: 1, contractingEntity: 1, awarded: 1 },
                    },
                ]
            },
            async dropIndex(name) {
                dropped.push(name)
                present = false
            },
        }
        const first = await dropContractsTextIndex(collection)
        assert.equal(first.dropped, true)
        assert.equal(first.index, CONTRACTS_TEXT_INDEX_NAME)
        const second = await dropContractsTextIndex(collection)
        assert.equal(second.dropped, false)
        assert.equal(second.reason, 'already_absent')
        assert.deepEqual(dropped, [CONTRACTS_TEXT_INDEX_NAME])
    })

    it('treats IndexNotFound as success', async () => {
        const collection = {
            async indexes() {
                return [{
                    name: CONTRACTS_TEXT_INDEX_NAME,
                    weights: { description: 1, contractingEntity: 1, awarded: 1 },
                }]
            },
            async dropIndex() {
                const err = new Error('index not found')
                err.code = 27
                err.codeName = 'IndexNotFound'
                throw err
            },
        }
        const result = await dropContractsTextIndex(collection)
        assert.equal(result.dropped, false)
        assert.equal(result.reason, 'already_absent')
    })

    it('no-ops without a collection', async () => {
        const result = await dropContractsTextIndex(null)
        assert.equal(result.dropped, false)
        assert.equal(result.reason, 'no_collection')
    })
})
