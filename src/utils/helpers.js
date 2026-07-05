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
  const byPlaidId = new Map();
  const bySemanticKey = new Map();

  const choosePreferred = (current, candidate) => {
    if (!current) return candidate;
    if (!candidate) return current;

    const currentPending = Number(Boolean(current?.pending));
    const candidatePending = Number(Boolean(candidate?.pending));

    // Prefer posted over pending for the same purchase footprint.
    if (currentPending === 1 && candidatePending === 0) {
      return candidate;
    }
    return current;
  };

  for (const tx of transactions) {
    if (!tx || typeof tx !== "object") {
      continue;
    }

    const normalizedMerchant = normalizeText(tx.merchant_name || "");
    const normalizedDescription = normalizeText(
      tx.description || tx.name || tx.counterparty || "",
    );

    const normalizedFingerprint = normalizeText(
      `${tx.merchant_name || ""} ${tx.description || tx.name || tx.counterparty || ""}`,
    );

    const plaidId = String(tx.plaid_transaction_id || "").trim();
    const semanticKey = [
      tx.source || "other",
      tx.date || "",
      Number(tx.amount || 0),
      normalizedMerchant,
      normalizedDescription,
      normalizedFingerprint,
      tx.iso_currency_code || "USD",
    ].join("|");

    if (plaidId) {
      const existingById = byPlaidId.get(plaidId);
      byPlaidId.set(plaidId, choosePreferred(existingById, tx));
    }

    const existingBySemantic = bySemanticKey.get(semanticKey);
    bySemanticKey.set(semanticKey, choosePreferred(existingBySemantic, tx));
  }

  const seenOutputIds = new Set();
  const result = [];

  for (const tx of bySemanticKey.values()) {
    if (!tx || typeof tx !== "object") {
      continue;
    }

    const plaidId = String(tx.plaid_transaction_id || "").trim();

    if (plaidId) {
      const preferredById = byPlaidId.get(plaidId);
      if (preferredById && preferredById !== tx) {
        continue;
      }
      if (seenOutputIds.has(plaidId)) {
        continue;
      }
      seenOutputIds.add(plaidId);
    }

    result.push(tx);
  }

  return result;
}

export function dedupeByAccountTimestamp(transactions) {
  const byKey = new Map();

  const choosePreferred = (current, candidate) => {
    if (!current) return candidate;
    if (!candidate) return current;

    const currentPending = Number(Boolean(current.pending));
    const candidatePending = Number(Boolean(candidate.pending));

    // Keep posted over pending when they represent the same authorization footprint.
    if (currentPending === 1 && candidatePending === 0) {
      return candidate;
    }
    if (currentPending === 0 && candidatePending === 1) {
      return current;
    }

    const currentDate = Date.parse(current.date || "");
    const candidateDate = Date.parse(candidate.date || "");
    if (!Number.isNaN(candidateDate) && !Number.isNaN(currentDate)) {
      return candidateDate > currentDate ? candidate : current;
    }

    return current;
  };

  for (const tx of transactions) {
    if (!tx || typeof tx !== "object") {
      continue;
    }

    const normalizedMerchant = normalizeText(tx.merchant_name || "");
    const normalizedDescription = normalizeText(
      tx.description || tx.name || tx.counterparty || "",
    );
    const accountStamp = String(
      tx.account_name || tx.account_id || "unknown",
    ).trim();
    const amount = Number(tx.amount || 0);
    const baseParts = [
      tx.source || "other",
      amount,
      normalizedMerchant,
      normalizedDescription,
    ];

    const stampTime = Date.parse(accountStamp);
    const hasTimestampStamp = !Number.isNaN(stampTime);
    const dedupeKey = hasTimestampStamp
      ? [...baseParts, accountStamp].join("|")
      : [...baseParts, tx.date || "", Number(Boolean(tx.pending))].join("|");

    const existing = byKey.get(dedupeKey);
    byKey.set(dedupeKey, choosePreferred(existing, tx));
  }

  return Array.from(byKey.values());
}
