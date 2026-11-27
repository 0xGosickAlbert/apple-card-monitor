import { EXCLUDED_COUNTRIES, fetchJson, isAppleBrandName, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "keys4coins";
const SITE_NAME = "Keys4Coins";
const STORE_API = "https://www.keys4coins.com/wp-json/wc/store/v1/products";
const APPLE_CATEGORY_IDS = [4754, 4813, 1134, 4457];

function decodeEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * 采集 Keys4Coins Apple / iTunes 礼品卡分类报价与精确库存（主流加密币支付）
 */
export async function collectKeys4Coins(rates = {}) {
  const now = new Date().toISOString();
  const productMap = new Map();

  await mapLimit(
    APPLE_CATEGORY_IDS,
    2,
    async (catId) => {
      for (let page = 1; page <= 4; page++) {
        try {
          const items = await fetchJson(`${STORE_API}?category=${catId}&per_page=100&page=${page}`, {}, { timeoutMs: 15000 });
          if (!Array.isArray(items) || !items.length) break;
          for (const item of items) {
            if (item?.id && !productMap.has(item.id)) {
              productMap.set(item.id, item);
            }
          }
          if (items.length < 100) break;
        } catch (err) {
          console.warn(`[Keys4Coins] 分类 ${catId} 第 ${page} 页拉取失败: ${err.message}`);
          break;
        }
      }
    },
    120
  );

  const deduped = new Map();
  for (const p of productMap.values()) {
    const name = decodeEntities(p.name);
    if (!isAppleBrandName(name)) continue;

    const parenMatch = name.match(/\(([^()]+)\)\s*$/);
    const country = normalizeCountry(parenMatch?.[1], name);
    if (country === "WW" || EXCLUDED_COUNTRIES.has(country)) continue;

    const fvMatch = name.match(
      /([0-9]+(?:\.[0-9]+)?)\s*(USD|EUR|GBP|CAD|AUD|TRY|JPY|CHF|SEK|NOK|DKK|PLN|BRL|MXN|INR|IDR|AED|SAR|NZD|RUB|CNY)\b/i
    );
    if (!fvMatch) continue;
    const faceValue = roundNum(Number(fvMatch[1]), 2);
    const currency = fvMatch[2].toUpperCase();
    if (!(faceValue > 0)) continue;

    const minor = Number(p.prices?.currency_minor_unit ?? 2);
    const rawPrice = Number(p.prices?.price) / 10 ** minor;
    const priceCur = String(p.prices?.currency_code || "EUR").toUpperCase();
    if (!(rawPrice > 0)) continue;

    let payUsd = null;
    if (priceCur === "USD" || priceCur === "USDT") {
      payUsd = rawPrice;
    } else if (rates[priceCur] > 0) {
      payUsd = rawPrice / rates[priceCur];
    }
    if (!(payUsd > 0)) continue;

    let stockCount = null;
    let inStock = Boolean(p.is_in_stock);
    if (!inStock) {
      stockCount = 0;
    } else {
      const availMatch = String(p.stock_availability?.text || "").match(/(\d+)\s+in\s+stock/i);
      const maxQty = Number(p.add_to_cart?.maximum);
      if (availMatch) {
        stockCount = Math.max(0, Math.floor(Number(availMatch[1])));
      } else if (Number.isFinite(maxQty) && maxQty > 0 && maxQty < 9999) {
        stockCount = Math.floor(maxQty);
      }
      if (stockCount === 0) inStock = false;
    }

    const offer = {
      siteId: SITE_ID,
      siteName: SITE_NAME,
      paymentType: "crypto",
      country,
      currency,
      type: "fixed",
      faceValue,
      minFaceValue: null,
      maxFaceValue: null,
      step: 1,
      payUsd: roundNum(payUsd, 4),
      unitPayUsd: null,
      inStock,
      stockCount,
      url: p.permalink || "https://www.keys4coins.com/",
      updatedAt: now,
    };

    const key = `${country}|${currency}|fixed|${faceValue}`;
    const prev = deduped.get(key);
    if (!prev || (offer.inStock && !prev.inStock) || (offer.inStock === prev.inStock && offer.payUsd < prev.payUsd)) {
      deduped.set(key, offer);
    }
  }

  return [...deduped.values()];
}
