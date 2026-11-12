import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import ExcelJS from 'exceljs'
import { iterateXlsxRows, stringifyCell } from '../src/xlsxStream.js'
import { mapColumns, rowToDoc, sizeCapError, syncYear, v2WindowDays } from '../src/sync.js'
import { V2_FETCH_MAX_DAYS, V2_MAX_DAYS } from '../src/queryLimits.js'
import { createMemoryContract } from './helpers.js'

describe('stringifyCell / mapColumns / rowToDoc', () => {
    it('maps objectoContrato despite the historical typo alias', () => {
        const cols = mapColumns(['idcontrato', 'objectoContrato', 'adjudicante', 'adjudicatarios'])
        assert.equal(cols.idcontrato, 0)
        assert.equal(cols.objectoContrato, 1)
        assert.equal(cols.adjudicante, 2)
    })

    it('extracts NIFs from every NIF - Nome line, display stays first line', () => {
        const cols = mapColumns([
            'idcontrato', 'objectoContrato', 'adjudicante', 'adjudicatarios',
            'dataPublicacao', 'precoContratual', 'tipoprocedimento',
        ])
        const doc = rowToDoc([
            '42',
            'Serviços de IA',
            '501501501 - Instituto',
            '519459369 - BOUNDLESS INTELLIGENCE GROUP LDA\r\n500500500 - Outro',
            '2026-06-08',
            1500,
            'Ajuste direto',
        ], 2026, cols)
        assert.equal(doc.id, '42')
        assert.equal(doc.awarded, '519459369 - BOUNDLESS INTELLIGENCE GROUP LDA')
        assert.deepEqual(doc.awardedNifs, ['519459369', '500500500'])
        assert.deepEqual(doc.contractingNifs, ['501501501'])
        assert.equal(doc.date, '2026-06-08')
        assert.equal(doc.nifsBackfilled, true)
    })

    it('stringifyCell flattens rich text', () => {
        assert.equal(stringifyCell({ richText: [{ text: 'A' }, { text: 'B' }] }), 'AB')
        assert.equal(stringifyCell(null), '')
    })

    it('size cap failures are errors, never a silent zero', () => {
        const err = sizeCapError(81_911_000, 2026)
        assert.equal(err instanceof Error, true)
        assert.match(err.message, /exceeds size cap/)
        assert.match(err.message, /2026/)
        assert.match(err.message, /78\.1 MB/)
    })

    it('v2 window is last-N-days, capped below the API max of 90', () => {
        assert.equal(V2_MAX_DAYS, 90)
        assert.equal(v2WindowDays(null), V2_FETCH_MAX_DAYS)
        const now = Date.parse('2026-11-12T00:00:00Z')
        assert.equal(v2WindowDays('2026-11-11T00:00:00Z', now), 2)
        assert.equal(v2WindowDays('2026-07-08T00:00:00Z', now), V2_FETCH_MAX_DAYS)
        assert.ok(V2_FETCH_MAX_DAYS < V2_MAX_DAYS)
    })
})

describe('iterateXlsxRows + syncYear', () => {
    let dir

    after(async () => {
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('streams rows and upserts with nifs without loading the whole sheet', async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'xlsx-stream-'))
        const file = path.join(dir, 'contratos2026.xlsx')
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('Sheet1')
        ws.addRow([
            'idcontrato', 'objectoContrato', 'adjudicante', 'adjudicatarios',
            'dataPublicacao', 'precoContratual', 'tipoprocedimento',
        ])
        ws.addRow([
            '99', 'Serviço', '501501501 - Instituto',
            '519459369 - BOUNDLESS INTELLIGENCE GROUP LDA',
            '2026-06-08', 1000, 'Ajuste direto',
        ])
        await wb.xlsx.writeFile(file)

        const rows = []
        for await (const row of iterateXlsxRows(file)) rows.push(row)
        assert.equal(rows.length, 2)
        assert.equal(String(rows[0][0]).toLowerCase(), 'idcontrato')
        assert.equal(String(rows[1][0]), '99')

        const Model = createMemoryContract()
        const count = await syncYear(2026, file, null, 50, { Model })
        assert.equal(count, 1)
        assert.equal(Model.store[0].id, '99')
        assert.deepEqual(Model.store[0].awardedNifs, ['519459369'])
    })

    it('empty xlsx is an error, not synced: 0', async () => {
        dir = dir || await mkdtemp(path.join(tmpdir(), 'xlsx-stream-'))
        const empty = path.join(dir, 'empty.xlsx')
        await assert.rejects(() => syncYear(2026, empty, null), /missing or empty/)
    })
})
