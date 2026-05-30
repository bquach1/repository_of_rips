import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

const BACKEND_BASE_URL =
  import.meta.env.VITE_BACKEND_BASE_URL || "http://localhost:8000";

function PlaidConnectPanel({ onLinked }) {
  const [linkToken, setLinkToken] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [sourceHint, setSourceHint] = useState("other");
  const sourceHintRef = useRef("other");

  const createLinkToken = useCallback(async () => {
    try {
      setStatus("creating-link-token");
      setError("");

      const response = await fetch(`${BACKEND_BASE_URL}/api/plaid/link-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "local-user" }),
      });

      if (!response.ok) {
        throw new Error(`Link token request failed (${response.status})`);
      }

      const payload = await response.json();
      if (!payload.link_token) {
        throw new Error("No link_token returned from backend.");
      }

      setLinkToken(payload.link_token);
      setStatus("link-token-ready");
    } catch (err) {
      setStatus("error");
      setError(err.message || "Failed to create link token.");
    }
  }, []);

  useEffect(() => {
    createLinkToken();
  }, [createLinkToken]);

  const onSuccess = useCallback(
    async (publicToken, metadata) => {
      try {
        setStatus("exchanging-token");
        setError("");

        const exchangeRes = await fetch(
          `${BACKEND_BASE_URL}/api/plaid/exchange-public-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              public_token: publicToken,
              institution_name: metadata?.institution?.name || null,
              user_id: "local-user",
              source_hint: sourceHintRef.current,
            }),
          },
        );

        if (!exchangeRes.ok) {
          throw new Error(
            `Public token exchange failed (${exchangeRes.status})`,
          );
        }

        const exchangePayload = await exchangeRes.json();
        const itemId = exchangePayload.item_id;

        if (!itemId) {
          throw new Error("No item_id returned after token exchange.");
        }

        setStatus("syncing-transactions");
        const syncRes = await fetch(
          `${BACKEND_BASE_URL}/api/plaid/sync/${itemId}`,
          {
            method: "POST",
          },
        );

        if (!syncRes.ok) {
          throw new Error(
            `Initial transaction sync failed (${syncRes.status})`,
          );
        }

        setStatus("connected");
        await onLinked();
      } catch (err) {
        setStatus("error");
        setError(err.message || "Plaid linking failed.");
      }
    },
    [onLinked],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken || null,
    onSuccess,
    onExit: (err) => {
      if (err) {
        setStatus("error");
        setError(
          err.display_message ||
            err.error_message ||
            "Plaid Link exited with an error.",
        );
      }
    },
  });

  const statusText = useMemo(() => {
    switch (status) {
      case "creating-link-token":
        return "Creating secure Plaid link token...";
      case "link-token-ready":
        return "Ready to connect an account.";
      case "exchanging-token":
        return "Link successful. Exchanging token...";
      case "syncing-transactions":
        return "Syncing transactions from Plaid...";
      case "connected":
        return "Connected and synced.";
      case "error":
        return "Connection failed.";
      default:
        return "Waiting to start...";
    }
  }, [status]);

  const openWithSource = (nextSource) => {
    sourceHintRef.current = nextSource;
    setSourceHint(nextSource);
    open();
  };

  return (
    <section className="surface plaid-connect">
      <h2>Connect Venmo / Chase (Plaid)</h2>
      <p>
        Use Plaid Link to connect your institutions. After linking, the app
        syncs transactions and refreshes spend summary automatically.
      </p>

      <div className="plaid-actions">
        <button
          type="button"
          className="chip chip-active"
          onClick={() => openWithSource("venmo")}
          disabled={!ready || !linkToken}
        >
          Connect Venmo
        </button>
        <button
          type="button"
          className="chip chip-active"
          onClick={() => openWithSource("chase")}
          disabled={!ready || !linkToken}
        >
          Connect Chase
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => openWithSource("other")}
          disabled={!ready || !linkToken}
        >
          Connect Other Institution
        </button>
        <button type="button" className="chip" onClick={createLinkToken}>
          Refresh Link Token
        </button>
      </div>

      <p className="plaid-status">Status: {statusText}</p>
      <p className="plaid-status">Source tag for next link: {sourceHint}</p>
      {error ? <p className="spend-error">{error}</p> : null}
    </section>
  );
}

export default PlaidConnectPanel;
