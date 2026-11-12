import mongoose from 'mongoose'

const contractSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    description: String,
    contractingEntity: String,
    awarded: String,
    contractingNifs: { type: [String], default: undefined },
    awardedNifs: { type: [String], default: undefined },
    nifsBackfilled: Boolean,
    value: Number,
    date: String,
    type: String,
    ano: Number,
    local: String,
    cpv: String,
    fundamentacao: String,
    nAnuncio: String,
    synced_at: { type: Date, default: Date.now },
})

contractSchema.index({ synced_at: -1 })
contractSchema.index({ value: -1 })
contractSchema.index({ date: -1 })
contractSchema.index({ contractingNifs: 1 })
contractSchema.index({ awardedNifs: 1 })
contractSchema.index({ nifsBackfilled: 1 })

export const Contract = mongoose.model('Contract', contractSchema)

/** Mongoose default name for the old {description, contractingEntity, awarded} text index. */
export const CONTRACTS_TEXT_INDEX_NAME = 'description_text_contractingEntity_text_awarded_text'

function isContractsTextIndex(ix) {
    if (!ix) return false
    if (ix.name === CONTRACTS_TEXT_INDEX_NAME) return true
    const weights = ix.weights || {}
    if (weights.description && weights.contractingEntity && weights.awarded) return true
    const key = ix.key || {}
    return key.description === 'text' && key.contractingEntity === 'text' && key.awarded === 'text'
}

/**
 * Drop the ~886 MiB contracts text index if it still exists.
 *
 * Safe on a 2.2 M-doc collection: dropIndex is a metadata + file-unlink
 * operation, not a document scan, and does not build a replacement index.
 * Idempotent: IndexNotFound is a no-op success.
 *
 * Expected impact: about 886 MiB less index data on disk; WiredTiger and
 * the OS page cache no longer keep that index resident during $text
 * scans (the queries that examined 0.5–2.1 M keys and ran for hours).
 */
export async function dropContractsTextIndex(collection, logger) {
    if (!collection?.indexes || !collection?.dropIndex) {
        return { dropped: false, reason: 'no_collection' }
    }
    let indexes
    try {
        indexes = await collection.indexes()
    } catch (err) {
        logger?.warn({ err }, 'Could not list contracts indexes')
        return { dropped: false, reason: 'list_failed', error: err.message }
    }
    const found = (indexes || []).find(isContractsTextIndex)
    if (!found) {
        return { dropped: false, reason: 'already_absent' }
    }
    try {
        await collection.dropIndex(found.name)
        logger?.info(
            { index: found.name, expectedFreedMiB: 886 },
            'Dropped contracts text index'
        )
        return { dropped: true, index: found.name }
    } catch (err) {
        if (err.code === 27 || err.codeName === 'IndexNotFound' || /index not found/i.test(err.message || '')) {
            return { dropped: false, reason: 'already_absent', index: found.name }
        }
        throw err
    }
}
