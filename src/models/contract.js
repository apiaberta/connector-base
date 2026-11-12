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
contractSchema.index({ description: 'text', contractingEntity: 'text', awarded: 'text' })
contractSchema.index({ value: -1 })
contractSchema.index({ date: -1 })
contractSchema.index({ contractingNifs: 1 })
contractSchema.index({ awardedNifs: 1 })
contractSchema.index({ nifsBackfilled: 1 })

export const Contract = mongoose.model('Contract', contractSchema)
