#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const ROOT_DIR = process.cwd();
const DEFAULT_PORTFOLIO_URL =
  "https://app.getcollectr.com/showcase/profile/@palo90";
const DEFAULT_STATE_PATH = path.join(
  ROOT_DIR,
  ".auth",
  "collectr-storage-state.json",
);

function loadDotEnv(filePath = path.join(ROOT_DIR, ".env")) {
  return fs
    .readFile(filePath, "utf8")
    .then((raw) => {
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;

        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^['\"]|['\"]$/g, "");
        if (key && process.env[key] === undefined) process.env[key] = value;
      }
    })
    .catch(() => {
      // Ignore if .env does not exist.
    });
}

function parseArgs(argv) {
  const options = {
    headed: false,
    saveState: true,
    outDir: path.join(ROOT_DIR, "exports"),
    format: "both",
    portfolioUrl: process.env.COLLECTR_PORTFOLIO_URL || DEFAULT_PORTFOLIO_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--headed") options.headed = true;
    else if (arg === "--no-save-state") options.saveState = false;
    else if (arg === "--json-only") options.format = "json";
    else if (arg === "--csv-only") options.format = "csv";
    else if (arg === "--out") {
      options.outDir = path.resolve(argv[i + 1] || options.outDir);
      i += 1;
    } else if (arg === "--url") {
      options.portfolioUrl = argv[i + 1] || options.portfolioUrl;
      i += 1;
    }
  }

  return options;
}

