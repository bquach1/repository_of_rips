# Plaid Spend Backend (Python)

FastAPI backend for connecting Plaid accounts and calculating spend totals, with specific tagging for `venmo` and `chase`.

## What it provides

- `POST /api/plaid/link-token`: Create a Plaid Link token for frontend Plaid Link flow.
- `POST /api/plaid/exchange-public-token`: Exchange Plaid `public_token` for `access_token` and store item.
- `POST /api/plaid/sync/{item_id}`: Pull transactions via `transactions/sync` and save locally.
- `POST /api/accounts/source-map`: Manually map account IDs to `venmo|chase|other`.
- `GET /api/spend/summary`: Return total spend and spend by source.
- `GET /api/spend/transactions`: Return normalized transactions.
- `GET /api/spend/frontend-shape`: Returns `{ transactions: [...] }` payload useful for frontend spend sync.

## Setup

1. Create a virtual environment and install dependencies.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Create env file.

```bash
cp .env.example .env
```

3. Fill Plaid credentials in `.env`.

- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV` (`sandbox`, `development`, or `production`)

4. Run API server.

```bash
uvicorn app.main:app --reload --port 8000
```

## Notes

- Data is stored in SQLite (`backend/plaid_spend.db` by default).
- Spend summary counts positive transaction amounts (`amount > 0`).
- `source` is inferred by text matching (`venmo`, `chase`) unless overridden via `/api/accounts/source-map`.
- Venmo transactions are enriched with `is_card_related` and supporting metadata using:
  - known counterparties (`VENMO_CARD_COUNTERPARTIES`)
  - card keywords (`VENMO_CARD_KEYWORDS`)
  - non-card keywords (`VENMO_NON_CARD_KEYWORDS`)
  - optional AI fallback for ambiguous notes (`VENMO_AI_ENABLED=true`, `OPENAI_API_KEY`, `OPENAI_MODEL`)
- Recommended flow:
  1. `POST /api/plaid/link-token`
  2. Frontend Plaid Link receives `public_token`
  3. `POST /api/plaid/exchange-public-token`
  4. `POST /api/plaid/sync/{item_id}`
  5. `GET /api/spend/summary`
