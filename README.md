# API Aberta — Public Contracts Connector (BASE)

Portuguese public procurement data from BASE.gov.pt.

## Features

- Search public contracts
- Contract details with full-text search
- Entity information
- Statistical summaries
- Swagger documentation at /docs

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health check |
| GET | /meta | Service metadata with sync stats |
| GET | /docs | Swagger UI |
| GET | /base/contracts | Paginated contract list |
| GET | /base/contracts/search?q=termo | Full-text search |

## Setup

npm install
cp .env.example .env
Set BASE_API_KEY in .env if you have IMPIC API access (never commit the key)
npm start

## Environment

PORT: 3003
MONGO_URI: mongodb://localhost:27017/apiaberta-base
BASE_API_KEY: Official IMPIC API key, read only from process.env / .env. Leave empty to disable official API enrichment.

## Data Source

Important: The official BASE.gov.pt API requires registration with IMPIC.

To get API access:
1. Go to https://www.impic.pt/support/open.php
2. Select topic: Contratos Publicos / Pedido de acesso a API Portal Base
3. Wait for approval

Set BASE_API_KEY in .env to enable live official-API lookup.
Without it, official BASE.gov.pt API enrichment is disabled; bulk sync still uses public dados.gov.pt XLSX files.

www.base.gov.pt serves an incomplete TLS chain. The client adds the bundled intermediate in `certs/base-gov-intermediate.pem` to the system roots (verification stays on). Check a live call with `npm run check:base`.

## Sync

Data syncs daily at 03:00 Europe/Lisbon. Initial sync runs on startup.

## License

MIT
