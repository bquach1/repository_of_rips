from __future__ import annotations

import json
import logging
import re
import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .database import (
    delete_transactions_by_ids,
    get_item,
    init_db,
    list_transactions_for_item,
    list_items,
    query_transaction_date_bounds,
    query_spend_summary,
    query_transactions,
    set_account_source,
    update_transaction_source,
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
    ReclassifySourcesRequest,
)
from .settings import settings
from .venmo_classifier import classify_venmo_transaction

logger = logging.getLogger(__name__)

SYNC_COOLDOWN_SECONDS = 45
_LAST_SYNC_BY_ITEM: dict[str, float] = {}
LINK_TOKEN_COOLDOWN_SECONDS = 30
_LAST_LINK_TOKEN_REQUEST_AT: dict[str, float] = {}

app = FastAPI(title="Plaid Spend Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _extract_plaid_error(exc: Exception) -> dict | None:
    body = getattr(exc, "body", None)
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="ignore")

    if isinstance(body, str) and body.strip():
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    text = str(exc)
    if "ITEM_LOGIN_REQUIRED" in text:
        return {
            "error_code": "ITEM_LOGIN_REQUIRED",
            "error_message": (
                "Item requires re-authentication in Plaid Link update mode."
            ),
        }
    return None


def _sync_cooldown_remaining(item_id: str) -> int:
    last_sync = _LAST_SYNC_BY_ITEM.get(item_id)
    if last_sync is None:
        return 0

    elapsed = time.time() - last_sync
    remaining = SYNC_COOLDOWN_SECONDS - elapsed
    if remaining <= 0:
        return 0
    return int(remaining) if remaining.is_integer() else int(remaining) + 1


def _mark_item_synced_now(item_id: str) -> None:
    _LAST_SYNC_BY_ITEM[item_id] = time.time()


def _link_token_key(user_id: str, reconnect_item_id: str | None) -> str:
    suffix = reconnect_item_id or "new"
    return f"{user_id}:{suffix}"


def _link_token_cooldown_remaining(user_id: str, reconnect_item_id: str | None) -> int:
    key = _link_token_key(user_id, reconnect_item_id)
    last_request = _LAST_LINK_TOKEN_REQUEST_AT.get(key)
    if last_request is None:
        return 0

    elapsed = time.time() - last_request
    remaining = LINK_TOKEN_COOLDOWN_SECONDS - elapsed
    if remaining <= 0:
        return 0
    return int(remaining) if remaining.is_integer() else int(remaining) + 1


