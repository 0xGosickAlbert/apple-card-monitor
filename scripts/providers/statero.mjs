import { fetchJson, isAppleBrandName, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "statero";
const SITE_NAME = "Statero";
const BASE_URL = "https://api.statero.com/api/brands";

/**
 * 采集 Statero 全量 Apple 礼品卡报价
 */
export async function collectStatero() {
  const now = new Date().toISOString();
  const appleBrands = [];
  let skip = 0;
  let totalCount = Infinity;
  const pageSize = 200;

  while (skip < totalCount && skip < 5000) {
    const res = await fetchJson(`${BASE_URL}?skipCount=${skip}&maxResultCount=${pageSize}`, {}, { timeoutMs: 15000 });
    totalCount = res?.totalCount ?? 0;
    const items = res?.items || [];
    if (!items.length) break;

    for (const item of items) {
      if (isAppleBrandName(item.name)) {
        appleBrands.push(item);
      }
    }
    skip += items.length;
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
        const url = brand.slug ? `https://statero.com/product/${brand.slug}` : "https://statero.com/";

        for (const p of products) {
          const currency = String(p.currencyCode || brand.currencyCode || "USD").toUpperCase();
          const rate = Number(p.defaultCurrencyRate) || 1;
          const minFV = Number(p.minFaceValue);
          const maxFV = Number(p.maxFaceValue);
          const minPrice = Number(p.minPrice);
          const stockCount =
            p.stockCount !== null && p.stockCount !== undefined && Number.isFinite(Number(p.stockCount))
              ? Math.max(0, Math.floor(Number(p.stockCount)))
              : null;
          const inStock = stockCount === null ? true : stockCount > 0;

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
        console.warn(`[Statero] 品牌 ${brand.name} 详情拉取失败: ${err.message}`);
      }
    },
    180
  );

  return offers;
}
