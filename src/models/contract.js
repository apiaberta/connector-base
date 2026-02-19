import mongoose from 'mongoose'

const contractSchema = new mongoose.Schema({
  id:                { type: String, required: true, unique: true },
  description:       String,
  contractingEntity: String,
  awarded:           String,
  value:             Number,
  date:              String,
  type:              String,
  synced_at:         { type: Date, default: Date.now }
})

contractSchema.index({ synced_at: -1 })
contractSchema.index({ description: 'text', contractingEntity: 'text', awarded: 'text' })
contractSchema.index({ value: -1 })
contractSchema.index({ date: -1 })

export const Contract = mongoose.model('Contract', contractSchema)
