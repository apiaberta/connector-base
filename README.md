# API Aberta — Public Contracts Connector (BASE)

Portuguese public procurement data from BASE.gov.pt.

## Features

- Search public contracts (full-text and NIF)
- Contract details with official API enrichment via APIBase2-V2
- Live NIF fallback when the local cache is empty or stale (>48h)
- Daily incremental sync via APIBase2-V2 (`numDias`, max 90)
- Bulk / catch-up from dados.gov.pt XLSX with streaming parse
- Swagger documentation at /docs

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health check |
| GET | /base/meta | Service metadata with sync stats (`last_sync`, `last_attempt`, `last_success`, `last_error`) |
| GET | /docs | Swagger UI |
| GET | /base/contracts | Paginated contract list (`page`, `limit`, `type`, `year`, `nif`) |
| GET | /base/contracts/search?q=termo | Full-text search; `nif` (9 digits) also accepted; a 9-digit `q` is treated as NIF |
| GET | /base/contracts/lookup/:id | Live official API detail (APIBase2-V2), MongoDB fallback |

List and search responses include `source: "local" | "live"`. If the official API fails, the handler returns local results with `warning` and HTTP 200 — never 500.

`nif` must be exactly 9 digits. It matches both the contracting entity (adjudicante) and the awarded supplier (adjudicatário), using indexed `contractingNifs` / `awardedNifs` extracted from `"NIF - Nome"` labels and from V2 structured fields.

## Setup

```
npm install
cp .env.example .env
```

Set `BASE_API_KEY` in `.env` if you have IMPIC API access (never commit the key).

```
npm start
npm test
```

## Environment

- `PORT`: 3003
- `MONGO_URI`: mongodb://localhost:27017/apiaberta-base
- `BASE_API_KEY`: Official IMPIC API key, read only from process.env / .env. Leave empty to disable official API enrichment, live NIF fallback, and V2 incremental sync. XLSX sync still runs.

## Data Source

Bulk / catch-up sync uses public dados.gov.pt XLSX files (recommended by IMPIC for initial load). Files are downloaded to disk and parsed **row-by-row** (ExcelJS stream) so an ~80 MB yearly sheet cannot block the event loop or clone the whole workbook into RAM. Download size cap is 250 MB; exceeding it, a missing current-year file, or a parse failure is recorded as a **sync error** (`last_error`) — never as `synced: 0` success.

Official live enrichment and incremental updates use **APIBase2-V2**:

- Docs: https://www.base.gov.pt/APIBase2V2
- Auth header: `_AcessToken` (official typo, unchanged)
- Previous path `/APIBase2` is discontinued on **2026-12-04**

### What V2 allows

| Capability | Supported? |
|------------|------------|
| Contract by `idContrato` | Yes (`GetInfoContrato`) |
| Contracts by entity NIF (`nifEntidade`) | Yes (adjudicante or adjudicatário) |
| Last N days (`numDias`, max 90) | Yes — not an arbitrary from/to range |
| Whole calendar year (`Ano`) | Yes (full-year dump; used only as a query param, not for bulk ingest) |
| Free-text search | **No** |
| Pagination | **No** |

To get API access:
1. Go to https://www.impic.pt/support/open.php
2. Select topic: Contratos Publicos / Pedido de acesso a API Portal Base
3. Wait for approval

Set `BASE_API_KEY` in `.env` to enable live official-API lookup, NIF fallback, and daily V2 incremental sync.
Without it those paths stay off (no error); bulk sync still uses public dados.gov.pt XLSX files.

www.base.gov.pt serves an incomplete TLS chain. The client adds the bundled intermediate in `certs/base-gov-intermediate.pem` to the system roots (verification stays on). Check a live call with `npm run check:base` (requires `BASE_API_KEY`).

`GET /base/contracts/lookup/:id` keeps the previous public strings (`contractingEntity`, `awarded`, `cpv` as `"NIF - Nome"` / `"code - description"`) and adds structured V2 fields (`contractingEntities`, `awardedEntities`, `cpvs`, lots, invited entities, contract status, estimated procedure price, occurrences).

## Sync

Daily at 03:00 Europe/Lisbon:

1. **V2 incremental** (if `BASE_API_KEY` is set): `GetInfoContrato?numDias=N` where N is days since `last_success` plus one day of overlap, capped at 90. V2 cannot list by an arbitrary date interval, so a gap older than 90 days is filled from XLSX.
2. **XLSX catch-up** when there is no API key, V2 failed, or `last_success` is more than 90 days ago. Initial load uses XLSX backfill (current year + one missing historical year per run).

A NIF backfill (idempotent, indexed `contractingNifs` / `awardedNifs`) runs on startup without blocking listen, and again at the start of each sync.

`/base/meta` `stats`:

- `last_sync` / `last_success` — last fully successful run
- `last_attempt` — last run start
- `last_error` — last failure message (size-cap skip, download/parse error, V2 error); `null` after a clean run

## License

MIT
