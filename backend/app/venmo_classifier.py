from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib import error, request

from .settings import settings


@dataclass
class VenmoCardResult:
    is_card_related: bool
    confidence: float
    reason: str
    counterparty: str
    keyword_matches: list[str]


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").lower().strip().split())


def _contains_phrase(text: str, phrase: str) -> bool:
    normalized_phrase = _normalize_text(phrase)
    if not normalized_phrase:
        return False
    return normalized_phrase in text


def _match_counterparty(text: str, counterparties: list[str]) -> str:
    for person in counterparties:
        candidate = _normalize_text(person)
        if not candidate:
            continue

        if candidate in text:
            return person

        # Fallback for cases where Venmo formatting removes punctuation.
        parts = [p for p in candidate.split(" ") if p]
        if len(parts) >= 2 and all(part in text for part in parts):
            return person

    return ""


def _find_keyword_matches(text: str, keywords: list[str]) -> list[str]:
    matches: list[str] = []
    for keyword in keywords:
        if _contains_phrase(text, keyword):
            matches.append(keyword)
    return matches


def _extract_candidate_text(tx: dict[str, Any]) -> str:
    chunks = [
        str(tx.get("merchant_name") or ""),
        str(tx.get("description") or ""),
        str(tx.get("account_name") or ""),
        str(tx.get("source") or ""),
    ]
    return _normalize_text(" ".join(chunks))


def _ai_card_classification(
    tx: dict[str, Any], counterparty: str
) -> VenmoCardResult | None:
    if not settings.venmo_ai_enabled or not settings.openai_api_key:
        return None

    prompt = {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": (
                    "Classify if this Venmo transaction is related to trading cards. "
                    "Reply with strict JSON only: "
                    '{"is_card_related": boolean, "confidence": number, "reason": string}.\n\n'
                    f"Counterparty: {counterparty}\n"
                    f"Description: {tx.get('description') or ''}\n"
                    f"Merchant: {tx.get('merchant_name') or ''}\n"
                    f"Amount: {tx.get('amount') or ''}\n"
                    f"Date: {tx.get('date') or ''}\n"
                ),
            }
        ],
    }

    payload = {
        "model": settings.openai_model,
        "messages": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "You are a transaction classifier. "
                            "Decide if a Venmo payment is card-related (Pokemon, One Piece, Riftbound, TCG)."
                        ),
                    }
                ],
            },
            prompt,
        ],
        "temperature": 0,
        "max_output_tokens": 120,
    }

    req = request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=8) as resp:  # noqa: S310
            body = json.loads(resp.read().decode("utf-8"))
    except (error.URLError, TimeoutError, json.JSONDecodeError):
        return None

    output_text = ""
    for item in body.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                output_text += content.get("text", "")

    if not output_text:
        return None

    try:
        parsed = json.loads(output_text)
    except json.JSONDecodeError:
        return None

    is_card_related = bool(parsed.get("is_card_related"))
    confidence = float(parsed.get("confidence") or (0.6 if is_card_related else 0.4))
    reason = str(parsed.get("reason") or "AI-assisted Venmo classification")

    return VenmoCardResult(
        is_card_related=is_card_related,
        confidence=max(0.0, min(confidence, 1.0)),
        reason=reason,
        counterparty=counterparty,
        keyword_matches=[],
    )


def classify_venmo_transaction(tx: dict[str, Any]) -> VenmoCardResult:
    text = _extract_candidate_text(tx)

    counterparty = _match_counterparty(text, settings.venmo_card_counterparties)
    keyword_matches = _find_keyword_matches(text, settings.venmo_card_keywords)
    non_card_matches = _find_keyword_matches(text, settings.venmo_non_card_keywords)

    if counterparty and keyword_matches:
        return VenmoCardResult(
            is_card_related=True,
            confidence=0.99,
            reason="Matched known Venmo counterparty and card keyword(s)",
            counterparty=counterparty,
            keyword_matches=keyword_matches,
        )

    if non_card_matches and not keyword_matches:
        return VenmoCardResult(
            is_card_related=False,
            confidence=0.95,
            reason="Matched non-card keyword(s)",
            counterparty=counterparty,
            keyword_matches=[],
        )

    if counterparty:
        ai_result = _ai_card_classification(tx, counterparty)
        if ai_result:
            return ai_result

        return VenmoCardResult(
            is_card_related=False,
            confidence=0.55,
            reason="Matched known Venmo counterparty but no card keyword",
            counterparty=counterparty,
            keyword_matches=keyword_matches,
        )

    if keyword_matches and "venmo" in text:
        return VenmoCardResult(
            is_card_related=True,
            confidence=0.7,
            reason="Matched card keyword(s) in Venmo transaction",
            counterparty="",
            keyword_matches=keyword_matches,
        )

    return VenmoCardResult(
        is_card_related=False,
        confidence=0.98,
        reason="No known Venmo counterparty or card keywords matched",
        counterparty="",
        keyword_matches=[],
    )
