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
Set BASE_API_KEY if you have IMPIC API access
npm start

## Environment

PORT: 3003
MONGO_URI: mongodb://localhost:27017/apiaberta-base
BASE_API_KEY: (optional) Official IMPIC API key

## Data Source

Important: The official BASE.gov.pt API requires registration with IMPIC.

To get API access:
1. Go to https://www.impic.pt/support/open.php
2. Select topic: Contratos Publicos / Pedido de acesso a API Portal Base
3. Wait for approval

Set your API key in BASE_API_KEY env var to enable live sync.
Without an API key, the connector uses a legacy endpoint that may return incomplete data.

## Sync

Data syncs daily at 03:00 Europe/Lisbon. Initial sync runs on startup.

## License

MIT
