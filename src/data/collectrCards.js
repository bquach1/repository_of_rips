export const COLLECTR_EXPORT_PATH = "/collectr-portfolio-latest.json";

function inferGame(card) {
  const text = [card.name, card.set, card.rarity, card.cardNumber]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /\b(op\d{2}|eb\d{2}|prb\d{2}|sec|sr|tr|the azure sea|adventure on kami)/i.test(
      text,
    )
  ) {
    return "One Piece";
  }

  if (
    /pokemon|elite trainer box|booster bundle|illustration rare|special illustration rare|holofoil|\d{3}\/\d{3}/i.test(
      text,
    )
  ) {
    return "Pokemon";
  }

  if (/riftbound|spiritforged|origins|unleashed|epic|showcase/i.test(text)) {
    return "Riftbound";
  }

  return "Other";
}

function toNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeCollectrExport(payload) {
  const cards = Array.isArray(payload?.cards) ? payload.cards : [];

  return cards.map((card, idx) => ({
    id: `${card.index ?? idx + 1}-${(card.name || "card").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    index: card.index ?? idx + 1,
    game: inferGame(card),
    name: card.name || "Unknown Card",
    set: card.set || "Unknown Set",
    rarity: card.rarity || "N/A",
    cardNumber: card.cardNumber || "N/A",
    condition: card.condition || "N/A",
    finish: card.finish || "N/A",
    quantity: toNumber(card.quantity, 1),
    marketPrice: toNumber(card.marketPrice, 0),
    priceDelta: toNumber(card.priceDelta, 0),
    priceDeltaPercent: toNumber(card.priceDeltaPercent, 0),
    trend: card.trend || "flat",
    imageUrl: card.imageUrl || "",
    imageAlt: card.imageAlt || card.name || "Card image",
  }));
}

export function buildGameList(cards) {
  const uniqueGames = [...new Set(cards.map((card) => card.game))];
  return ["All", ...uniqueGames];
}
