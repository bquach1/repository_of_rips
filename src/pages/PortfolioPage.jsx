import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Segmented, Spin } from "antd";
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
import {
  normalizeText,
  money,
  toTime,
  dedupeTransactions,
  dedupeByAccountTimestamp,
} from "../utils/helpers";

const BACKEND_BASE_URL =
  import.meta.env.VITE_BACKEND_BASE_URL || "http://localhost:8000";

const SPEND_FETCH_LIMIT = 1000;
const MAX_RECENT_RECORDS = 100;
const RECENT_TRANSACTIONS_PAGE_SIZE = 10;
const CARD_GRID_PAGE_SIZE = 25;
const MANUAL_ZELLE_RECEIVED = 40 - 7;

function parseZelleTransaction(tx) {
  const description = String(tx.description || tx.merchant_name || "").trim();
  const normalizedDescription = normalizeText(description);
  const amount = Number(tx.amount || 0);
  const direction = amount >= 0 ? "Sent" : "Received";

  const patterns = [
    /zelle\s+(?:payment|transfer)?\s*to\s+(.+)$/i,
    /zelle\s+(?:payment|transfer)?\s*from\s+(.+)$/i,
    /(?:to|from)\s+(.+?)\s+zelle/i,
  ];

  let counterparty = "";
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match?.[1]) {
      counterparty = match[1].replace(/[.,\-\s]+$/g, "").trim();
      if (counterparty) break;
    }
  }

  if (!counterparty) {
    const merchant = String(tx.merchant_name || "").trim();
    if (merchant && normalizeText(merchant) !== "zelle") {
      counterparty = merchant;
    }
  }

  const type =
    normalizedDescription.includes("transfer") ||
    normalizedDescription.includes("payment")
      ? "Transfer"
      : "Transaction";

  return {
    direction,
    type,
    counterparty,
    title: counterparty
      ? `${direction} ${type}: ${counterparty}`
      : `${direction} ${type}`,
  };
}

