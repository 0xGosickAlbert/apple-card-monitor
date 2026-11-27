import { fetchJson, isAppleBrandName, mapLimit, normalizeCountry, roundNum, sleep } from "../utils.mjs";

const SITE_ID = "tamana";
const SITE_NAME = "Tamana";
const BASE_URL = "https://tamana-api.bamboocardportal.com/api/app/brands";

/**
 * 采集 Tamana 全量 Apple 礼品卡报价
 * 注意：分页必须串行间隔请求，避免并发触发空响应
 */
export async function collectTamana() {
  const now = new Date().toISOString();
  const appleBrands = [];
  const pageSize = 1000;
  let skip = 0;
  let totalCount = Infinity;

  while (skip < totalCount && skip < 10000) {
    const res = await fetchJson(`${BASE_URL}?skipCount=${skip}&maxResultCount=${pageSize}`, {}, { timeoutMs: 20000 });
    totalCount = res?.totalCount ?? 0;
    const items = res?.items || [];
    if (!items.length) break;

    for (const item of items) {
      if (isAppleBrandName(item.name)) {
        appleBrands.push(item);
      }
    }
    skip += items.length;
    if (skip < totalCount) await sleep(350);
  }

  const offers = [];
  await mapLimit(
    appleBrands,
    3,
    async (brand) => {
      try {
        const detail = await fetchJson(`${BASE_URL}/${brand.id}`, {}, { timeoutMs: 15000 });
        const country = normalizeCountry(brand.countryCode, brand.name);
        const products = detail?.products || [];

        for (const p of products) {
          const currency = String(p.currencyCode || brand.currencyCode || "USD").toUpperCase();
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
            const minPayUsd = minPrice / rate;
            const unitPayUsd = minPayUsd / minFV;
            offers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
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
            const payUsd = minPrice / rate;
            offers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
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
        console.warn(`[Tamana] 品牌 ${brand.name} 详情拉取失败: ${err.message}`);
      }
    },
    220
  );

  return offers;
}
