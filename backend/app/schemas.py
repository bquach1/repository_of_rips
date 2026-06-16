from __future__ import annotations

from pydantic import BaseModel, Field


class LinkTokenRequest(BaseModel):
    user_id: str = Field(default="local-user")
    source_hint: str | None = None
    reconnect_item_id: str | None = None
    force_new: bool = False


class ExchangePublicTokenRequest(BaseModel):
    public_token: str
    institution_name: str | None = None
    user_id: str = Field(default="local-user")
    source_hint: str | None = None


class CleanupPlaidItemsRequest(BaseModel):
    user_id: str = Field(default="local-user")
    dry_run: bool = False
    remove_from_plaid: bool = False


class ReclassifySourcesRequest(BaseModel):
    user_id: str = Field(default="local-user")
    dry_run: bool = False


class SyncRequest(BaseModel):
    item_id: str


class AccountSourceMapRequest(BaseModel):
    account_id: str
    source: str


class SpendQuery(BaseModel):
    start_date: str | None = None
    end_date: str | None = None
    include_pending: bool = False
    source: str | None = None
    limit: int = 200
