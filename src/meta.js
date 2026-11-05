import { Contract } from './models/contract.js'

export async function metaRoutes(app) {
  app.get('/base/meta', {
    schema: {
      description: 'Metadata and stats for the BASE connector',
      tags: ['Contracts']
    }
  }, async () => {
    const [contractCount, lastContract] = await Promise.all([
      Contract.countDocuments(),
      Contract.findOne().sort({ synced_at: -1 }).select('synced_at').lean()
    ])
    return {
      connector:   'connector-base',
      version:     '1.2.0',
      description: 'Portuguese public contracts from BASE.gov.pt (APIBase2-V2; V1 discontinued 2026-12-04)',
      source:      'https://www.base.gov.pt/APIBase2V2',
      update_freq: 'Daily at 03:00 Europe/Lisbon',
      endpoints: [
        { path: '/v1/base/contracts',        description: 'Paginated recent contracts' },
        { path: '/v1/base/contracts/search', description: 'Full-text search over contracts' }
      ],
      stats: {
        contracts: contractCount,
        last_sync: lastContract?.synced_at ?? null
      }
    }
  })
}
