import { useCallback, useEffect, useMemo, useState } from "react";
import CollectrCardGrid from "../components/CollectrCardGrid";
import GameTabs from "../components/GameTabs";
import PlaidConnectPanel from "../components/PlaidConnectPanel";
import PortfolioStats from "../components/PortfolioStats";
import {
  buildGameList,
  COLLECTR_EXPORT_PATH,
  normalizeCollectrExport,
} from "../data/collectrCards";
import { CARD_STORE_NAMES } from "../utils/constants";
import { normalizeText } from "../utils/normalizationFunctions";

const BACKEND_BASE_URL =
  import.meta.env.VITE_BACKEND_BASE_URL || "http://localhost:8000";

function dedupeTransactions(transactions) {
  const seen = new Set();

  return transactions.filter((tx) => {
    const normalizedName = normalizeText(
      tx.merchant_name || tx.description || tx.name || tx.counterparty || "",
    );

    const key =
      tx.plaid_transaction_id ||
      [
        tx.source || "other",
        tx.date || "",
        tx.amount || 0,
        normalizedName,
      ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function dedupeByAccountTimestamp(transactions) {
  const seen = new Set();

  return transactions.filter((tx) => {
    const normalizedName = normalizeText(
      tx.merchant_name || tx.description || tx.name || tx.counterparty || "",
    );

    const accountStamp = String(tx.account_name || "").trim();
    const dedupeKey = [
      accountStamp,
      tx.date || "",
      Number(tx.amount || 0),
      normalizedName,
    ].join("|");

    if (!accountStamp) {
      return true;
    }

    if (seen.has(dedupeKey)) {
      return false;
    }

    seen.add(dedupeKey);
    return true;
  });
}

function PortfolioPage() {
  const [selectedGame, setSelectedGame] = useState("All");
  const [cards, setCards] = useState([]);
  const [loadStatus, setLoadStatus] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [spendStatus, setSpendStatus] = useState("loading");
  const [spendError, setSpendError] = useState("");
  const [spendTransactions, setSpendTransactions] = useState([]);
  const [venmoTransactions, setVenmoTransactions] = useState([]);

  useEffect(() => {
    let active = true;

    async function loadCards() {
      try {
        setLoadStatus("loading");
        const response = await fetch(COLLECTR_EXPORT_PATH, {
          cache: "no-cache",
        });

        if (!response.ok) {
          throw new Error(`Could not load export JSON (${response.status})`);
        }

        const payload = await response.json();
        const normalized = normalizeCollectrExport(payload);

        if (!active) return;
        setCards(normalized);
        setLoadStatus("ready");
      } catch (error) {
        if (!active) return;
        setLoadStatus("error");
        setLoadError(error.message || "Unable to load export JSON");
      }
    }

    loadCards();
    return () => {
      active = false;
    };
  }, []);

  const allowedStoreSet = useMemo(
    () => new Set(CARD_STORE_NAMES.map((store) => normalizeText(store))),
    [],
  );

  const cardStoreTransactions = useMemo(
    () =>
      spendTransactions.filter((tx) => {
        const txName = normalizeText(tx.merchant_name || tx.description || "");
        if (!txName) return false;

        if (allowedStoreSet.has(txName)) return true;

        for (const store of allowedStoreSet) {
          if (txName.includes(store) || store.includes(txName)) return true;
        }
        return false;
      }),
    [spendTransactions, allowedStoreSet],
  );

  const loadSpendData = useCallback(async () => {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 2);

      const formatDate = (value) => value.toISOString().slice(0, 10);
      const dateParams = new URLSearchParams({
        start_date: formatDate(startDate),
        end_date: formatDate(endDate),
      });

      const [summaryRes, txRes, venmoRes] = await Promise.all([
        fetch(
          `${BACKEND_BASE_URL}/api/spend/summary?${dateParams.toString()}`,
          {
            cache: "no-cache",
          },
        ),
        fetch(
          `${BACKEND_BASE_URL}/api/spend/transactions?${dateParams.toString()}&limit=1000`,
          {
            cache: "no-cache",
          },
        ),
        fetch(
          `${BACKEND_BASE_URL}/api/spend/transactions?${dateParams.toString()}&source=venmo&limit=1000`,
          {
            cache: "no-cache",
          },
        ),
      ]);

      if (!summaryRes.ok) {
        throw new Error(`Spend summary failed (${summaryRes.status})`);
      }
      if (!txRes.ok) {
        throw new Error(`Spend transactions failed (${txRes.status})`);
      }
      if (!venmoRes.ok) {
        throw new Error(`Venmo transactions failed (${venmoRes.status})`);
      }

      const txPayload = await txRes.json();
      const transactions = Array.isArray(txPayload.transactions)
        ? txPayload.transactions
        : [];
      const venmoPayload = await venmoRes.json();
      const venmoTransactionsRaw = Array.isArray(venmoPayload.transactions)
        ? venmoPayload.transactions
        : [];
      const dedupedTransactions = dedupeByAccountTimestamp(
        dedupeTransactions(transactions),
      );
      const dedupedVenmoTransactions = dedupeByAccountTimestamp(
        dedupeTransactions(venmoTransactionsRaw),
      );

      setSpendTransactions(dedupedTransactions);
      setVenmoTransactions(dedupedVenmoTransactions);
      setSpendStatus("ready");
    } catch (error) {
      setSpendStatus("error");
      setSpendError(error.message || "Unable to load spend data");
    }
  }, []);

  const refreshSpendData = useCallback(async () => {
    setSpendStatus("loading");
    setSpendError("");
    await loadSpendData();
  }, [loadSpendData]);

  useEffect(() => {
    loadSpendData().catch(() => null);
  }, [loadSpendData]);

  const games = useMemo(() => buildGameList(cards), [cards]);

  const filteredCards = useMemo(
    () =>
      selectedGame === "All"
        ? cards
        : cards.filter((card) => card.game === selectedGame),
    [cards, selectedGame],
  );

  const cardStoreTotalSpend = useMemo(
    () =>
      cardStoreTransactions.reduce(
        (sum, tx) => sum + Number(tx.amount || 0),
        0,
      ),
    [cardStoreTransactions],
  );

  const venmoBreakdown = useMemo(() => {
    return venmoTransactions.reduce(
      (acc, tx) => {
        const description = normalizeText(
          tx.description || tx.merchant_name || "",
        );
        const isStandardTransfer = description.includes("standard transfer");
        const keywordMatches = Array.isArray(tx.venmo_card_keyword_matches)
          ? tx.venmo_card_keyword_matches
          : [];
        const amount = Number(tx.amount || 0);

        if (isStandardTransfer) {
          acc.profit += amount;
          return acc;
        }

        if (keywordMatches.length > 0) {
          acc.loss += amount;
        }

        return acc;
      },
      { profit: 0, loss: 0 },
    );
  }, [venmoTransactions]);

  const venmoNet = useMemo(
    () => venmoBreakdown.loss - venmoBreakdown.profit,
    [venmoBreakdown],
  );

  const totals = useMemo(() => {
    const totalQuantity = filteredCards.reduce(
      (sum, card) => sum + card.quantity,
      0,
    );
    const totalValue = filteredCards.reduce(
      (sum, card) => sum + card.marketPrice * card.quantity,
      0,
    );
    const totalDelta =
      totalValue -
      cardStoreTotalSpend -
      venmoBreakdown.loss +
      venmoBreakdown.profit;

    return {
      cardCount: filteredCards.length,
      totalQuantity,
      totalValue,
      totalDelta,
    };
  }, [filteredCards, cardStoreTotalSpend, venmoBreakdown]);

  const money = (value) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(Number(value || 0));

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Collectr Portfolio</p>
        <h1>Market Snapshot</h1>
        <p>Card pricing cards rendered from your live Collectr export JSON.</p>
      </header>

      {loadStatus === "loading" && (
        <section className="surface">
          <h2>Loading portfolio data...</h2>
        </section>
      )}

      {loadStatus === "error" && (
        <section className="surface empty-state">
          <h2>Could not load export JSON</h2>
          <p>{loadError}</p>
          <p>
            Expected file at <strong>{COLLECTR_EXPORT_PATH}</strong>
          </p>
        </section>
      )}

      {loadStatus === "ready" && (
        <>
          <PlaidConnectPanel onLinked={refreshSpendData} />

          <section className="surface">
            <h2>Spend Sync Snapshot</h2>
            {spendStatus === "loading" && (
              <p>Loading spend summary and transactions...</p>
            )}
            {spendStatus === "error" && (
              <p className="spend-error">
                {spendError}. Check backend at{" "}
                <strong>{BACKEND_BASE_URL}</strong>
              </p>
            )}
            {spendStatus === "ready" && (
              <>
                <div className="spend-overview">
                  <article>
                    <h3>Card Store Spend (2 Months)</h3>
                    <p>{money(cardStoreTotalSpend)}</p>
                  </article>
                  <article>
                    <h3>Venmo Loss (Keyword/Card-Related)</h3>
                    <p>{money(venmoBreakdown.loss)}</p>
                  </article>
                  <article>
                    <h3>Venmo Profit (Standard Transfer)</h3>
                    <p>{money(venmoBreakdown.profit)}</p>
                  </article>
                  <article>
                    <h3>Venmo Net Impact (2 Months)</h3>
                    <p>{money(venmoNet)}</p>
                  </article>
                </div>

                <div className="transactions-list-wrap">
                  <h3>Recent Transactions</h3>
                  {cardStoreTransactions.length === 0 ? (
                    <p>No spend transactions synced yet.</p>
                  ) : (
                    <ul className="transactions-list">
                      {cardStoreTransactions.slice(0, 10).map((tx) => (
                        <li
                          key={
                            tx.plaid_transaction_id ||
                            `${tx.date}-${tx.amount}-${tx.description}`
                          }
                        >
                          <div>
                            <p className="tx-merchant">
                              {tx.merchant_name ||
                                tx.description ||
                                "Transaction"}
                            </p>
                            <p className="tx-meta">
                              {(tx.source || "other").toUpperCase()} • {tx.date}
                            </p>
                          </div>
                          <p className="tx-amount">{money(tx.amount)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="surface">
            <h2>Game</h2>
            <GameTabs
              games={games}
              selectedGame={selectedGame}
              onSelectGame={setSelectedGame}
            />
          </section>

          <PortfolioStats {...totals} />
          <CollectrCardGrid cards={filteredCards} />
        </>
      )}
    </main>
  );
}

export default PortfolioPage;
