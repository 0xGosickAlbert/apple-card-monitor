import { COUNTRY_META, detectBrandSeries, fetchJson, isExcludedCountry, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "keys4coins";
const SITE_NAME = "Keys4Coins";
const STORE_API = "https://www.keys4coins.com/wp-json/wc/store/v1/products";
const BRAND_CATEGORY_TASKS = [
  { brand: "apple", catId: 4754 },
  { brand: "apple", catId: 4813 },
  { brand: "apple", catId: 1134 },
  { brand: "apple", catId: 4457 },
  { brand: "playstation", catId: 4437 },
  { brand: "xbox", catId: 1594 },
  { brand: "xbox", catId: 4478 },
];

const CURRENCY_TO_COUNTRY = {
  USD: "US", GBP: "GB", JPY: "JP", TRY: "TR", DKK: "DK", NZD: "NZ", HKD: "HK",
  PLN: "PL", BRL: "BR", MXN: "MX", CHF: "CH", SEK: "SE", NOK: "NO", SAR: "SA",
  AED: "AE", CAD: "CA", AUD: "AU", INR: "IN", SGD: "SG", KRW: "KR", MYR: "MY",
  TWD: "TW", THB: "TH", IDR: "ID", ZAR: "ZA", HUF: "HU", CZK: "CZ", RON: "RO",
  ILS: "IL", PEN: "PE", CLP: "CL", COP: "CO", UAH: "UA",
};

function parseKeys4CoinsFaceValue(name) {
  const codeMatch = name.match(
    /([0-9]+(?:\.[0-9]+)?)\s*(USD|EUR|GBP|CAD|AUD|TRY|JPY|CHF|SEK|NOK|DKK|PLN|BRL|MXN|INR|IDR|AED|SAR|NZD|RUB|CNY|HKD|SGD|KRW|MYR|TWD|THB|ZAR|HUF|CZK|RON|ILS|PEN|CLP|COP|UAH)\b/i
  );
  if (codeMatch) {
    return { faceValue: roundNum(Number(codeMatch[1]), 2), currency: codeMatch[2].toUpperCase() };
  }
  const symMatch = name.match(/([$€£])\s*([0-9]+(?:\.[0-9]+)?)/);
  if (symMatch) {
    const sym = symMatch[1];
    const fv = roundNum(Number(symMatch[2]), 2);
    const currency = sym === "€" ? "EUR" : sym === "£" ? "GBP" : "USD";
    return { faceValue: fv, currency };
  }
  return null;
}

function resolveKeys4CoinsCountry(name, currency) {
  const parenMatch = name.match(/\(([^()]+)\)\s*$/);
  if (parenMatch && !/\b(xbox|ps\d|playstation|pc|global|row)\b/i.test(parenMatch[1])) {
    const c = normalizeCountry(parenMatch[1], name);
    if (c !== "WW") return c;
  }
  const stripped = name.replace(/\s*\([^()]*\)\s*$/, "").trim();
  const tailCode = stripped.match(/\b([A-Z]{2})\s*$/);
  if (tailCode) {
    const norm = normalizeCountry(tailCode[1]);
    if (norm !== "WW" && COUNTRY_META[norm]) return norm;
  }
  const byName = normalizeCountry(null, stripped);
  if (byName !== "WW") return byName;
  return CURRENCY_TO_COUNTRY[currency] || "WW";
}

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
    BRAND_CATEGORY_TASKS,
    2,
    async ({ brand, catId }) => {
      for (let page = 1; page <= 5; page++) {
        try {
          const items = await fetchJson(`${STORE_API}?category=${catId}&per_page=100&page=${page}`, {}, { timeoutMs: 15000 });
          if (!Array.isArray(items) || !items.length) break;
          for (const item of items) {
            if (item?.id && !productMap.has(item.id)) {
              productMap.set(item.id, { ...item, _targetBrand: brand });
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
    const detectedBrand = detectBrandSeries(name);
    if (detectedBrand !== p._targetBrand) continue;

    const parsed = parseKeys4CoinsFaceValue(name);
    if (!parsed || !(parsed.faceValue > 0)) continue;
    const { faceValue, currency } = parsed;

    const country = resolveKeys4CoinsCountry(name, currency);
    if (country === "WW" || isExcludedCountry(country, detectedBrand)) continue;

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
      brand: detectedBrand,
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

    const key = `${detectedBrand}|${country}|${currency}|fixed|${faceValue}`;
    const prev = deduped.get(key);
    if (!prev || (offer.inStock && !prev.inStock) || (offer.inStock === prev.inStock && offer.payUsd < prev.payUsd)) {
      deduped.set(key, offer);
    }
  }

  return [...deduped.values()];
}
