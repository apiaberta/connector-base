/**
 * Row-by-row XLSX reader. ExcelJS stream parser keeps the event loop free
 * and avoids loading the whole sheet into a JS array (the previous worker
 * posted the entire sheet back to the main thread).
 */

import ExcelJS from 'exceljs'

export function stringifyCell(value) {
    if (value == null || value === '') return ''
    if (value instanceof Date) return value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'string') return value
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) {
            return value.richText.map(part => part.text ?? '').join('')
        }
        if (value.result != null) return stringifyCell(value.result)
        if (value.text != null) return stringifyCell(value.text)
        if (typeof value.sharedString === 'string') return value.sharedString
    }
    return String(value)
}

export function rowToArray(row) {
    if (Array.isArray(row) && !(row.values)) {
        return row.map(stringifyCell)
    }
    const values = row?.values
    let max = 0
    if (Array.isArray(values)) max = Math.max(max, values.length - 1)
    if (typeof row?.cellCount === 'number') max = Math.max(max, row.cellCount)
    const out = Array(Math.max(max, 0)).fill('')
    if (Array.isArray(values)) {
        for (let i = 1; i < values.length; i++) {
            out[i - 1] = stringifyCell(values[i])
        }
    }
    if (typeof row?.eachCell === 'function') {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            if (colNumber >= 1) out[colNumber - 1] = stringifyCell(cell.value)
        })
    }
    return out
}

function* asRows(item) {
    // Older ExcelJS yielded arrays of rows from the async iterator.
    if (Array.isArray(item) && item.length && item[0] && typeof item[0].eachCell === 'function') {
        yield* item
        return
    }
    yield item
}

export async function* iterateXlsxRows(filePath) {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        styles: 'ignore',
        worksheets: 'emit',
        entries: 'ignore',
    })

    let sheetIndex = 0
    for await (const worksheetReader of reader) {
        sheetIndex += 1
        if (sheetIndex > 1) break
        for await (const item of worksheetReader) {
            for (const row of asRows(item)) {
                yield rowToArray(row)
            }
        }
    }
}
