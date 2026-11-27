import { CHROME_UA, EXCLUDED_COUNTRIES, isAppleBrandName, normalizeCountry, roundNum, sleep } from "../utils.mjs";

const SITE_ID = "kinguin";
const SITE_NAME = "Kinguin";
const SEARCH_API = "https://www.kinguin.net/services/library/api/v1/products/search";
const SEARCH_PHRASES = ["Apple Gift Card", "iTunes Gift Card"];

/**
 * 使用 Node 原生 fetch 请求 Kinguin（绕开 utils 对 curl 的 TLS 指纹回退拦截）
 */
async function kinguinFetch(url, accept = "application/json") {
  const res = await fetch(url, {
    headers: {
      "User-Agent": CHROME_UA,
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return accept.includes("json") ? res.json() : res.text();
}

/**
 * 获取 Kinguin 官方 EUR -> USD 汇率，失败时回退外部国际汇率
 */
async function getEurToUsdRate(rates) {
  try {
    const html = await kinguinFetch(
      "https://www.kinguin.net/category/166274/apple-usd-100-gift-card-us",
      "text/html,application/xhtml+xml"
    );
    const m = html.match(/\{"code":"USD"[^}]*"rate":([0-9.]+)/);
    const rate = Number(m?.[1]);
    if (rate > 0.5 && rate < 2.0) return rate;
  } catch {
    // 忽略并回退国际汇率
  }
  return rates.EUR > 0 ? 1 / rates.EUR : 1.09;
}

/**
 * 采集 Kinguin 全球在售 Apple / iTunes / App Store 礼品卡（加密支付）
 */
export async function collectKinguin(rates = {}) {
  const now = new Date().toISOString();
  const eurToUsdRate = await getEurToUsdRate(rates);
  const productMap = new Map();

  for (const phrase of SEARCH_PHRASES) {
    for (let page = 1; page <= 8; page++) {
      try {
        const url = `${SEARCH_API}?phrase=${encodeURIComponent(phrase)}&active=1&hideUnavailable=1&size=100&page=${page}`;
        const res = await kinguinFetch(url, "application/json");
        const products = res?._embedded?.products || [];
        for (const p of products) {
          if (p?.externalId && !productMap.has(p.externalId)) {
            productMap.set(p.externalId, p);
          }
        }
        const totalPages = Number(res?.page?.totalPages ?? 1);
        if (page >= totalPages || products.length < 100) break;
        await sleep(250);
      } catch (err) {
        console.warn(`[Kinguin] 搜索 "${phrase}" 第 ${page} 页失败: ${err.message}`);
        break;
      }
    }
  }

  const deduped = new Map();
  for (const p of productMap.values()) {
    if (!isAppleBrandName(p.name)) continue;

    const actCountries = p.attributes?.region?.activationCountries;
    if (!Array.isArray(actCountries) || actCountries.length !== 1) continue;
    const country = normalizeCountry(actCountries[0], p.name);
    if (country === "WW" || EXCLUDED_COUNTRIES.has(country)) continue;

    const curProp = (p.prepaidAttributes?.properties || []).find((x) => x.type === "CURRENCY");
    const currency = String(curProp?.key || "").toUpperCase();
    const faceValue = Number(curProp?.value);
    if (!currency || !(faceValue > 0)) continue;

    const lowestOffer = Number(p.price?.lowestOffer);
    if (!(lowestOffer > 0) || lowestOffer >= 999999) continue;

    const payUsd = roundNum((lowestOffer / 100) * eurToUsdRate, 4);
    if (!(payUsd > 0)) continue;

    const offer = {
      siteId: SITE_ID,
      siteName: SITE_NAME,
      paymentType: "crypto",
      country,
      currency,
      type: "fixed",
      faceValue: roundNum(faceValue, 2),
      minFaceValue: null,
      maxFaceValue: null,
      step: 1,
      payUsd,
      unitPayUsd: null,
      inStock: true,
      stockCount: null,
      url: `https://www.kinguin.net/category/${p.externalId}/${p.attributes?.urlKey || p.urlKey || "product"}`,
      updatedAt: now,
    };

    const key = `${country}|${currency}|fixed|${offer.faceValue}`;
    const prev = deduped.get(key);
    if (!prev || offer.payUsd < prev.payUsd) {
      deduped.set(key, offer);
    }
  }

  return [...deduped.values()];
}
