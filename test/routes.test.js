import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { baseRoutes } from '../src/routes.js'

async function build(opts) {
    const app = Fastify({ logger: false })
    await app.register(baseRoutes, { prefix: '/base', ...opts })
    await app.ready()
    return app
}

describe('GET /base/contracts nif filter', () => {
    it('rejects a non-9-digit nif before hitting the service', async () => {
        let called = 0
        const app = await build({
            listContracts: async () => {
                called += 1
                return { total: 0, page: 1, limit: 25, pages: 0, source: 'local', data: [] }
            },
        })
        const res = await app.inject({ method: 'GET', url: '/base/contracts?nif=abc' })
        assert.equal(res.statusCode, 400)
        assert.equal(called, 0)
        await app.close()
    })

    it('forwards nif and returns source from the service', async () => {
        const app = await build({
            listContracts: async (query) => {
                assert.equal(query.nif, '519459369')
                return {
                    total: 0,
                    page: 1,
                    limit: 25,
                    pages: 0,
                    source: 'live',
                    data: [],
                }
            },
        })
        const res = await app.inject({ method: 'GET', url: '/base/contracts?nif=519459369' })
        assert.equal(res.statusCode, 200)
        const body = res.json()
        assert.equal(body.source, 'live')
        await app.close()
    })

    it('accepts nif on /contracts/search without q', async () => {
        const app = await build({
            searchContracts: async (query) => {
                assert.equal(query.nif, '519459369')
                return {
                    query: '519459369',
                    total: 0,
                    page: 1,
                    limit: 25,
                    pages: 0,
                    source: 'local',
                    data: [],
                }
            },
        })
        const res = await app.inject({ method: 'GET', url: '/base/contracts/search?nif=519459369' })
        assert.equal(res.statusCode, 200)
        assert.equal(res.json().source, 'local')
        await app.close()
    })
})
