from __future__ import annotations

import os
from dotenv import load_dotenv
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")


def resolve_database_path() -> Path:
    configured = (os.getenv("DATABASE_PATH") or "").strip()
    if not configured:
        return ROOT_DIR / "plaid_spend.db"

    candidate = Path(configured).expanduser()
    if not candidate.is_absolute():
        candidate = ROOT_DIR / candidate
    return candidate


def env_str(name: str, default: str = "") -> str:
    value = os.getenv(name, default)
    return (value or "").strip().strip('"').strip("'")


def env_bool(name: str, default: bool = False) -> bool:
    value = env_str(name)
    if not value:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def env_csv(name: str, default: str = "") -> list[str]:
    raw = env_str(name, default)
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def env_keyword_list(name: str, default: str = "") -> list[str]:
    raw = env_str(name, default)
    if not raw:
        return []

    # Preserve regex blobs such as
    # (card|...|op\d{2,4}-?\d{3,4}) without splitting on quantifier commas.
    if raw.startswith("(") and raw.endswith(")"):
        return [raw]

    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    plaid_client_id: str = env_str("PLAID_CLIENT_ID")
    plaid_secret: str = env_str("PLAID_SECRET")
    plaid_env: str = env_str("PLAID_ENV", "sandbox").lower()
    plaid_redirect_uri: str = env_str("PLAID_REDIRECT_URI")
    plaid_webhook_url: str = env_str("PLAID_WEBHOOK_URL")
    allowed_origins: list[str] = None  # type: ignore[assignment]
    database_path: Path = resolve_database_path()
    venmo_card_counterparties: list[str] = None  # type: ignore[assignment]
    venmo_card_keywords: list[str] = None  # type: ignore[assignment]
    venmo_non_card_keywords: list[str] = None  # type: ignore[assignment]
    venmo_ai_enabled: bool = env_bool("VENMO_AI_ENABLED", False)
    openai_api_key: str = env_str("OPENAI_API_KEY")
    openai_model: str = env_str("OPENAI_MODEL", "gpt-4.1-mini")

    def __post_init__(self) -> None:
        origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173")
        self.allowed_origins = [o.strip() for o in origins.split(",") if o.strip()]

        self.venmo_card_counterparties = env_csv(
            "VENMO_CARD_COUNTERPARTIES",
            "William Ng,Sheshasai Sairam,Allyson Suandi",
        )
        self.venmo_card_keywords = env_keyword_list(
            "VENMO_CARD_KEYWORDS",
            "(card|cards|tcg|pokemon|one piece|riftbound|booster|pack|box|single|slab|psa|bgs|cgc|prerelease|Pre release|whatnot|tcgplayer|collectr|rip|op\d{2,4}|op\d{2,4}-?\d{3,4}|Mr 3)",
        )
        self.venmo_non_card_keywords = env_csv(
            "VENMO_NON_CARD_KEYWORDS",
            "rent,utilities,electric,water,internet,food,dinner,lunch,brunch,groceries,uber,lyft,gas,loan,payment,zelle",
        )


settings = Settings()
