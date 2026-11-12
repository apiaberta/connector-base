export function createMemoryContract(docs = []) {
    const store = docs.map(doc => ({ ...doc }))

    function matches(doc, query) {
        if (!query || Object.keys(query).length === 0) return true
        if (query.$and) return query.$and.every(part => matches(doc, part))
        if (query.$or) return query.$or.some(part => matches(doc, part))
        if (query.$text) {
            const needle = String(query.$text.$search || '').toLowerCase()
            return [doc.description, doc.contractingEntity, doc.awarded]
                .some(value => String(value || '').toLowerCase().includes(needle))
        }
        for (const [key, spec] of Object.entries(query)) {
            if (key.startsWith('$')) continue
            if (!matchValue(doc[key], spec)) return false
        }
        return true
    }

    function matchValue(docVal, spec) {
        if (spec && typeof spec === 'object' && !Array.isArray(spec) && !(spec instanceof Date)) {
            if (spec.$regex != null) {
                return new RegExp(spec.$regex, spec.$options || '').test(String(docVal ?? ''))
            }
            if ('$ne' in spec) return docVal !== spec.$ne
            if ('$exists' in spec) {
                const exists = docVal !== undefined
                return spec.$exists ? exists : !exists
            }
            if (spec.$in) return spec.$in.includes(docVal)
        }
        if (Array.isArray(docVal)) return docVal.includes(spec)
        return docVal === spec
    }

    function query(rows) {
        const state = { rows }
        const api = {
            sort(spec) {
                const key = Object.keys(spec || {}).find(k => k !== 'score')
                if (!key) return api
                const dir = spec[key]
                const numeric = dir && typeof dir === 'object' ? -1 : dir
                state.rows = [...state.rows].sort((a, b) => {
                    if (a[key] < b[key]) return numeric < 0 ? 1 : -1
                    if (a[key] > b[key]) return numeric < 0 ? -1 : 1
                    return 0
                })
                return api
            },
            skip(n) {
                state.rows = state.rows.slice(n)
                return api
            },
            limit(n) {
                state.rows = state.rows.slice(0, n)
                return api
            },
            select() { return api },
            lean() { return api },
            then(resolve, reject) {
                return Promise.resolve(state.rows).then(resolve, reject)
            },
        }
        return api
    }

    return {
        store,
        find(filter) {
            return query(store.filter(doc => matches(doc, filter)))
        },
        countDocuments(filter) {
            return Promise.resolve(store.filter(doc => matches(doc, filter)).length)
        },
        findOne(filter) {
            const found = store.find(doc => matches(doc, filter)) || null
            return {
                sort() { return this },
                select() { return this },
                lean() { return Promise.resolve(found) },
                then(resolve, reject) { return Promise.resolve(found).then(resolve, reject) },
            }
        },
        async bulkWrite(ops) {
            for (const op of ops) {
                const filter = op.updateOne.filter
                const set = op.updateOne.update.$set
                const idx = store.findIndex(doc => doc.id === filter.id)
                if (idx >= 0) store[idx] = { ...store[idx], ...set }
                else if (op.updateOne.upsert) store.push({ id: filter.id, ...set })
            }
            return { ok: 1 }
        },
    }
}

export function jsonResponse(records) {
    return {
        ok: true,
        status: 200,
        async json() { return records },
        async text() { return JSON.stringify(records) },
    }
}
