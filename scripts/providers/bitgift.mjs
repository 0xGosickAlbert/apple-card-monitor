import { EXCLUDED_COUNTRIES, fetchText, roundNum } from "../utils.mjs";

const SITE_ID = "bitgift";
const SITE_NAME = "BitGift";
const PRODUCT_URL = "https://bitgift.io/product/apple";

/**
 * 采集 BitGift（bitgift.io）App Store & iTunes 实时报价与库存（原生 USDT 支付）
 */
export async function collectBitGift(rates = {}) {
  const now = new Date().toISOString();
  const html = await fetchText(PRODUCT_URL, {}, { timeoutMs: 15000 });
  const unescaped = html.replace(/\\"/g, '"');

  const denomMatch = unescaped.match(/"denominations":(\[[0-9.,\s]+\])/);
  if (!denomMatch) return [];

  let denominations = [];
  try {
    denominations = JSON.parse(denomMatch[1]);
  } catch {
    return [];
  }

  let stocks = {};
  const stockMatch = unescaped.match(/"denominationStocks":(\{[^}]*\})/);
  if (stockMatch) {
    try {
      stocks = JSON.parse(stockMatch[1]);
    } catch {
      stocks = {};
    }
  }

  const curMatch = unescaped.match(/id="denomination-\d+"[^>]*>[\s\S]{0,160}?\b(INR|USD|EUR|GBP|AED|SAR|JPY|TRY)\b/i);
  const currency = (curMatch?.[1] || "INR").toUpperCase();
  const country = currency === "INR" ? "IN" : currency === "USD" ? "US" : "IN";
  if (EXCLUDED_COUNTRIES.has(country)) return [];

  const rateMatch = unescaped.match(/"exchangeRate":([0-9.]+)/);
  const exchangeRate = Number(rateMatch?.[1]) || (currency === "USD" ? 1 : rates[currency]);
  if (!(exchangeRate > 0)) return [];

  const discountMatch = unescaped.match(/"discountPercent":([0-9.]+)/);
  const discountPct = Number(discountMatch?.[1]) || 0;
  const inStockMatch = unescaped.match(/"inStock":(true|false)/);
  const pageInStock = inStockMatch ? inStockMatch[1] === "true" : true;

  const offers = [];
  for (const rawFv of denominations) {
    const fv = roundNum(Number(rawFv), 2);
    if (!(fv > 0)) continue;

    const rawStock = stocks[String(rawFv)];
    const stockCount =
      rawStock !== undefined && rawStock !== null && Number.isFinite(Number(rawStock))
        ? Math.max(0, Math.floor(Number(rawStock)))
        : 0;
    const inStock = pageInStock && stockCount > 0;
    const payUsd = roundNum((fv * (1 - discountPct / 100)) / exchangeRate, 4);
    if (!(payUsd > 0)) continue;

    offers.push({
      siteId: SITE_ID,
      siteName: SITE_NAME,
      brand: "apple",
      paymentType: "crypto",
      country,
      currency,
      type: "fixed",
      faceValue: fv,
      minFaceValue: null,
      maxFaceValue: null,
      step: 1,
      payUsd,
      unitPayUsd: null,
      inStock,
      stockCount,
      url: PRODUCT_URL,
      updatedAt: now,
    });
  }

  return offers;
}