def _mark_link_token_requested(user_id: str, reconnect_item_id: str | None) -> None:
    _LAST_LINK_TOKEN_REQUEST_AT[_link_token_key(user_id, reconnect_item_id)] = (
        time.time()
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
        request_cursor = cursor
        response = sync_transactions(access_token=access_token, cursor=request_cursor)
        cursor = response.get("next_cursor")

        for tx in response.get("added", []):
            account_id = tx.get("account_id", "")
            source = infer_source(
                institution_name=institution_name,
                account_id=account_id,
                account_name=tx.get("account_owner"),
                merchant_name=tx.get("merchant_name"),
                description=tx.get("name"),
                source_hint=source_hint,
            )

            if source == "zelle":
                _log_zelle_transaction(
                    tx=tx, item_id=item_id, institution_name=institution_name
                )

            upsert_transaction(
                {
                    "plaid_transaction_id": tx["transaction_id"],
                    "item_id": item_id,
                    "account_id": account_id,
                    "account_name": tx.get("account_owner") or "",
                    "merchant_name": tx.get("merchant_name") or "",
                    "description": tx.get("name") or "",
                    "amount": float(tx.get("amount") or 0),
                    "iso_currency_code": tx.get("iso_currency_code") or "USD",
                    "date": tx.get("date"),
                    "pending": bool(tx.get("pending")),
                    "source": source,
                    "raw": tx,
                }
            )
            total_added += 1

        for tx in response.get("modified", []):
            account_id = tx.get("account_id", "")
            source = infer_source(
                institution_name=institution_name,
                account_id=account_id,
                account_name=tx.get("account_owner"),
                merchant_name=tx.get("merchant_name"),
                description=tx.get("name"),
                source_hint=source_hint,
            )
            if source == "zelle":
                _log_zelle_transaction(
                    tx=tx, item_id=item_id, institution_name=institution_name
                )
            upsert_transaction(
                {
                    "plaid_transaction_id": tx["transaction_id"],
                    "item_id": item_id,
                    "account_id": account_id,
                    "account_name": tx.get("account_owner") or "",
                    "merchant_name": tx.get("merchant_name") or "",
                    "description": tx.get("name") or "",
                    "amount": float(tx.get("amount") or 0),
                    "iso_currency_code": tx.get("iso_currency_code") or "USD",
                    "date": tx.get("date"),
                    "pending": bool(tx.get("pending")),
                    "source": source,
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


def _extract_zelle_counterparty(description: str, merchant_name: str) -> str:
    text = (description or "").strip()
    merchant = (merchant_name or "").strip()

    patterns = [
        r"zelle\s+(?:payment|transfer)?\s*to\s+(.+)$",
        r"zelle\s+(?:payment|transfer)?\s*from\s+(.+)$",
        r"(?:to|from)\s+(.+?)\s+zelle",
    ]
    lowered = text.lower()
    for pattern in patterns:
        match = re.search(pattern, lowered)
        if not match:
            continue

        raw_counterparty = match.group(1).strip(" .,-")
        if raw_counterparty:
            return raw_counterparty.title()

    if merchant and merchant.lower() != "zelle":
        return merchant

    return ""


def _log_zelle_transaction(
    tx: dict, item_id: str, institution_name: str | None
) -> None:
    amount = float(tx.get("amount") or 0)
    description = str(tx.get("name") or "")
    merchant_name = str(tx.get("merchant_name") or "")
    account_owner = str(tx.get("account_owner") or "")
    counterparty = _extract_zelle_counterparty(description, merchant_name)
    direction = "sent" if amount >= 0 else "received"

    payload = {
        "event": "zelle_transaction_detected",
        "item_id": item_id,
        "institution_name": institution_name,
        "plaid_transaction_id": tx.get("transaction_id"),
        "date": tx.get("date"),
        "amount": amount,
        "direction": direction,
        "counterparty": counterparty,
        "description": description,
        "merchant_name": merchant_name,
        "account_owner": account_owner,
        "raw": tx,
    }
    logger.info(json.dumps(payload, separators=(",", ":"), default=str))


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
        bounds = query_transaction_date_bounds(
            source=source,
            include_pending=include_pending,
        )
        needs_sync_for_range = False

        if bounds:
            min_date = bounds.get("min_date")
            max_date = bounds.get("max_date")

            if start_date and min_date and start_date < min_date:
                needs_sync_for_range = True
            if end_date and max_date and end_date > max_date:
                needs_sync_for_range = True

        if not needs_sync_for_range:
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
        cooldown_remaining = _sync_cooldown_remaining(item["item_id"])
        if cooldown_remaining > 0:
            results.append(
                {
                    "item_id": item["item_id"],
                    "skipped": True,
                    "reason": "sync_cooldown_active",
                    "retry_after_seconds": cooldown_remaining,
                }
            )
            continue

        _mark_item_synced_now(item["item_id"])
        try:
            results.append(_sync_item_internal(item["item_id"]))
        except HTTPException as exc:
            detail = (
                exc.detail
                if isinstance(exc.detail, dict)
                else {"message": str(exc.detail)}
            )
            results.append(
                {
                    "item_id": item["item_id"],
                    "error": detail,
                }
            )
        except Exception as exc:  # pragma: no cover
            plaid_error = _extract_plaid_error(exc)
            if plaid_error and plaid_error.get("error_code") == "ITEM_LOGIN_REQUIRED":
                plaid_error = {
                    **plaid_error,
                    "needs_reauth": True,
                    "reconnect_item_id": item["item_id"],
                }
            results.append(
                {
                    "item_id": item["item_id"],
                    "error": plaid_error or {"message": str(exc)},
                }
            )

    return {
        "auto_sync_attempted": True,
        "auto_sync_performed": True,
        "linked_items": len(items),
        "auto_sync_results": results,
    }


def _enrich_card_related(rows: list[dict]) -> list[dict]:
    enriched: list[dict] = []
    for tx in rows:
        if (tx.get("source") or "").lower() == "venmo":
            result = classify_venmo_transaction(tx)
            tx_with_meta = {
                **tx,
                "is_card_related": result.is_card_related,
                "venmo_counterparty": result.counterparty,
                "venmo_card_keyword_matches": result.keyword_matches,
                "venmo_classification_reason": result.reason,
                "venmo_classification_confidence": result.confidence,
            }
            enriched.append(tx_with_meta)
            continue

        enriched.append(
            {
                **tx,
                "is_card_related": False,
            }
        )

    return enriched


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/plaid/link-token")
def api_create_link_token(payload: LinkTokenRequest) -> dict:
    try:
        cooldown_remaining = _link_token_cooldown_remaining(
            payload.user_id,
            payload.reconnect_item_id,
        )
        if cooldown_remaining > 0:
            raise HTTPException(
                status_code=429,
                detail={
                    "error_code": "LINK_TOKEN_COOLDOWN_ACTIVE",
                    "error_message": "Link token requested too frequently.",
                    "retry_after_seconds": cooldown_remaining,
                },
            )

        reconnect_item = None

        if payload.reconnect_item_id:
            reconnect_item = get_item(payload.reconnect_item_id)
            if not reconnect_item:
                raise HTTPException(status_code=404, detail="Unknown reconnect_item_id")
            if reconnect_item.get("user_id") != payload.user_id:
                raise HTTPException(
                    status_code=403,
                    detail="reconnect_item_id does not belong to this user",
                )
        elif payload.source_hint and not payload.force_new:
            normalized_hint = payload.source_hint.strip().lower()
            candidates = [
                item
                for item in list_items()
                if item.get("user_id") == payload.user_id
                and (item.get("source_hint") or "").strip().lower() == normalized_hint
            ]
            if candidates:
                reconnect_item = get_item(candidates[0]["item_id"])

        response = create_link_token(
            user_id=payload.user_id,
            access_token=(reconnect_item or {}).get("access_token"),
        )
        _mark_link_token_requested(
            payload.user_id,
            reconnect_item["item_id"] if reconnect_item else None,
        )

        if reconnect_item:
            response["reconnect_item_id"] = reconnect_item["item_id"]
            response["mode"] = "update"
        else:
            response["mode"] = "new"
        return response
    except Exception as exc:  # pragma: no cover
        if isinstance(exc, HTTPException):
            raise
        plaid_error = _extract_plaid_error(exc)
        if plaid_error and plaid_error.get("error_code") == "RATE_LIMIT":
            raise HTTPException(
                status_code=429,
                detail={
                    "error_code": "RATE_LIMIT",
                    "error_message": plaid_error.get(
                        "error_message",
                        "Plaid rate limit exceeded. Please retry shortly.",
                    ),
                    "retry_after_seconds": 60,
                },
            ) from exc
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


@app.post("/api/plaid/reclassify-sources")
def api_reclassify_sources(payload: ReclassifySourcesRequest) -> dict:
    items = [item for item in list_items() if item.get("user_id") == payload.user_id]

    checked_count = 0
    updated_count = 0
    updates: list[dict] = []

    for item in items:
        item_id = item["item_id"]
        institution_name = item.get("institution_name")
        source_hint = item.get("source_hint")

        rows = list_transactions_for_item(item_id)
        for row in rows:
            checked_count += 1
            next_source = infer_source(
                institution_name=institution_name,
                account_id=row.get("account_id") or "",
                account_name=row.get("account_name"),
                merchant_name=row.get("merchant_name"),
                description=row.get("description"),
                source_hint=source_hint,
            )
            previous_source = (row.get("source") or "other").lower()
            if next_source == previous_source:
                continue

            updated_count += 1
            updates.append(
                {
                    "plaid_transaction_id": row["plaid_transaction_id"],
                    "item_id": item_id,
                    "from": previous_source,
                    "to": next_source,
                }
            )

            if not payload.dry_run:
                update_transaction_source(row["plaid_transaction_id"], next_source)

    return {
        "user_id": payload.user_id,
        "dry_run": payload.dry_run,
        "linked_items": len(items),
        "checked_transactions": checked_count,
        "updated_transactions": updated_count,
        "updates": updates,
    }


@app.post("/api/plaid/sync/{item_id}")
def api_sync_item(item_id: str) -> dict:
    cooldown_remaining = _sync_cooldown_remaining(item_id)
    if cooldown_remaining > 0:
        raise HTTPException(
            status_code=429,
            detail={
                "error_code": "SYNC_COOLDOWN_ACTIVE",
                "error_message": "Sync requested too frequently for this item.",
                "retry_after_seconds": cooldown_remaining,
                "item_id": item_id,
            },
        )

    _mark_item_synced_now(item_id)
    try:
        return _sync_item_internal(item_id)
    except Exception as exc:  # pragma: no cover
        plaid_error = _extract_plaid_error(exc)
        if plaid_error and plaid_error.get("error_code") == "ITEM_LOGIN_REQUIRED":
            raise HTTPException(
                status_code=409,
                detail={
                    "error_code": "ITEM_LOGIN_REQUIRED",
                    "error_message": plaid_error.get(
                        "error_message",
                        "Item requires re-authentication in Plaid Link update mode.",
                    ),
                    "needs_reauth": True,
                    "item_id": item_id,
                    "reconnect_item_id": item_id,
                },
            ) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/accounts/source-map")
def api_set_account_source(payload: AccountSourceMapRequest) -> dict:
    source = payload.source.lower().strip()
    if source not in {"venmo", "chase", "zelle", "other"}:
        raise HTTPException(
            status_code=400, detail="source must be venmo|chase|zelle|other"
        )

    set_account_source(payload.account_id, source)
    return {"status": "ok", "account_id": payload.account_id, "source": source}


@app.get("/api/spend/summary")
def api_spend_summary(
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    include_pending: bool = Query(default=False),
    auto_sync: bool = Query(default=False),
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
    auto_sync: bool = Query(default=False),
) -> dict:
    normalized_source = source.lower() if source else None
    if normalized_source and normalized_source not in {
        "venmo",
        "chase",
        "zelle",
        "other",
    }:
        raise HTTPException(
            status_code=400, detail="source must be venmo|chase|zelle|other"
        )

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

    queried_rows = query_transactions(
        source=normalized_source,
        start_date=start_date,
        end_date=end_date,
        include_pending=include_pending,
        limit=limit,
    )

    rows = _enrich_card_related(queried_rows)

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
    auto_sync: bool = Query(default=False),
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
    rows = _enrich_card_related(rows)

    payload = [
        {
            "amount": tx["amount"],
            "category": tx["source"].capitalize(),
            "description": tx.get("description") or tx.get("merchant_name") or "",
            "date": tx["date"],
            "is_card_related": tx.get("is_card_related", False),
        }
        for tx in rows
    ]
    return {
        "transactions": payload,
        "auto_sync": auto_sync,
        **auto_sync_meta,
    }
