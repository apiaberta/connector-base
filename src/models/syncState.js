import mongoose from 'mongoose'

const syncStateSchema = new mongoose.Schema({
    _id: { type: String, default: 'base' },
    last_attempt: Date,
    last_success: Date,
    last_error: { type: String, default: null },
    last_xlsx_success: Date,
    last_v2_success: Date,
    nif_backfill_at: Date,
}, {
    collection: 'sync_state',
    versionKey: false,
})

export const SyncState = mongoose.model('SyncState', syncStateSchema)
