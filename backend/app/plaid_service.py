from __future__ import annotations

from plaid.api import plaid_api
from plaid.api_client import ApiClient
from plaid.configuration import Configuration
from plaid.model.country_code import CountryCode
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.products import Products
from plaid.model.transactions_sync_request import TransactionsSyncRequest

from .database import get_account_source
from .settings import settings

ENV_HOSTS = {
    "sandbox": "https://sandbox.plaid.com",
    "development": "https://development.plaid.com",
    "production": "https://production.plaid.com",
}


def get_plaid_client() -> plaid_api.PlaidApi:
    if not settings.plaid_client_id or not settings.plaid_secret:
        raise RuntimeError("PLAID_CLIENT_ID and PLAID_SECRET are required.")

    host = ENV_HOSTS.get(settings.plaid_env, ENV_HOSTS["sandbox"])
    configuration = Configuration(
        host=host,
        api_key={
            "clientId": settings.plaid_client_id,
            "secret": settings.plaid_secret,
        },
    )
    api_client = ApiClient(configuration)
    return plaid_api.PlaidApi(api_client)


def create_link_token(user_id: str) -> dict:
    client = get_plaid_client()
    payload = {
        "user": LinkTokenCreateRequestUser(client_user_id=user_id),
        "client_name": "Repository of Rips",
        "products": [Products("transactions")],
        "country_codes": [CountryCode("US")],
        "language": "en",
    }

    # Plaid SDK validates types strictly; do not send None for optional strings.
    if settings.plaid_webhook_url:
        payload["webhook"] = settings.plaid_webhook_url
    # Plaid requires HTTPS redirect_uri. For local dev (http://localhost),
    # omit redirect_uri so non-OAuth Link flows can still work.
    if settings.plaid_redirect_uri and settings.plaid_redirect_uri.lower().startswith(
        "https://"
    ):
        payload["redirect_uri"] = settings.plaid_redirect_uri

    req = LinkTokenCreateRequest(**payload)
    response = client.link_token_create(req)
    return response.to_dict()


def exchange_public_token(public_token: str) -> dict:
    client = get_plaid_client()
    req = ItemPublicTokenExchangeRequest(public_token=public_token)
    response = client.item_public_token_exchange(req)
    return response.to_dict()


def infer_source(
    institution_name: str | None,
    account_id: str,
    account_name: str | None,
    merchant_name: str | None,
    description: str | None,
    source_hint: str | None = None,
) -> str:
    normalized_hint = (source_hint or "").strip().lower()
    if normalized_hint in {"venmo", "chase", "other"}:
        return normalized_hint

    mapped_source = get_account_source(account_id)
    if mapped_source:
        return mapped_source

    text = " ".join(
        [
            (institution_name or ""),
            (account_name or ""),
            (merchant_name or ""),
            (description or ""),
        ]
    ).lower()

    if "venmo" in text:
        return "venmo"
    if "chase" in text:
        return "chase"
    return "other"


def sync_transactions(access_token: str, cursor: str | None = None) -> dict:
    client = get_plaid_client()
    payload = {"access_token": access_token}
    if cursor:
        payload["cursor"] = cursor

    req = TransactionsSyncRequest(**payload)
    response = client.transactions_sync(req)
    return response.to_dict()
