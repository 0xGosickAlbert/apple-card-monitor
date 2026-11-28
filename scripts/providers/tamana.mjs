import { detectBrandSeries, fetchJson, isExcludedCountry, mapLimit, normalizeCountry, roundNum, sleep } from "../utils.mjs";

const SITE_ID = "tamana";
const SITE_NAME = "Tamana";
const BASE_URL = "https://tamana-api.bamboocardportal.com/api/app/brands";
const USDT_MULTIPLIER = 1.04; // Tamana 前端结账使用 USDT，固定乘以 rp = 1.04 系数

/**
 * 采集 Tamana 全量 Apple / PlayStation / Xbox 礼品卡报价
 * 注意：分页必须串行间隔请求，避免并发触发空响应
 */
export async function collectTamana() {
  const now = new Date().toISOString();
  const matchedBrands = [];
  const pageSize = 1000;
  let skip = 0;
  let totalCount = Infinity;

  while (skip < totalCount && skip < 10000) {
    const res = await fetchJson(`${BASE_URL}?skipCount=${skip}&maxResultCount=${pageSize}`, {}, { timeoutMs: 20000 });
    totalCount = res?.totalCount ?? 0;
    const items = res?.items || [];
    if (!items.length) break;

    for (const item of items) {
      const brandSeries = detectBrandSeries(item.name);
      if (brandSeries) {
        matchedBrands.push({ ...item, brandSeries });
      }
    }
    skip += items.length;
    if (skip < totalCount) await sleep(350);
  }

  const offers = [];
  await mapLimit(
    matchedBrands,
    3,
    async (brandItem) => {
      try {
        const detail = await fetchJson(`${BASE_URL}/${brandItem.id}`, {}, { timeoutMs: 15000 });
        const country = normalizeCountry(brandItem.countryCode, brandItem.name);
        if (isExcludedCountry(country, brandItem.brandSeries)) return;
        const products = detail?.products || [];

        for (const p of products) {
          const currency = String(p.currencyCode || brandItem.currencyCode || "USD").toUpperCase();
          const rate = Number(p.defaultCurrencyRate) || 1; // 1 USD = rate * currency
          const minFV = Number(p.minFaceValue);
          const maxFV = Number(p.maxFaceValue);
          const minPrice = Number(p.minPrice);
          const stockCount =
            p.stockCount !== null && p.stockCount !== undefined && Number.isFinite(Number(p.stockCount))
              ? Math.max(0, Math.floor(Number(p.stockCount)))
              : null;
          const inStock = stockCount === null ? true : stockCount > 0;
          const url = `https://tamana.bamboocardportal.com/`;

          if (!(minFV > 0) || !(minPrice > 0) || !(rate > 0)) continue;

          if (p.faceValueType === "Ranged" && maxFV > minFV) {
            const minPayUsd = (minPrice / rate) * USDT_MULTIPLIER;
            const unitPayUsd = minPayUsd / minFV;
            offers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              brand: brandItem.brandSeries,
              country,
              currency,
              type: "range",
              faceValue: null,
              minFaceValue: roundNum(minFV, 2),
              maxFaceValue: roundNum(maxFV, 2),
              step: 1,
              payUsd: null,
              unitPayUsd: roundNum(unitPayUsd, 6),
              inStock,
              stockCount,
              url,
              updatedAt: now,
            });
          } else {
            const payUsd = (minPrice / rate) * USDT_MULTIPLIER;
            offers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              brand: brandItem.brandSeries,
              country,
              currency,
              type: "fixed",
              faceValue: roundNum(minFV, 2),
              minFaceValue: null,
              maxFaceValue: null,
              step: 1,
              payUsd: roundNum(payUsd, 4),
              unitPayUsd: null,
              inStock,
              stockCount,
              url,
              updatedAt: now,
            });
          }
        }
      } catch (err) {
        console.warn(`[Tamana] 品牌 ${brandItem.name} 详情拉取失败: ${err.message}`);
      }
    },
    220
  );

  return offers;
}
