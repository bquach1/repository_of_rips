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
  const [showLaunchPrompt, setShowLaunchPrompt] = useState(false);
  const [launchPromptText, setLaunchPromptText] = useState("");
  const [preparedToken, setPreparedToken] = useState("");
  const [syncCooldownUntil, setSyncCooldownUntil] = useState({});
  const [linkRateLimitUntil, setLinkRateLimitUntil] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const sourceHintRef = useRef("other");

  useEffect(() => {
    const timer = setInterval(() => {
      setClockMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const getSyncCooldownSeconds = useCallback(
    (itemId) => {
      const until = syncCooldownUntil[itemId];
      if (!until) {
        return 0;
      }
      const remaining = Math.ceil((until - clockMs) / 1000);
      return remaining > 0 ? remaining : 0;
    },
    [clockMs, syncCooldownUntil],
  );

  const linkRateLimitSeconds = useMemo(() => {
    if (!linkRateLimitUntil) {
      return 0;
    }
    const remaining = Math.ceil((linkRateLimitUntil - clockMs) / 1000);
    return remaining > 0 ? remaining : 0;
  }, [clockMs, linkRateLimitUntil]);

  const setLinkRateLimitCooldown = useCallback((seconds) => {
    if (!seconds || seconds <= 0) {
      return;
    }
    setLinkRateLimitUntil(Date.now() + seconds * 1000);
  }, []);

  const setSyncCooldownForItem = useCallback((itemId, seconds) => {
    if (!itemId || !seconds || seconds <= 0) {
      return;
    }
    setSyncCooldownUntil((prev) => ({
      ...prev,
      [itemId]: Date.now() + seconds * 1000,
    }));
  }, []);

  const filteredLinkedItems = useMemo(() => {
    return linkedItems.filter((item) => {
      const institution = String(item.institution_name || "")
        .trim()
        .toLowerCase();
      const hint = String(item.source_hint || "")
        .trim()
        .toLowerCase();

      const isChase = institution === "chase";
      const isVenmoPersonal =
        (institution === "venmo - personal" ||
          institution === "venmo personal") &&
        hint === "venmo";

      return isChase || isVenmoPersonal;
    });
  }, [linkedItems]);

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

  const createLinkToken = useCallback(
    async (options = {}) => {
      if (linkRateLimitSeconds > 0) {
        setStatus("error");
        setError(
          `Plaid is rate-limited. Try again in ${linkRateLimitSeconds}s.`,
        );
        return null;
      }

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

        const response = await fetch(
          `${BACKEND_BASE_URL}/api/plaid/link-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload),
          },
        );

        if (!response.ok) {
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }

          const detail = payload?.detail;
          if (detail?.error_code === "LINK_TOKEN_COOLDOWN_ACTIVE") {
            const retryAfter = Number(detail.retry_after_seconds || 30);
            setLinkRateLimitCooldown(retryAfter);
            throw new Error(
              detail.error_message ||
                `Please wait ${retryAfter}s before requesting another link token.`,
            );
          }

          if (detail?.error_code === "RATE_LIMIT") {
            const retryAfter = Number(detail.retry_after_seconds || 60);
            setLinkRateLimitCooldown(retryAfter);
            throw new Error(
              detail.error_message ||
                `Plaid rate limit exceeded. Try again in ${retryAfter}s.`,
            );
          }

          throw new Error(
            detail?.error_message ||
              `Link token request failed (${response.status})`,
          );
        }

        const payload = await response.json();
        if (!payload.link_token) {
          throw new Error("No link_token returned from backend.");
        }

        setLinkToken(payload.link_token);
        setPreparedToken(payload.link_token);
        setLastMode(payload.mode || "new");
        setStatus("link-token-ready");
        return payload;
      } catch (err) {
        setStatus("error");
        setError(err.message || "Failed to create link token.");
        return null;
      }
    },
    [linkRateLimitSeconds, setLinkRateLimitCooldown],
  );

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
        const code = err.error_code ? ` [${err.error_code}]` : "";
        if (err.error_code === "RATE_LIMIT") {
          setLinkRateLimitCooldown(60);
        }
        setStatus("error");
        setError(
          (err.display_message ||
            err.error_message ||
            "Plaid Link exited with an error.") + code,
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
        return "Connected and synced.";
    }
  }, [status]);

  const openWithSource = async (nextSource, options = {}) => {
    sourceHintRef.current = nextSource;
    setSourceHint(nextSource);
    setShowLaunchPrompt(false);
    setLaunchPromptText("");
    const created = await createLinkToken({
      sourceHint: nextSource,
      reconnectItemId: options.reconnectItemId,
      forceNew: Boolean(options.forceNew),
    });
    if (created?.link_token) {
      const promptText =
        created.mode === "update"
          ? "Reconnect token ready. Click Launch Plaid Modal to complete login/MFA."
          : "Link token ready. Click Launch Plaid Modal to continue.";
      setLaunchPromptText(promptText);
      setShowLaunchPrompt(true);
    }
  };

  const syncExistingItem = async (item) => {
    const existingCooldown = getSyncCooldownSeconds(item.item_id);
    if (existingCooldown > 0) {
      setError(
        `Please wait ${existingCooldown}s before syncing this connection again.`,
      );
      return;
    }

    try {
      setStatus("syncing-transactions");
      setError("");
      const response = await fetch(
        `${BACKEND_BASE_URL}/api/plaid/sync/${item.item_id}`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }

        const detail = payload?.detail;
        if (detail?.error_code === "SYNC_COOLDOWN_ACTIVE") {
          const retryAfter = Number(detail.retry_after_seconds || 30);
          setSyncCooldownForItem(item.item_id, retryAfter);
          setStatus("link-token-ready");
          setError(
            `Sync cooldown active. Try again in ${retryAfter}s for this item.`,
          );
          return;
        }

        if (detail?.error_code === "ITEM_LOGIN_REQUIRED") {
          setStatus("link-token-ready");
          setError(
            "This connection needs re-authentication. Generate reconnect token, then launch Plaid modal.",
          );
          await openWithSource(item.source_hint || "other", {
            reconnectItemId: item.item_id,
          });
          return;
        }

        const message =
          detail?.error_message ||
          detail?.message ||
          `Sync failed (${response.status})`;
        throw new Error(message);
      }
      setStatus("connected");
      setSyncCooldownForItem(item.item_id, 15);
      await onLinked();
    } catch (err) {
      setStatus("error");
      setError(err.message || "Sync failed.");
    }
  };

  return (
    <section className="surface plaid-connect">
      <h2>Connect Financial Institutions</h2>
      <p>
        Use Plaid Link to connect your institutions. After linking, the app
        syncs transactions and refreshes spend summary automatically.
      </p>

      <div className="plaid-actions">
        <button
          type="button"
          className="chip chip-active"
          onClick={() => openWithSource("venmo")}
        >
          Connect Venmo
        </button>
        <button
          type="button"
          className="chip chip-active"
          onClick={() => openWithSource("chase")}
        >
          Connect Chase
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => openWithSource("other")}
        >
          Connect Other Institution
        </button>
        <button
          type="button"
          className="chip"
          onClick={() =>
            openWithSource(sourceHintRef.current, { forceNew: true })
          }
        >
          Refresh Link Token
        </button>
      </div>

      <div className="plaid-status-grid">
        <div>
          <span>Status</span>
          <strong>{statusText}</strong>
        </div>
        <div>
          <span>Next source</span>
          <strong>{sourceHint}</strong>
        </div>
        <div>
          <span>Link mode</span>
          <strong>{lastMode}</strong>
        </div>
      </div>
      {linkRateLimitSeconds > 0 ? (
        <p className="plaid-status">
          Plaid rate limit active. You can request a new token in{" "}
          {linkRateLimitSeconds}s.
        </p>
      ) : null}
      {showLaunchPrompt ? (
        <div className="plaid-actions">
          {launchPromptText ? (
            <p className="plaid-status">{launchPromptText}</p>
          ) : null}
          <button
            type="button"
            className="chip chip-active"
            onClick={() => {
              if (!ready || !linkToken || linkToken !== preparedToken) {
                setError(
                  "Plaid is still initializing the token. Wait a second and click Launch again.",
                );
                return;
              }
              setError("");
              setShowLaunchPrompt(false);
              open();
            }}
          >
            Launch Plaid Modal
          </button>
        </div>
      ) : null}

      <div className="plaid-secondary-actions">
        <button type="button" className="chip" onClick={fetchLinkedItems}>
          Refresh Existing Connections
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
          <div className="plaid-connection-list">
            {filteredLinkedItems.map((item) => (
              <div key={item.item_id} className="plaid-connection">
                <div>
                  <strong>
                    {item.institution_name || "Unknown institution"}
                  </strong>
                  <span>{item.source_hint || "other"}</span>
                </div>
                <div className="plaid-connection-actions">
                  <button
                    type="button"
                    className="chip"
                    onClick={() =>
                      openWithSource(item.source_hint || "other", {
                        reconnectItemId: item.item_id,
                      })
                    }
                    disabled={linkRateLimitSeconds > 0}
                  >
                    Reconnect
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => syncExistingItem(item)}
                    disabled={getSyncCooldownSeconds(item.item_id) > 0}
                  >
                    {getSyncCooldownSeconds(item.item_id) > 0
                      ? `Sync (${getSyncCooldownSeconds(item.item_id)}s)`
                      : "Sync"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {filteredLinkedItems.length === 0 ? (
            <p className="plaid-status">
              No eligible connections found. Keep only Chase (any hint) and
              Venmo - Personal (venmo).
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="spend-error">{error}</p> : null}
    </section>
  );
}

export default PlaidConnectPanel;
