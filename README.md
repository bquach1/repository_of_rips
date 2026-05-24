# repository_of_rips

React app for tracking card collection profit/loss by category (One Piece, Pokemon, Riftbound).

## Features

- Toggle between card game categories.
- TCGPlayer OAuth (`client_credentials`) form using the TCGPlayer token endpoint.
- Chase and Venmo spend sync forms (point to your own backend endpoints).
- Per-category P&L summary using:
  - collection cost basis
  - current market value
  - synced spend from Chase + Venmo

## Spend API shape expected by the app

Your backend spend endpoints should return either:

```json
[{ "amount": 34.5, "game": "Pokemon" }]
```

or:

```json
{
  "transactions": [{ "amount": 34.5, "category": "Pokemon" }]
}
```

`game`, `category`, `memo`, or `description` can contain `One Piece`, `Pokemon`, or `Riftbound`.

## Run locally

```bash
npm install
npm run dev
```

## Plaid Backend (Venmo + Chase Spend)

Python backend lives in `backend/` and provides endpoints for Plaid Link token creation, public token exchange, transaction sync, and spend totals.

Quick start:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Or run from repo root:

```bash
npm run backend:dev
```

Main endpoints:

- `POST /api/plaid/link-token`
- `POST /api/plaid/exchange-public-token`
- `POST /api/plaid/sync/{item_id}`
- `GET /api/spend/summary`
- `GET /api/spend/transactions`
- `GET /api/spend/frontend-shape`

## Collectr Portfolio Export (Playwright)

This repo includes a Playwright script that exports Collectr cards to JSON/CSV.

It is designed for public showcase profiles by default.

### 1. Set profile URL (public showcase)

Default URL:

```bash
https://app.getcollectr.com/showcase/profile/@palo90
```

You can override with `.env`:

```bash
COLLECTR_PORTFOLIO_URL=https://app.getcollectr.com/showcase/profile/@your_handle
```

### 2. (Optional) Add credentials only for private portfolio pages

```bash
COLLECTR_EMAIL=your_email_here
COLLECTR_PASSWORD=your_password_here
```

### 3. Run export

```bash
# one-time browser install
npm run collectr:install

# headless (best for scheduled runs)
npm run collectr:export

# headed browser (best for first run / MFA challenges)
npm run collectr:export:headed
```

Output files are written to `exports/`:

- `collectr-portfolio-YYYY-MM-DD.json`
- `collectr-portfolio-YYYY-MM-DD.csv`

The latest JSON is also synced to `public/collectr-portfolio-latest.json` so the React UI can render the real export data directly.

The script also saves login session state at `.auth/collectr-storage-state.json` to reduce repeated logins.

### Optional flags

```bash
node scripts/export-collectr-portfolio.mjs --json-only
node scripts/export-collectr-portfolio.mjs --csv-only
node scripts/export-collectr-portfolio.mjs --headed
node scripts/export-collectr-portfolio.mjs --out ./exports/weekly
node scripts/export-collectr-portfolio.mjs --url https://app.getcollectr.com/showcase/profile/@your_handle
```

### Weekly schedule example (macOS `cron`)

```bash
crontab -e
```

Run every Sunday at 8:00 AM:

```bash
0 8 * * 0 cd /Users/brucequach/Projects/repository_of_rips && /usr/bin/env npm run collectr:export >> /Users/brucequach/Projects/repository_of_rips/exports/collectr-weekly.log 2>&1
```
