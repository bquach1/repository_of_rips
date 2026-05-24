import { useEffect, useMemo, useState } from "react";
import CollectrCardGrid from "../components/CollectrCardGrid";
import GameTabs from "../components/GameTabs";
import PortfolioStats from "../components/PortfolioStats";
import {
  buildGameList,
  COLLECTR_EXPORT_PATH,
  normalizeCollectrExport,
} from "../data/collectrCards";

function PortfolioPage() {
  const [selectedGame, setSelectedGame] = useState("All");
  const [cards, setCards] = useState([]);
  const [loadStatus, setLoadStatus] = useState("loading");
  const [loadError, setLoadError] = useState("");

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

  const games = useMemo(() => buildGameList(cards), [cards]);

  const filteredCards = useMemo(
    () =>
      selectedGame === "All"
        ? cards
        : cards.filter((card) => card.game === selectedGame),
    [cards, selectedGame],
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
    const totalDelta = filteredCards.reduce(
      (sum, card) => sum + card.priceDelta * card.quantity,
      0,
    );

    return {
      cardCount: filteredCards.length,
      totalQuantity,
      totalValue,
      totalDelta,
    };
  }, [filteredCards]);

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
