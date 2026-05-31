export const normalizeText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function toTime(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function dedupeTransactions(transactions) {
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

export function dedupeByAccountTimestamp(transactions) {
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
