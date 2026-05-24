from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone

from .settings import settings


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_default(value: object) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value)


@contextmanager
def get_conn() -> sqlite3.Connection:
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS plaid_items (
                item_id TEXT PRIMARY KEY,
                access_token TEXT NOT NULL,
                institution_name TEXT,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS account_source_map (
                account_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transactions (
                plaid_transaction_id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                account_name TEXT,
                merchant_name TEXT,
                description TEXT,
                amount REAL NOT NULL,
                iso_currency_code TEXT,
                date TEXT NOT NULL,
                pending INTEGER NOT NULL,
                source TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (item_id) REFERENCES plaid_items(item_id)
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_source_date
              ON transactions(source, date);
            """)


def upsert_plaid_item(
    item_id: str, access_token: str, institution_name: str | None, user_id: str
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO plaid_items(item_id, access_token, institution_name, user_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                access_token = excluded.access_token,
                institution_name = excluded.institution_name,
                user_id = excluded.user_id
            """,
            (item_id, access_token, institution_name, user_id, utc_now_iso()),
        )


def get_item(item_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM plaid_items WHERE item_id = ?", (item_id,)
        ).fetchone()
    return dict(row) if row else None


def list_items() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT item_id, institution_name, user_id, created_at FROM plaid_items ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def set_account_source(account_id: str, source: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO account_source_map(account_id, source, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            (account_id, source, utc_now_iso()),
        )


def get_account_source(account_id: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT source FROM account_source_map WHERE account_id = ?",
            (account_id,),
        ).fetchone()
    return row["source"] if row else None


def upsert_transaction(record: dict) -> None:
    tx_date = record["date"]
    if isinstance(tx_date, (date, datetime)):
        tx_date = tx_date.isoformat()

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO transactions(
                plaid_transaction_id, item_id, account_id, account_name,
                merchant_name, description, amount, iso_currency_code, date,
                pending, source, raw_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(plaid_transaction_id) DO UPDATE SET
                item_id = excluded.item_id,
                account_id = excluded.account_id,
                account_name = excluded.account_name,
                merchant_name = excluded.merchant_name,
                description = excluded.description,
                amount = excluded.amount,
                iso_currency_code = excluded.iso_currency_code,
                date = excluded.date,
                pending = excluded.pending,
                source = excluded.source,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at
            """,
            (
                record["plaid_transaction_id"],
                record["item_id"],
                record["account_id"],
                record["account_name"],
                record["merchant_name"],
                record["description"],
                record["amount"],
                record["iso_currency_code"],
                tx_date,
                1 if record["pending"] else 0,
                record["source"],
                json.dumps(record["raw"], separators=(",", ":"), default=_json_default),
                utc_now_iso(),
            ),
        )


def delete_transactions_by_ids(transaction_ids: list[str]) -> int:
    if not transaction_ids:
        return 0

    placeholders = ",".join("?" for _ in transaction_ids)
    with get_conn() as conn:
        cursor = conn.execute(
            f"DELETE FROM transactions WHERE plaid_transaction_id IN ({placeholders})",
            transaction_ids,
        )
        return cursor.rowcount


def query_spend_summary(
    start_date: str | None, end_date: str | None, include_pending: bool
) -> dict:
    where = ["amount > 0"]
    params: list[object] = []

    if not include_pending:
        where.append("pending = 0")
    if start_date:
        where.append("date >= ?")
        params.append(start_date)
    if end_date:
        where.append("date <= ?")
        params.append(end_date)

    where_sql = " AND ".join(where)

    with get_conn() as conn:
        total_row = conn.execute(
            f"SELECT COALESCE(SUM(amount), 0) AS total_spend FROM transactions WHERE {where_sql}",
            params,
        ).fetchone()
        by_source_rows = conn.execute(
            f"SELECT source, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE {where_sql} GROUP BY source ORDER BY total DESC",
            params,
        ).fetchall()

    by_source = {row["source"]: row["total"] for row in by_source_rows}
    return {
        "total_spend": total_row["total_spend"],
        "by_source": by_source,
    }


def query_transactions(
    source: str | None,
    start_date: str | None,
    end_date: str | None,
    include_pending: bool,
    limit: int,
) -> list[dict]:
    where = ["amount > 0"]
    params: list[object] = []

    if source:
        where.append("source = ?")
        params.append(source)
    if not include_pending:
        where.append("pending = 0")
    if start_date:
        where.append("date >= ?")
        params.append(start_date)
    if end_date:
        where.append("date <= ?")
        params.append(end_date)

    where_sql = " AND ".join(where)
    params.append(limit)

    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT plaid_transaction_id, source, date, amount, merchant_name, description,
                   account_name, pending, iso_currency_code
            FROM transactions
            WHERE {where_sql}
            ORDER BY date DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]
