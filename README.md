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
[
  { "amount": 34.5, "game": "Pokemon" }
]
```

or:

```json
{
  "transactions": [
    { "amount": 34.5, "category": "Pokemon" }
  ]
}
```

`game`, `category`, `memo`, or `description` can contain `One Piece`, `Pokemon`, or `Riftbound`.

## Run locally

```bash
npm install
npm run dev
```
