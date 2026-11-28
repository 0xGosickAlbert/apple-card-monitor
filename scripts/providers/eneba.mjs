import { COUNTRY_META, detectBrandSeries, fetchText, isExcludedCountry, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "eneba";
const SITE_NAME = "Eneba";

const STORE_PAGES = [
  { brand: "apple", url: "https://www.eneba.com/store/apple-gift-cards?page=1" },
  { brand: "apple", url: "https://www.eneba.com/store/apple-gift-cards?page=2" },
  { brand: "playstation", url: "https://www.eneba.com/store/psn-gift-cards-united-states?page=1" },
  { brand: "playstation", url: "https://www.eneba.com/store/psn-gift-cards-europe?page=1" },
  { brand: "playstation", url: "https://www.eneba.com/store/psn-gift-cards-united-kingdom?page=1" },
  { brand: "xbox", url: "https://www.eneba.com/store/xbox-gift-cards?page=1" },
  { brand: "xbox", url: "https://www.eneba.com/store/xbox-gift-cards?page=2" },
];

function parseFaceValueAndCurrency(name, country) {
  const s = String(name || "");
  const codeMatch = s.match(
    /([0-9]+(?:\.[0-9]+)?)\s*(USD|EUR|GBP|CAD|AUD|TRY|JPY|CHF|SEK|NOK|DKK|PLN|BRL|MXN|INR|IDR|AED|SAR|NZD|RUB|CNY|HKD|SGD|KRW|MYR|TWD|THB|CZK|HUF|RON|ILS|PEN|CLP|COP|UAH)\b/i
  );
  if (codeMatch) {
    return { faceValue: Number(codeMatch[1]), currency: codeMatch[2].toUpperCase() };
  }
  const symMatch = s.match(/([€£$¥])\s*([0-9]+(?:\.[0-9]+)?)/);
  if (symMatch) {
    const sym = symMatch[1];
    const fv = Number(symMatch[2]);
    let currency = COUNTRY_META[country]?.currency || "USD";
    if (sym === "€") currency = "EUR";
    else if (sym === "£") currency = "GBP";
    else if (sym === "¥") currency = "JPY";
    else if (sym === "$" && !["CA", "AU", "NZ", "MX"].includes(country)) currency = "USD";
    return { faceValue: fv, currency };
  }
  return null;
}

function extractApolloState(html) {
  const scripts = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const tag of scripts) {
    if (!tag.includes("Product::")) continue;
    const body = tag.replace(/^<script[^>]*>|<\/script>$/g, "");
    try {
      return JSON.parse(body);
    } catch {
      // 忽略异常脚本块
    }
  }
  return null;
}

/**
 * 采集 Eneba 全球 Apple / PlayStation / Xbox 礼品卡报价（法币平台，不含结账服务费）
 */
export async function collectEneba(rates = {}) {
  const now = new Date().toISOString();
  const deduped = new Map();
  await mapLimit(
    STORE_PAGES,
    1,
    async ({ brand, url: pageUrl }) => {
      try {
        const html = await fetchText(pageUrl, {}, { timeoutMs: 15000 });
        const state = extractApolloState(html);
        if (!state) return;

        for (const [key, prod] of Object.entries(state)) {
          if (!key.startsWith("Product::") || !prod) continue;
          if (detectBrandSeries(prod.name) !== brand) continue;
          if (!Array.isArray(prod.regions) || prod.regions.length !== 1) continue;

          const reg = prod.regions[0];
          const country = normalizeCountry(reg.name || String(reg.code || "").replace(/_/g, " "), prod.name);
          if (country === "WW" || isExcludedCountry(country, brand)) continue;

          const parsed = parseFaceValueAndCurrency(prod.name, country);
          if (!parsed || !(parsed.faceValue > 0)) continue;

          const auc = prod.cheapestAuction?.__ref ? state[prod.cheapestAuction.__ref] : null;
          if (!auc) continue;

          const usdCents = Number(auc['price({"currency":"USD"})']?.amount);
          const eurCents = Number(auc['price({"currency":"EUR"})']?.amount);
          let payUsd = null;
          if (usdCents > 0) {
            payUsd = usdCents / 100;
          } else if (eurCents > 0 && rates.EUR > 0) {
            payUsd = (eurCents / 100) / rates.EUR;
          }
          if (!(payUsd > 0)) continue;

          const offer = {
            siteId: SITE_ID,
            siteName: SITE_NAME,
            brand,
            paymentType: "fiat",
            country,
            currency: parsed.currency,
            type: "fixed",
            faceValue: roundNum(parsed.faceValue, 2),
            minFaceValue: null,
            maxFaceValue: null,
            step: 1,
            payUsd: roundNum(payUsd, 4),
            unitPayUsd: null,
            inStock: Boolean(auc.isInStock ?? true),
            stockCount: null,
            url: prod.slug ? `https://www.eneba.com/${prod.slug}` : pageUrl,
            updatedAt: now,
          };

          const dedupKey = `${offer.brand}|${offer.country}|${offer.currency}|fixed|${offer.faceValue}`;
          const prev = deduped.get(dedupKey);
          if (!prev || (offer.inStock && !prev.inStock) || (offer.inStock === prev.inStock && offer.payUsd < prev.payUsd)) {
            deduped.set(dedupKey, offer);
          }
        }
      } catch (err) {
        console.warn(`[Eneba] 页面拉取失败 (${pageUrl}): ${err.message}`);
      }
    },
    850
  );

  return [...deduped.values()];
}