function parseMoney(text) {
  if (!text) return null;
  const normalized = text.replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function parsePercent(text) {
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

function parseQty(text) {
  if (!text) return 1;
  const match = text.match(/qty\s*:\s*(\d+)/i);
  if (!match) return 1;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : 1;
}

function asCsv(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function isAuthUrl(url) {
  return /auth\.getcollectr\.com/i.test(url) || /\/login/i.test(url);
}

async function ensureLoggedIn(page, email, password, portfolioUrl) {
  const requiresAuth = async () => {
    const url = page.url();
    if (isAuthUrl(url)) return true;

    return page
      .locator('input[type="password"], input[type="email"]')
      .first()
      .isVisible({ timeout: 1200 })
      .catch(() => false);
  };

  if (!(await requiresAuth())) return;

  if (!email || !password) {
    throw new Error(
      "Login required. Set COLLECTR_EMAIL and COLLECTR_PASSWORD in environment variables or .env.",
    );
  }

  const emailField = page.locator(
    'input[type="email"], input[name*="email" i]',
  );
  const passwordField = page.locator(
    'input[type="password"], input[name*="password" i]',
  );

  await emailField.first().waitFor({ timeout: 45000 });
  await emailField.first().fill(email);

  const passwordVisibleNow = await passwordField
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!passwordVisibleNow) {
    const continueButton = page
      .locator(
        'button[type="submit"], button:has-text("Continue"), button:has-text("Next")',
      )
      .first();
    await continueButton.click();
    await passwordField.first().waitFor({ timeout: 45000 });
  }

  await passwordField.first().fill(password);

  const signInButton = page
    .locator(
      'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")',
    )
    .first();

  await signInButton.click();

  try {
    await page.waitForURL(
      (url) =>
        !/auth\.getcollectr\.com/i.test(url.host) &&
        !/\/login/i.test(url.pathname),
      { timeout: 120000 },
    );
  } catch {
    throw new Error(
      "Could not confirm login automatically. Re-run with --headed and complete any MFA/challenge flow.",
    );
  }

  await page.goto(portfolioUrl, { waitUntil: "domcontentloaded" });
}

async function scrollUntilStable(page, selector) {
  let stableCount = 0;
  let previousCount = 0;

  for (let i = 0; i < 60; i += 1) {
    const currentCount = await page.locator(selector).count();
    if (currentCount === previousCount) stableCount += 1;
    else stableCount = 0;

    if (stableCount >= 3) break;

    previousCount = currentCount;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
}

function normalizeCards(cards) {
  return cards.map((card, idx) => {
    const price = parseMoney(card.priceText);
    const changeAmount = parseMoney(card.changeAmountText);
    const changePercent = parsePercent(card.changePercentText);
    const qty = parseQty(card.qtyText);

    return {
      index: idx + 1,
      name: card.name,
      set: card.setName,
      rarity: card.rarity,
      cardNumber: card.cardNumber,
      condition: card.condition,
      finish: card.finish,
      quantity: qty,
      marketPrice: price,
      priceDelta: changeAmount,
      priceDeltaPercent: changePercent,
      trend: card.trend,
      imageUrl: card.imageUrl,
      imageAlt: card.imageAlt,
      raw: {
        priceText: card.priceText,
        changeAmountText: card.changeAmountText,
        changePercentText: card.changePercentText,
        qtyText: card.qtyText,
      },
    };
  });
}

async function writeOutputs(cards, outDir, format) {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();

  await fs.mkdir(outDir, { recursive: true });

  const result = { jsonPath: null, csvPath: null, latestJsonPath: null };

  if (format === "both" || format === "json") {
    const jsonPath = path.join(outDir, `collectr-portfolio-${dateStamp}.json`);
    const payload = {
      exportedAt: timestamp,
      cardCount: cards.length,
      totalQuantity: cards.reduce((sum, item) => sum + item.quantity, 0),
      cards,
    };

    await fs.writeFile(
      jsonPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );

    // Keep a stable file path for the frontend to fetch latest portfolio data.
    const publicLatestPath = path.join(
      ROOT_DIR,
      "public",
      "collectr-portfolio-latest.json",
    );
    await fs.mkdir(path.dirname(publicLatestPath), { recursive: true });
    await fs.writeFile(
      publicLatestPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );

    result.jsonPath = jsonPath;
    result.latestJsonPath = publicLatestPath;
  }

  if (format === "both" || format === "csv") {
    const csvPath = path.join(outDir, `collectr-portfolio-${dateStamp}.csv`);
    const headers = [
      "index",
      "name",
      "set",
      "rarity",
      "cardNumber",
      "condition",
      "finish",
      "quantity",
      "marketPrice",
      "priceDelta",
      "priceDeltaPercent",
      "trend",
      "imageUrl",
      "imageAlt",
    ];

    const rows = cards.map((card) =>
      headers.map((key) => asCsv(card[key])).join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");
    await fs.writeFile(csvPath, `${csv}\n`, "utf8");
    result.csvPath = csvPath;
  }

  return result;
}

async function main() {
  await loadDotEnv();

  const options = parseArgs(process.argv.slice(2));
  const email = process.env.COLLECTR_EMAIL;
  const password = process.env.COLLECTR_PASSWORD;

  const browser = await chromium.launch({ headless: !options.headed });

  try {
    const storageStateExists = await fs
      .access(DEFAULT_STATE_PATH)
      .then(() => true)
      .catch(() => false);

    const context = await browser.newContext({
      storageState: storageStateExists ? DEFAULT_STATE_PATH : undefined,
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();

    await page.goto(options.portfolioUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    // Public showcase URLs do not require auth; private portfolio URLs do.
    if (isAuthUrl(page.url())) {
      if (email && password) {
        await ensureLoggedIn(page, email, password, options.portfolioUrl);
      } else {
        throw new Error(
          "This URL requires login. Use a public showcase URL (for example: https://app.getcollectr.com/showcase/profile/@username) or set COLLECTR_EMAIL and COLLECTR_PASSWORD for private portfolio exports.",
        );
      }
    }

    const cardSelector = "ul.contents > li.h-full.list-none";
    await page.locator(cardSelector).first().waitFor({ timeout: 90000 });

    await scrollUntilStable(page, cardSelector);

    const rawCards = await page.$$eval(cardSelector, (nodes) =>
      nodes.map((node) => {
        const text = (selector) => {
          const el = node.querySelector(selector);
          return el ? el.textContent.trim() : "";
        };

        const metaRow = node.querySelector(
          "div.flex.flex-row.flex-wrap.items-center.space-x-1.text-muted-foreground",
        );
        const metaParts = metaRow
          ? metaRow.textContent
              .split("•")
              .map((part) => part.trim())
              .filter(Boolean)
          : [];

        const conditionRow = node.querySelector(
          "div.flex.flex-row.items-center.whitespace-nowrap.space-x-1",
        );

        const condition = conditionRow
          ? conditionRow
              .querySelector("span.font-medium")
              ?.textContent?.trim() || ""
          : "";

        const finish = conditionRow
          ? conditionRow.querySelector("p")?.textContent?.trim() || ""
          : "";

        const qtyText = Array.from(node.querySelectorAll("div,span,p"))
          .map((el) => el.textContent.trim())
          .find((value) => /^Qty\s*:/i.test(value));

        const priceText =
          text("span.text-base.sm\\:text-lg.font-bold.leading-tight") ||
          text("span.text-base.font-bold.leading-tight");

        const deltaTexts = Array.from(node.querySelectorAll("div.text-xs"))
          .map((el) => el.textContent.trim())
          .find((value) => /\([+-]?\d+(?:\.\d+)?%\)/.test(value));

        let changeAmountText = "";
        let changePercentText = "";

        if (deltaTexts) {
          const percentMatch = deltaTexts.match(/\([^)]+%\)/);
          changePercentText = percentMatch ? percentMatch[0] : "";
          changeAmountText = deltaTexts.replace(changePercentText, "").trim();
        }

        const image = node.querySelector("img");

        const trend = node.querySelector('[data-testid="up-caret"]')
          ? "up"
          : node.querySelector('[data-testid="down-caret"]')
            ? "down"
            : "flat";

        return {
          name: text("span.font-bold.line-clamp-2"),
          setName: text("span.underline.text-muted-foreground"),
          rarity: metaParts[0] || "",
          cardNumber: metaParts[1] || "",
          condition,
          finish,
          qtyText: qtyText || "Qty: 1",
          priceText,
          changeAmountText,
          changePercentText,
          trend,
          imageUrl: image?.getAttribute("src") || "",
          imageAlt: image?.getAttribute("alt") || "",
        };
      }),
    );

    const cards = normalizeCards(rawCards);

    if (!cards.length) {
      throw new Error("No cards were found on the portfolio page.");
    }

    if (options.saveState) {
      await fs.mkdir(path.dirname(DEFAULT_STATE_PATH), { recursive: true });
      await context.storageState({ path: DEFAULT_STATE_PATH });
    }

    const outputs = await writeOutputs(cards, options.outDir, options.format);

    console.log(`Exported ${cards.length} cards.`);
    if (outputs.jsonPath) console.log(`JSON: ${outputs.jsonPath}`);
    if (outputs.latestJsonPath)
      console.log(`Frontend JSON: ${outputs.latestJsonPath}`);
    if (outputs.csvPath) console.log(`CSV: ${outputs.csvPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Collectr export failed: ${error.message}`);
  process.exitCode = 1;
});
