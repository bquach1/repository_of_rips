export const COLLECTR_EXPORT_PATH = "/collectr-portfolio-latest.json";

const GAME_BY_SET_KEYWORD = [
  // One Piece sets
  ["adventure on kami", "One Piece"],
  ["carrying on his will", "One Piece"],
  ["the time of battle", "One Piece"],
  ["the azure sea", "One Piece"],
  // Riftbound sets
  ["riftbound", "Riftbound"],
  ["spiritforged", "Riftbound"],
  ["pitch black", "Riftbound"],
  ["vendetta", "Riftbound"],
  ["origins", "Riftbound"],
  ["unleashed", "Riftbound"],
  // Pokemon sets
  ["pokemon", "Pokemon"],
  ["30th celebration", "Pokemon"],
  ["chaos rising", "Pokemon"],
];

function inferBySet(text) {
  for (const [keyword, game] of GAME_BY_SET_KEYWORD) {
    if (text.includes(keyword)) return game;
  }
  return "";
}

function inferGame(card) {
  const text = [card.name, card.set, card.rarity, card.cardNumber, card.finish]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const setFirst = inferBySet(String(card.set || "").toLowerCase());
  if (setFirst) {
    return setFirst;
  }

  const onePieceCode = /\b(?:op|eb|prb|st)\d{2}[- ]?\d{3}\b/i;
  if (onePieceCode.test(text)) {
    return "One Piece";
  }

  if (
    /\bone piece\b|don\!\!|leader card|character card/i.test(text)
  ) {
    return "One Piece";
  }

  if (
    /pokemon|elite trainer box|booster bundle|illustration rare|special illustration rare|holofoil|\bex\b|vmax|vstar|trainer box/i.test(
      text,
    )
  ) {
    return "Pokemon";
  }

  if (
    /riftbound|spiritforged|pitch black|vendetta|origins|unleashed|overnumbered|showcase/i.test(
      text,
    )
  ) {
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
