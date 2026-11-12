import { Contract } from './models/contract.js'
import { getSyncFreshness } from './syncState.js'

export async function metaRoutes(app) {
    app.get('/base/meta', {
        schema: {
            description: 'Metadata and stats for the BASE connector, including last sync attempt/success/error',
            tags: ['Contracts'],
        },
    }, async () => {
        const [contractCount, freshness] = await Promise.all([
            Contract.estimatedDocumentCount(),
            getSyncFreshness(),
        ])
        return {
            connector: 'connector-base',
            version: '1.4.0',
            description: 'Portuguese public contracts from BASE.gov.pt (APIBase2-V2; V1 discontinued 2026-12-04)',
            source: 'https://www.base.gov.pt/APIBase2V2',
            update_freq: 'Daily at 03:00 Europe/Lisbon (V2 incremental + XLSX catch-up)',
            endpoints: [
                { path: '/v1/base/contracts', description: 'Paginated recent contracts (nif, type, year)' },
                { path: '/v1/base/contracts/search', description: 'Full-text and NIF search over contracts' },
            ],
            stats: {
                contracts: contractCount,
                last_sync: freshness.last_success,
                last_attempt: freshness.last_attempt,
                last_success: freshness.last_success,
                last_error: freshness.last_error,
            },
        }
    })
}
