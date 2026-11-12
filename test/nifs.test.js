import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    extractNifsFromLabel,
    invalidNifError,
    nifsFromDoc,
    normalizeNif,
} from '../src/nifs.js'

describe('normalizeNif', () => {
    it('accepts 9 digits and strips separators', () => {
        assert.equal(normalizeNif('519459369'), '519459369')
        assert.equal(normalizeNif('519 459 369'), '519459369')
        assert.equal(normalizeNif(null), null)
        assert.equal(normalizeNif('123'), null)
        assert.equal(normalizeNif('5194593690'), null)
        assert.equal(normalizeNif('BOUNDLESS'), null)
    })

    it('builds a 400 error', () => {
        const err = invalidNifError('abc')
        assert.equal(err.statusCode, 400)
        assert.match(err.message, /9 digits/)
    })
})

describe('extractNifsFromLabel', () => {
    it('parses NIF - Nome lines and ignores free text', () => {
        assert.deepEqual(
            extractNifsFromLabel('519459369 - BOUNDLESS INTELLIGENCE GROUP LDA'),
            ['519459369']
        )
        assert.deepEqual(
            extractNifsFromLabel('501501501 - Instituto\r\n500500500 - Fornecedor'),
            ['501501501', '500500500']
        )
        assert.deepEqual(extractNifsFromLabel('Aquisição 519459369 sem hífen'), [])
        assert.deepEqual(extractNifsFromLabel(''), [])
    })
})

describe('nifsFromDoc', () => {
    it('reads labels and structured entities', () => {
        const nifs = nifsFromDoc({
            contractingEntity: '501501501 - Instituto de Teste, EPE',
            awarded: '500500500 - Fornecedor',
            contractingEntities: [{ nif: '501501501' }],
            awardedEntities: [{ nif: '519459369', name: 'BOUNDLESS INTELLIGENCE GROUP LDA' }],
        })
        assert.deepEqual(nifs.contractingNifs, ['501501501'])
        assert.deepEqual(nifs.awardedNifs.sort(), ['500500500', '519459369'])
    })
})
