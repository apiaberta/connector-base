import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accentInsensitiveRegex } from '../src/accentRegex.js'
import { buildListQuery, toListItem } from '../src/contractsService.js'
import { LIST_PROJECTION } from '../src/queryLimits.js'

describe('accentInsensitiveRegex', () => {
    it('matches case- and accent-insensitively', () => {
        const re = accentInsensitiveRegex('Oeiras')
        assert.equal(re.test('Portugal - Lisboa - Oeiras'), true)
        assert.equal(re.test('PORTUGAL - LISBOA - OEIRAS'), true)
        assert.equal(re.test('Covilhã'), false)
    })

    it('matches accented input against unaccented data', () => {
        assert.equal(accentInsensitiveRegex('Covilhã').test('Portugal - Castelo Branco - Covilha'), true)
    })

    it('escapes metacharacters', () => {
        const re = accentInsensitiveRegex('S. João (x)')
        assert.equal(re.test('S. João (x)'), true)
        assert.equal(re.test('Sxjoao'), false)
    })
})

describe('buildListQuery with local', () => {
    it('adds the local clause', () => {
        const q = buildListQuery({ local: 'Oeiras' })
        assert.equal(q.local.test('Lisboa - Oeiras'), true)
    })

    it('applies the date window when no year is given', () => {
        const dateRange = { $gte: '2025-11-20', $lte: '2026-11-20' }
        const q = buildListQuery({ local: 'Oeiras', dateRange })
        assert.deepEqual(q.$and.find(c => 'date' in c), { date: dateRange })
    })

    it('a year overrides the default window', () => {
        const q = buildListQuery({ local: 'Oeiras', year: 2026, dateRange: { $gte: 'x', $lte: 'y' } })
        assert.deepEqual(q.$and[0], { date: { $gte: '2026-01-01', $lte: '2026-12-31' } })
        assert.equal(q.$and.length, 2)
    })

    it('without local, the query is unchanged', () => {
        assert.deepEqual(buildListQuery({ type: 'ajuste' }), { type: 'ajuste' })
    })
})

describe('list output includes local', () => {
    it('projects and returns local', () => {
        assert.equal(LIST_PROJECTION.local, 1)
        assert.equal(toListItem({ id: '1', local: 'Portugal - Lisboa - Oeiras' }).local, 'Portugal - Lisboa - Oeiras')
        assert.equal(toListItem({ id: '1' }).local, null)
    })
})
