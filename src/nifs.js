/**
 * Portuguese NIF helpers. Public labels are `"NIF - Nome"` (one entity per
 * line); V2 also exposes structured `nifEntContrato` / `NIPCEntidade`.
 */

const NIF_DIGITS = /^\d{9}$/
const LABEL_NIF = /^(\d{9})\s*[-–—]/

export function normalizeNif(value) {
    if (value == null || value === '') return null
    const digits = String(value).trim().replace(/[\s.\-]/g, '')
    return NIF_DIGITS.test(digits) ? digits : null
}

export function invalidNifError(value) {
    const err = new Error('nif must be exactly 9 digits')
    err.statusCode = 400
    err.details = { nif: value }
    return err
}

/**
 * Extract 9-digit NIFs from `"NIF - Nome"` labels. Multi-line fields
 * (adjudicante / adjudicatarios joined with newlines) are split first.
 * Does not scan free text for stray 9-digit sequences.
 */
export function extractNifsFromLabel(label) {
    if (label == null || label === '') return []
    if (Array.isArray(label)) {
        return unique(label.flatMap(extractNifsFromLabel))
    }
    const found = []
    for (const line of String(label).split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const match = trimmed.match(LABEL_NIF)
        if (match) found.push(match[1])
    }
    return unique(found)
}

export function nifsFromEntities(entities) {
    if (!entities) return []
    const list = Array.isArray(entities) ? entities : [entities]
    const found = []
    for (const entity of list) {
        if (entity == null) continue
        if (typeof entity === 'string') {
            found.push(...extractNifsFromLabel(entity))
            continue
        }
        const nif = normalizeNif(
            entity.nif
            ?? entity.nifEntContrato
            ?? entity.NIPCEntidade
            ?? entity.nifEntidade
        )
        if (nif) found.push(nif)
        else if (entity.label) found.push(...extractNifsFromLabel(entity.label))
    }
    return unique(found)
}

export function nifsFromDoc(doc) {
    const contractingNifs = unique([
        ...nifsFromEntities(doc?.contractingEntities),
        ...extractNifsFromLabel(doc?.contractingEntity),
    ])
    const awardedNifs = unique([
        ...nifsFromEntities(doc?.awardedEntities),
        ...extractNifsFromLabel(doc?.awarded),
    ])
    return { contractingNifs, awardedNifs }
}

export function withNifs(doc) {
    const { contractingNifs, awardedNifs } = nifsFromDoc(doc)
    return { ...doc, contractingNifs, awardedNifs, nifsBackfilled: true }
}

function unique(list) {
    return [...new Set(list.filter(Boolean))]
}
