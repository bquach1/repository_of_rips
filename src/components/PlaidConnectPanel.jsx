import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

const BACKEND_BASE_URL =
  import.meta.env.VITE_BACKEND_BASE_URL || "http://localhost:8000";

function PlaidConnectPanel({ onLinked }) {
  const [linkToken, setLinkToken] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [sourceHint, setSourceHint] = useState("other");
  const [linkedItems, setLinkedItems] = useState([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [lastMode, setLastMode] = useState("new");
  const [isCleaningItems, setIsCleaningItems] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState("");
  const sourceHintRef = useRef("other");
  const pendingOpenRef = useRef(false);

  const fetchLinkedItems = useCallback(async () => {
    setIsLoadingItems(true);
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/api/plaid/items`, {
        cache: "no-cache",
      });
      if (!response.ok) {
        throw new Error(`Could not load linked items (${response.status})`);
      }
      const payload = await response.json();
      setLinkedItems(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setError(err.message || "Failed to load linked Plaid items.");
    } finally {
      setIsLoadingItems(false);
    }
  }, []);

  const createLinkToken = useCallback(async (options = {}) => {
    try {
      setStatus("creating-link-token");
      setError("");

      const requestPayload = {
        user_id: "local-user",
      };
      if (options.sourceHint) {
        requestPayload.source_hint = options.sourceHint;
      }
      if (options.reconnectItemId) {
        requestPayload.reconnect_item_id = options.reconnectItemId;
      }
      if (options.forceNew) {
        requestPayload.force_new = true;
      }

      const response = await fetch(`${BACKEND_BASE_URL}/api/plaid/link-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        throw new Error(`Link token request failed (${response.status})`);
      }

      const payload = await response.json();
      if (!payload.link_token) {
        throw new Error("No link_token returned from backend.");
      }

      setLinkToken(payload.link_token);
      setLastMode(payload.mode || "new");
      setStatus("link-token-ready");
      return payload;
    } catch (err) {
      setStatus("error");
      setError(err.message || "Failed to create link token.");
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function bootstrapLinkToken() {
      try {
        const response = await fetch(
          `${BACKEND_BASE_URL}/api/plaid/link-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: "local-user" }),
          },
        );

        if (!response.ok) {
          throw new Error(`Link token request failed (${response.status})`);
        }

        const payload = await response.json();
        if (!active || !payload.link_token) {
          return;
        }

        setLinkToken(payload.link_token);
        setLastMode(payload.mode || "new");
        setStatus("link-token-ready");
      } catch (err) {
        if (!active) {
          return;
        }
        setStatus("error");
        setError(err.message || "Failed to create link token.");
      }
    }

    bootstrapLinkToken();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function bootstrapItems() {
      try {
        const response = await fetch(`${BACKEND_BASE_URL}/api/plaid/items`, {
          cache: "no-cache",
        });
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        if (!active) {
          return;
        }
        setLinkedItems(Array.isArray(payload.items) ? payload.items : []);
      } catch {
        if (!active) {
          return;
        }
      }
    }

    bootstrapItems();

    return () => {
      active = false;
    };
  }, []);

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
        await fetchLinkedItems();
        await onLinked();
      } catch (err) {
        setStatus("error");
        setError(err.message || "Plaid linking failed.");
      }
    },
    [fetchLinkedItems, onLinked],
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

  useEffect(() => {
    if (!pendingOpenRef.current || !ready || !linkToken) {
      return;
    }
    pendingOpenRef.current = false;
    open();
  }, [ready, linkToken, open]);

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

  const openWithSource = async (nextSource, options = {}) => {
    sourceHintRef.current = nextSource;
    setSourceHint(nextSource);
    const created = await createLinkToken({
      sourceHint: nextSource,
      reconnectItemId: options.reconnectItemId,
      forceNew: Boolean(options.forceNew),
    });
    if (created?.link_token) {
      pendingOpenRef.current = true;
      if (ready) {
        pendingOpenRef.current = false;
        open();
      }
    }
  };

  const syncExistingItem = async (itemId) => {
    try {
      setStatus("syncing-transactions");
      setError("");
      const response = await fetch(
        `${BACKEND_BASE_URL}/api/plaid/sync/${itemId}`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        throw new Error(`Sync failed (${response.status})`);
      }
      setStatus("connected");
      await onLinked();
    } catch (err) {
      setStatus("error");
      setError(err.message || "Sync failed.");
    }
  };

  const cleanupDuplicateItems = async ({ removeFromPlaid }) => {
    try {
      setIsCleaningItems(true);
      setError("");
      setCleanupMessage("");

      const response = await fetch(
        `${BACKEND_BASE_URL}/api/plaid/cleanup-duplicates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: "local-user",
            dry_run: false,
            remove_from_plaid: removeFromPlaid,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Cleanup failed (${response.status})`);
      }

      const payload = await response.json();
      setCleanupMessage(
        `Cleanup complete. Removed ${payload.removed_count} duplicate item(s); skipped ${payload.skipped_count}.`,
      );
      await fetchLinkedItems();
      await onLinked();
    } catch (err) {
      setError(err.message || "Failed to clean duplicate Plaid items.");
    } finally {
      setIsCleaningItems(false);
    }
  };

  const reclassifySources = async () => {
    try {
      setIsCleaningItems(true);
      setError("");
      setCleanupMessage("");

      const response = await fetch(
        `${BACKEND_BASE_URL}/api/plaid/reclassify-sources`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: "local-user",
            dry_run: false,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Reclassify failed (${response.status})`);
      }

      const payload = await response.json();
      setCleanupMessage(
        `Reclassified ${payload.updated_transactions} of ${payload.checked_transactions} transactions.`,
      );
      await onLinked();
    } catch (err) {
      setError(err.message || "Failed to reclassify transactions.");
    } finally {
      setIsCleaningItems(false);
    }
  };

  return (
    <section className="surface plaid-connect">
      <h2>Connect Venmo / Chase / Zelle (Plaid)</h2>
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
          className="chip chip-active"
          onClick={() => openWithSource("zelle")}
          disabled={!ready || !linkToken}
        >
          Connect Zelle (via Bank)
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => openWithSource("other")}
          disabled={!ready || !linkToken}
        >
          Connect Other Institution
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => createLinkToken({ forceNew: true })}
        >
          Refresh Link Token
        </button>
      </div>

      <p className="plaid-status">Status: {statusText}</p>
      <p className="plaid-status">Source tag for next link: {sourceHint}</p>
      <p className="plaid-status">Link mode: {lastMode}</p>

      <div className="plaid-actions">
        <button type="button" className="chip" onClick={fetchLinkedItems}>
          Refresh Existing Connections
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => cleanupDuplicateItems({ removeFromPlaid: false })}
          disabled={isCleaningItems}
        >
          Cleanup Duplicates (Local)
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => cleanupDuplicateItems({ removeFromPlaid: true })}
          disabled={isCleaningItems}
        >
          Cleanup Duplicates (Local + Plaid)
        </button>
        <button
          type="button"
          className="chip"
          onClick={reclassifySources}
          disabled={isCleaningItems}
        >
          Reclassify Sources
        </button>
      </div>

      {isLoadingItems ? (
        <p className="plaid-status">Loading existing connections...</p>
      ) : null}
      {!isLoadingItems && linkedItems.length === 0 ? (
        <p className="plaid-status">No saved Plaid connections yet.</p>
      ) : null}
      {!isLoadingItems && linkedItems.length > 0 ? (
        <div>
          <h3>Existing Connections</h3>
          {linkedItems.map((item) => (
            <div key={item.item_id} className="plaid-actions">
              <span className="plaid-status">
                {item.institution_name || "Unknown institution"} (
                {item.source_hint || "other"})
              </span>
              <button
                type="button"
                className="chip"
                onClick={() =>
                  openWithSource(item.source_hint || "other", {
                    reconnectItemId: item.item_id,
                  })
                }
                disabled={!ready || !linkToken}
              >
                Reconnect Existing
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => syncExistingItem(item.item_id)}
              >
                Sync Existing
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {cleanupMessage ? <p className="plaid-status">{cleanupMessage}</p> : null}
      {error ? <p className="spend-error">{error}</p> : null}
    </section>
  );
}

export default PlaidConnectPanel;
