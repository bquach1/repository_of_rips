from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

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


@dataclass
class Settings:
    plaid_client_id: str = env_str("PLAID_CLIENT_ID")
    plaid_secret: str = env_str("PLAID_SECRET")
    plaid_env: str = env_str("PLAID_ENV", "sandbox").lower()
    plaid_redirect_uri: str = env_str("PLAID_REDIRECT_URI")
    plaid_webhook_url: str = env_str("PLAID_WEBHOOK_URL")
    allowed_origins: list[str] = None  # type: ignore[assignment]
    database_path: Path = resolve_database_path()

    def __post_init__(self) -> None:
        origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173")
        self.allowed_origins = [o.strip() for o in origins.split(",") if o.strip()]


settings = Settings()