export default function PortfolioPage() {
  const [selectedGame, setSelectedGame] = useState("All");
  const [cards, setCards] = useState([]);
  const [loadStatus, setLoadStatus] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [spendStatus, setSpendStatus] = useState("loading");
  const [spendError, setSpendError] = useState("");
  const [spendTransactions, setSpendTransactions] = useState([]);
  const [venmoTransactions, setVenmoTransactions] = useState([]);
  const [zelleTransactions, setZelleTransactions] = useState([]);
  const [recentView, setRecentView] = useState({ source: "chase", page: 1 });
  const [cardGridPage, setCardGridPage] = useState(1);

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

  const chaseCardStoreTransactions = useMemo(
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
      const dateParams = new URLSearchParams({
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      });

      const [txRes, venmoRes, zelleRes] = await Promise.all([
        fetch(
          `${BACKEND_BASE_URL}/api/spend/transactions?${dateParams.toString()}&include_pending=true&limit=${SPEND_FETCH_LIMIT}&auto_sync=true`,
          {
            cache: "no-cache",
          },
        ),
        fetch(
          `${BACKEND_BASE_URL}/api/spend/transactions?${dateParams.toString()}&include_pending=true&source=venmo&limit=${SPEND_FETCH_LIMIT}&auto_sync=false`,
          {
            cache: "no-cache",
          },
        ),
        fetch(
          `${BACKEND_BASE_URL}/api/spend/transactions?${dateParams.toString()}&include_pending=true&source=zelle&limit=${SPEND_FETCH_LIMIT}&auto_sync=false`,
          {
            cache: "no-cache",
          },
        ),
      ]);

      if (!txRes.ok) {
        throw new Error(`Spend transactions failed (${txRes.status})`);
      }
      if (!venmoRes.ok) {
        throw new Error(`Venmo transactions failed (${venmoRes.status})`);
      }
      if (!zelleRes.ok) {
        throw new Error(`Zelle transactions failed (${zelleRes.status})`);
      }

      const txPayload = await txRes.json();
      const transactions = Array.isArray(txPayload.transactions)
        ? txPayload.transactions
        : [];
      const venmoPayload = await venmoRes.json();
      const venmoTransactionsRaw = Array.isArray(venmoPayload.transactions)
        ? venmoPayload.transactions
        : [];
      const zellePayload = await zelleRes.json();
      const zelleTransactionsRaw = Array.isArray(zellePayload.transactions)
        ? zellePayload.transactions
        : [];
      const dedupedTransactions = dedupeByAccountTimestamp(
        dedupeTransactions(transactions),
      );
      const dedupedVenmoTransactions = dedupeByAccountTimestamp(
        dedupeTransactions(venmoTransactionsRaw),
      );
      const dedupedZelleTransactions = dedupeByAccountTimestamp(
        dedupeTransactions(zelleTransactionsRaw),
      );

      setSpendTransactions(dedupedTransactions);
      setVenmoTransactions(dedupedVenmoTransactions);
      setZelleTransactions(dedupedZelleTransactions);
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

  const totalCardPages = Math.max(
    1,
    Math.ceil(filteredCards.length / CARD_GRID_PAGE_SIZE),
  );

  const currentCardPage = Math.min(cardGridPage, totalCardPages);

  const paginatedCards = useMemo(() => {
    const start = (currentCardPage - 1) * CARD_GRID_PAGE_SIZE;
    return filteredCards.slice(start, start + CARD_GRID_PAGE_SIZE);
  }, [currentCardPage, filteredCards]);

  const onSelectGame = useCallback((game) => {
    setSelectedGame(game);
    setCardGridPage(1);
  }, []);

  const chaseCardStoreSpend = useMemo(
    () =>
      chaseCardStoreTransactions.reduce(
        (sum, tx) => sum + Number(tx.amount || 0),
        0,
      ),
    [chaseCardStoreTransactions],
  );

  const venmoBreakdown = useMemo(() => {
    const sorted = [...venmoTransactions].sort((a, b) => {
      const dateDiff = toTime(a.date) - toTime(b.date);
      if (dateDiff !== 0) return dateDiff;
      return Number(a.amount || 0) - Number(b.amount || 0);
    });

    const cardIncomingPool = [];
    let loss = 0;
    let profit = 0;

    for (const tx of sorted) {
      const description = normalizeText(
        tx.description || tx.merchant_name || "",
      );
      const isStandardTransfer = description.includes("standard transfer");
      const keywordMatches = Array.isArray(tx.venmo_card_keyword_matches)
        ? tx.venmo_card_keyword_matches
        : [];
      const amount = Number(tx.amount || 0);

      if (!Number.isFinite(amount) || amount === 0) {
        continue;
      }

      if (isStandardTransfer) {
        if (amount <= 0) {
          continue;
        }

        let remainingTransfer = amount;

        for (const candidate of cardIncomingPool) {
          if (remainingTransfer <= 0) {
            break;
          }
          if (candidate.unmatched <= 0) {
            continue;
          }

          const matchAmount = Math.min(candidate.unmatched, remainingTransfer);
          candidate.unmatched -= matchAmount;
          remainingTransfer -= matchAmount;
          profit += matchAmount;
        }

        continue;
      }

      if (keywordMatches.length > 0) {
        if (amount < 0) {
          loss += Math.abs(amount);
        } else {
          cardIncomingPool.push({ unmatched: amount });
        }
      }
    }

    return { profit, loss };
  }, [venmoTransactions]);

  const venmoNet = useMemo(
    () => venmoBreakdown.loss - venmoBreakdown.profit,
    [venmoBreakdown],
  );

  const cardStoreTotalSpend = useMemo(
    () => chaseCardStoreSpend,
    [chaseCardStoreSpend],
  );

  const zelleBreakdown = useMemo(() => {
    let sent = 0;
    let received = 0;

    for (const tx of zelleTransactions) {
      const amount = Number(tx.amount || 0);
      if (!Number.isFinite(amount) || amount === 0) {
        continue;
      }

      if (amount > 0) {
        sent += amount;
      } else {
        received += Math.abs(amount);
      }
    }

    const totalReceived = received + MANUAL_ZELLE_RECEIVED;

    return {
      sent,
      received: totalReceived,
      manualReceived: MANUAL_ZELLE_RECEIVED,
      net: sent - totalReceived,
    };
  }, [zelleTransactions]);

  const sortTransactionsNewestFirst = useCallback((transactions) => {
    return [...transactions].sort((a, b) => {
      const dateDiff = toTime(b.date) - toTime(a.date);
      if (dateDiff !== 0) return dateDiff;
      return Number(b.amount || 0) - Number(a.amount || 0);
    });
  }, []);

  const chaseRecentTransactions = useMemo(
    () =>
      sortTransactionsNewestFirst(chaseCardStoreTransactions).slice(
        0,
        MAX_RECENT_RECORDS,
      ),
    [chaseCardStoreTransactions, sortTransactionsNewestFirst],
  );

  const venmoRecentTransactions = useMemo(
    () =>
      sortTransactionsNewestFirst(
        venmoTransactions.filter((tx) => {
          const keywordMatches = Array.isArray(tx.venmo_card_keyword_matches)
            ? tx.venmo_card_keyword_matches
            : [];
          return keywordMatches.length > 0;
        }),
      ).slice(0, MAX_RECENT_RECORDS),
    [venmoTransactions, sortTransactionsNewestFirst],
  );

  const zelleRecentTransactions = useMemo(
    () =>
      sortTransactionsNewestFirst(zelleTransactions)
        .slice(0, MAX_RECENT_RECORDS)
        .map((tx) => ({
          ...tx,
          zelleParsed: parseZelleTransaction(tx),
        })),
    [zelleTransactions, sortTransactionsNewestFirst],
  );

  const recentTransactions =
    recentView.source === "venmo"
      ? venmoRecentTransactions
      : recentView.source === "zelle"
        ? zelleRecentTransactions
        : chaseRecentTransactions;

  const totalRecentPages = Math.max(
    1,
    Math.ceil(recentTransactions.length / RECENT_TRANSACTIONS_PAGE_SIZE),
  );

  const recentPage = Math.min(recentView.page, totalRecentPages);

  const paginatedRecentTransactions = useMemo(() => {
    const start = (recentPage - 1) * RECENT_TRANSACTIONS_PAGE_SIZE;
    return recentTransactions.slice(
      start,
      start + RECENT_TRANSACTIONS_PAGE_SIZE,
    );
  }, [recentPage, recentTransactions]);

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
      venmoBreakdown.profit +
      MANUAL_ZELLE_RECEIVED;

    return {
      cardCount: filteredCards.length,
      totalQuantity,
      totalValue,
      totalDelta,
    };
  }, [filteredCards, cardStoreTotalSpend, venmoBreakdown]);

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Repository of Rips</p>
        <h1>TCG Portfolio Tracker/Spend Analyzer</h1>
        <p>
          A TCG portfolio and spend analysis tool to keep myself responsible.
          Card data and values are sourced from public Collectr data on the web,
          and financial data connects to Venmo/Chase/Zelle spend via Plaid.
        </p>
      </header>

      {loadStatus === "loading" && (
        <Spin
          tip="Loading portfolio data..."
          size="large"
          className="loading-spinner"
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "2rem 0",
          }}
        />
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
                    <h3>Card Store Spend (2026)</h3>
                    <p>{money(cardStoreTotalSpend)}</p>
                  </article>
                  <article>
                    <h3>Venmo Loss (Keyword/Card-Related, 2026)</h3>
                    <p>{money(venmoBreakdown.loss)}</p>
                  </article>
                  <article>
                    <h3>Venmo Profit (Matched Standard Transfer, 2026)</h3>
                    <p>{money(venmoBreakdown.profit)}</p>
                  </article>
                  <article>
                    <h3>Venmo Net Impact (2026)</h3>
                    <p>{money(venmoNet)}</p>
                  </article>
                  <article>
                    <h3>Zelle Sent (2026)</h3>
                    <p>{money(zelleBreakdown.sent)}</p>
                  </article>
                  <article>
                    <h3>Zelle Manual Received (Hardcoded)</h3>
                    <p>{money(zelleBreakdown.manualReceived)}</p>
                  </article>
                  <article>
                    <h3>Zelle Received (2026)</h3>
                    <p>{money(zelleBreakdown.received)}</p>
                  </article>
                  <article>
                    <h3>Zelle Net Impact (2026)</h3>
                    <p>{money(zelleBreakdown.net)}</p>
                  </article>
                </div>

                <div className="transactions-list-wrap">
                  <h3>Recent Transactions</h3>
                  <div className="transactions-filter-group">
                    <Segmented
                      options={[
                        { label: "Chase", value: "chase" },
                        { label: "Venmo", value: "venmo" },
                        { label: "Zelle", value: "zelle" },
                      ]}
                      value={recentView.source}
                      onChange={(value) =>
                        setRecentView({ source: String(value), page: 1 })
                      }
                    />
                  </div>

                  {recentTransactions.length === 0 ? (
                    <p>
                      No qualifying{" "}
                      {recentView.source === "venmo"
                        ? "Venmo"
                        : recentView.source === "zelle"
                          ? "Zelle"
                          : "Chase"}{" "}
                      transactions synced yet.
                    </p>
                  ) : (
                    <>
                      <ul className="transactions-list">
                        {paginatedRecentTransactions.map((tx, index) => (
                          <li
                            key={
                              tx.plaid_transaction_id ||
                              `${recentView.source}-${tx.date}-${tx.amount}-${tx.description}-${index}`
                            }
                          >
                            <div>
                              <p className="tx-merchant">
                                {recentView.source === "zelle"
                                  ? tx.zelleParsed?.title ||
                                    tx.merchant_name ||
                                    tx.description ||
                                    "Transaction"
                                  : tx.merchant_name ||
                                    tx.description ||
                                    "Transaction"}
                              </p>
                              <p className="tx-meta">
                                {(tx.source || "other").toUpperCase()}
                                {recentView.source === "zelle"
                                  ? ` • ${tx.zelleParsed?.direction || "Unknown"}`
                                  : ""}{" "}
                                • {tx.date}
                              </p>
                            </div>
                            <p className="tx-amount">{money(tx.amount)}</p>
                          </li>
                        ))}
                      </ul>
                      <div className="transactions-pagination">
                        <Button
                          onClick={() =>
                            setRecentView((view) => ({
                              ...view,
                              page: Math.max(1, recentPage - 1),
                            }))
                          }
                          disabled={recentPage === 1}
                        >
                          Previous
                        </Button>
                        <p>
                          Page {recentPage} of {totalRecentPages}
                        </p>
                        <Button
                          onClick={() =>
                            setRecentView((view) => ({
                              ...view,
                              page: Math.min(totalRecentPages, recentPage + 1),
                            }))
                          }
                          disabled={recentPage === totalRecentPages}
                        >
                          Next
                        </Button>
                      </div>
                    </>
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
              onSelectGame={onSelectGame}
            />
          </section>
          <PortfolioStats {...totals} />
          <CollectrCardGrid cards={paginatedCards} />
          {filteredCards.length > 0 && (
            <section className="surface card-grid-pagination-wrap">
              <div className="card-grid-pagination">
                <Button
                  onClick={() =>
                    setCardGridPage(Math.max(1, currentCardPage - 1))
                  }
                  disabled={currentCardPage === 1}
                >
                  Previous
                </Button>
                <p>
                  Cards Page {currentCardPage} of {totalCardPages}
                </p>
                <Button
                  onClick={() =>
                    setCardGridPage(
                      Math.min(totalCardPages, currentCardPage + 1),
                    )
                  }
                  disabled={currentCardPage === totalCardPages}
                >
                  Next
                </Button>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
