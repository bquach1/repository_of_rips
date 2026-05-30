from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .database import (
    delete_transactions_by_ids,
    get_item,
    init_db,
    list_items,
    query_spend_summary,
    query_transactions,
    set_account_source,
    upsert_plaid_item,
    upsert_transaction,
)
from .plaid_service import (
    create_link_token,
    exchange_public_token,
    infer_source,
    sync_transactions,
)
from .schemas import (
    AccountSourceMapRequest,
    ExchangePublicTokenRequest,
    LinkTokenRequest,
)
from .settings import settings

app = FastAPI(title="Plaid Spend Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _sync_item_internal(item_id: str) -> dict:
    item = get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Unknown item_id")

    access_token = item["access_token"]
    institution_name = item.get("institution_name")
    source_hint = item.get("source_hint")

    cursor = None
    total_added = 0
    total_modified = 0
    total_removed = 0

    while True:
        response = sync_transactions(access_token=access_token, cursor=cursor)
        cursor = response.get("next_cursor")

        for tx in response.get("added", []):
            account_id = tx.get("account_id", "")
            upsert_transaction(
                {
                    "plaid_transaction_id": tx["transaction_id"],
                    "item_id": item_id,
                    "account_id": account_id,
                    "account_name": tx.get("account_owner")
                    or tx.get("authorized_datetime")
                    or "",
                    "merchant_name": tx.get("merchant_name") or "",
                    "description": tx.get("name") or "",
                    "amount": float(tx.get("amount") or 0),
                    "iso_currency_code": tx.get("iso_currency_code") or "USD",
                    "date": tx.get("date"),
                    "pending": bool(tx.get("pending")),
                    "source": infer_source(
                        institution_name=institution_name,
                        account_id=account_id,
                        account_name=tx.get("account_owner"),
                        merchant_name=tx.get("merchant_name"),
                        description=tx.get("name"),
                        source_hint=source_hint,
                    ),
                    "raw": tx,
                }
            )
            total_added += 1

        for tx in response.get("modified", []):
            account_id = tx.get("account_id", "")
            upsert_transaction(
                {
                    "plaid_transaction_id": tx["transaction_id"],
                    "item_id": item_id,
                    "account_id": account_id,
                    "account_name": tx.get("account_owner")
                    or tx.get("authorized_datetime")
                    or "",
                    "merchant_name": tx.get("merchant_name") or "",
                    "description": tx.get("name") or "",
                    "amount": float(tx.get("amount") or 0),
                    "iso_currency_code": tx.get("iso_currency_code") or "USD",
                    "date": tx.get("date"),
                    "pending": bool(tx.get("pending")),
                    "source": infer_source(
                        institution_name=institution_name,
                        account_id=account_id,
                        account_name=tx.get("account_owner"),
                        merchant_name=tx.get("merchant_name"),
                        description=tx.get("name"),
                        source_hint=source_hint,
                    ),
                    "raw": tx,
                }
            )
            total_modified += 1

        removed_ids = [r["transaction_id"] for r in response.get("removed", [])]
        total_removed += delete_transactions_by_ids(removed_ids)

        if not response.get("has_more"):
            break

    return {
        "item_id": item_id,
        "added": total_added,
        "modified": total_modified,
        "removed": total_removed,
    }


def _maybe_auto_sync(
    start_date: str | None,
    end_date: str | None,
    include_pending: bool,
    source: str | None = None,
) -> dict:
    existing = query_transactions(
        source=source,
        start_date=start_date,
        end_date=end_date,
        include_pending=include_pending,
        limit=1,
    )
    if existing:
        return {
            "auto_sync_attempted": False,
            "auto_sync_performed": False,
            "linked_items": len(list_items()),
            "auto_sync_results": [],
        }

    items = list_items()
    if not items:
        return {
            "auto_sync_attempted": True,
            "auto_sync_performed": False,
            "linked_items": 0,
            "auto_sync_results": [],
            "note": "No linked Plaid items. Complete link-token + exchange-public-token first.",
        }

    results = []
    for item in items:
        results.append(_sync_item_internal(item["item_id"]))

    return {
        "auto_sync_attempted": True,
        "auto_sync_performed": True,
        "linked_items": len(items),
        "auto_sync_results": results,
    }


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/plaid/link-token")
def api_create_link_token(payload: LinkTokenRequest) -> dict:
    try:
        return create_link_token(payload.user_id)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/plaid/exchange-public-token")
def api_exchange_public_token(payload: ExchangePublicTokenRequest) -> dict:
    try:
        exchanged = exchange_public_token(payload.public_token)
        item_id = exchanged["item_id"]
        upsert_plaid_item(
            item_id=item_id,
            access_token=exchanged["access_token"],
            institution_name=payload.institution_name,
            user_id=payload.user_id,
            source_hint=payload.source_hint,
        )
        return {"item_id": item_id}
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/plaid/items")
def api_list_items() -> dict:
    return {"items": list_items()}


@app.post("/api/plaid/sync/{item_id}")
def api_sync_item(item_id: str) -> dict:
    try:
        return _sync_item_internal(item_id)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/accounts/source-map")
def api_set_account_source(payload: AccountSourceMapRequest) -> dict:
    source = payload.source.lower().strip()
    if source not in {"venmo", "chase", "other"}:
        raise HTTPException(status_code=400, detail="source must be venmo|chase|other")

    set_account_source(payload.account_id, source)
    return {"status": "ok", "account_id": payload.account_id, "source": source}


@app.get("/api/spend/summary")
def api_spend_summary(
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    include_pending: bool = Query(default=False),
    auto_sync: bool = Query(default=True),
) -> dict:
    auto_sync_meta = {
        "auto_sync_attempted": False,
        "auto_sync_performed": False,
        "linked_items": len(list_items()),
        "auto_sync_results": [],
    }
    if auto_sync:
        auto_sync_meta = _maybe_auto_sync(
            start_date=start_date,
            end_date=end_date,
            include_pending=include_pending,
        )

    summary = query_spend_summary(
        start_date=start_date,
        end_date=end_date,
        include_pending=include_pending,
    )
    return {
        "start_date": start_date,
        "end_date": end_date,
        "include_pending": include_pending,
        "auto_sync": auto_sync,
        **summary,
        **auto_sync_meta,
    }


@app.get("/api/spend/transactions")
def api_spend_transactions(
    source: str | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    include_pending: bool = Query(default=False),
    limit: int = Query(default=200, ge=1, le=1000),
    auto_sync: bool = Query(default=True),
) -> dict:
    normalized_source = source.lower() if source else None
    if normalized_source and normalized_source not in {"venmo", "chase", "other"}:
        raise HTTPException(status_code=400, detail="source must be venmo|chase|other")

    auto_sync_meta = {
        "auto_sync_attempted": False,
        "auto_sync_performed": False,
        "linked_items": len(list_items()),
        "auto_sync_results": [],
    }
    if auto_sync:
        auto_sync_meta = _maybe_auto_sync(
            source=normalized_source,
            start_date=start_date,
            end_date=end_date,
            include_pending=include_pending,
        )

    rows = query_transactions(
        source=normalized_source,
        start_date=start_date,
        end_date=end_date,
        include_pending=include_pending,
        limit=limit,
    )
    return {
        "transactions": rows,
        "auto_sync": auto_sync,
        **auto_sync_meta,
    }


@app.get("/api/spend/frontend-shape")
def api_spend_frontend_shape(
    source: str | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    include_pending: bool = Query(default=False),
    auto_sync: bool = Query(default=True),
) -> dict:
    normalized_source = source.lower() if source else None
    auto_sync_meta = {
        "auto_sync_attempted": False,
        "auto_sync_performed": False,
        "linked_items": len(list_items()),
        "auto_sync_results": [],
    }
    if auto_sync:
        auto_sync_meta = _maybe_auto_sync(
            source=normalized_source,
            start_date=start_date,
            end_date=end_date,
            include_pending=include_pending,
        )

    rows = query_transactions(
        source=normalized_source,
        start_date=start_date,
        end_date=end_date,
        include_pending=include_pending,
        limit=5000,
    )

    payload = [
        {
            "amount": tx["amount"],
            "category": tx["source"].capitalize(),
            "description": tx.get("description") or tx.get("merchant_name") or "",
            "date": tx["date"],
        }
        for tx in rows
    ]
    return {
        "transactions": payload,
        "auto_sync": auto_sync,
        **auto_sync_meta,
    }
