import { fetchJson, isAppleBrandName, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "cryptorefills";
const SITE_NAME = "CryptoRefills";
const API_BASE = "https://api.cryptorefills.com";

const TARGET_COUNTRIES = [
  "US", "GB", "JP", "HK", "TW", "TR", "DE", "FR", "IT", "ES", "NL", "BE",
  "AT", "PT", "FI", "IE", "GR", "PL", "CZ", "RO", "SE", "NO", "DK", "CH",
  "CA", "AU", "NZ", "AE", "SA", "QA", "KW", "BH", "OM", "EG", "ZA", "NG",
  "KE", "IN", "SG", "MY", "ID", "TH", "PH", "VN", "KR", "BR", "MX", "AR",
  "CL", "CO", "LU", "HU", "BG", "HR", "SK", "SI", "LT", "LV", "EE",
];

/**
 * 采集 CryptoRefills 全球各国 Apple / iTunes 礼品卡报价
 */
export async function collectCryptoRefills(rates = {}) {
  const now = new Date().toISOString();
  const offers = [];
  const seenKeys = new Set();

  await mapLimit(
    TARGET_COUNTRIES,
    5,
    async (cc) => {
      try {
        const brandRes = await fetchJson(
          `${API_BASE}/v2/brands?country_code=${cc}`,
          {},
          { timeoutMs: 12000 }
        );
        const appleFamilies = new Set();
        for (const cat of brandRes?.categories || []) {
          for (const b of cat?.brands || []) {
            if (isAppleBrandName(b.brand) || isAppleBrandName(b.family)) {
              if (b.family) appleFamilies.add(b.family);
            }
          }
        }
        if (appleFamilies.size === 0) return;

        for (const family of appleFamilies) {
          try {
            const prodRes = await fetchJson(
              `${API_BASE}/v5/products/country/${cc}?family_name=${encodeURIComponent(family)}&coin=USDT&lang=en`,
              {},
              { timeoutMs: 12000 }
            );
            for (const group of Array.isArray(prodRes) ? prodRes : []) {
              const country = normalizeCountry(group.country_code || cc);
              const groupOut = Boolean(group.is_out_of_stock);
              const slug = String(family).toLowerCase().replace(/[^a-z0-9]+/g, "-");
              const url = `https://www.cryptorefills.com/en/${slug}-crypto`;

              for (const p of group.products || []) {
                const fvCur = String(
                  p.face_value?.currency_code || p.range?.currency || "USD"
                ).toUpperCase();

                if (p.is_dynamic && p.range) {
                  const minFV = Number(p.range.min);
                  const maxFV = Number(p.range.max);
                  const step = Number(p.range.step_size) || 1;
                  if (!(minFV > 0) || !(maxFV >= minFV)) continue;

                  // 优先读取已有 coin_amount/default，否则调用官方动态报价接口获取真实 USDT 价格
                  let unitPayUsd = null;
                  if (Number(p.coin_amount) > 0 && Number(p.range.default) > 0) {
                    unitPayUsd = Number(p.coin_amount) / Number(p.range.default);
                  } else {
                    const probeCandidates = [100, 50, 25, 10, 500, 1000];
                    const probeFv =
                      probeCandidates.find((v) => v >= minFV && v <= maxFV) ??
                      Math.min(maxFV, Math.max(minFV, Math.ceil(minFV)));
                    const priceUrl = `https://www.cryptorefills.com/api/products/price?brand_name=${encodeURIComponent(group.brand || family)}&country_code=${encodeURIComponent(country)}&face_value=${probeFv}&coin=USDT&promo_code=`;
                    try {
                      const pr = await fetchJson(priceUrl, {}, { timeoutMs: 12000 });
                      const coinAmt = Number(pr?.coin_amount ?? pr?.original_coin_amount);
                      if (coinAmt > 0) {
                        unitPayUsd = coinAmt / probeFv;
                      }
                    } catch {
                      // 拿不到真实 USDT 报价时放弃该区间条，绝不按 1:1 盲猜
                    }
                  }
                  if (!(unitPayUsd > 0)) continue;

                  const key = `${country}|${fvCur}|range|${minFV}-${maxFV}`;
                  if (seenKeys.has(key)) continue;
                  seenKeys.add(key);

                  offers.push({
                    siteId: SITE_ID,
                    siteName: SITE_NAME,
                    country,
                    currency: fvCur,
                    type: "range",
                    faceValue: null,
                    minFaceValue: roundNum(minFV, 2),
                    maxFaceValue: roundNum(maxFV, 2),
                    step,
                    payUsd: null,
                    unitPayUsd: roundNum(unitPayUsd, 6),
                    inStock: !groupOut,
                    url,
                    updatedAt: now,
                  });
                } else {
                  const fv = Number(p.face_value?.amount?.price);
                  const coinAmt = Number(p.coin_amount ?? p.original_coin_amount);
                  if (!(fv > 0) || !(coinAmt > 0)) continue;

                  const key = `${country}|${fvCur}|fixed|${fv}`;
                  if (seenKeys.has(key)) continue;
                  seenKeys.add(key);

                  offers.push({
                    siteId: SITE_ID,
                    siteName: SITE_NAME,
                    country,
                    currency: fvCur,
                    type: "fixed",
                    faceValue: roundNum(fv, 2),
                    minFaceValue: null,
                    maxFaceValue: null,
                    step: 1,
                    payUsd: roundNum(coinAmt, 4),
                    unitPayUsd: null,
                    inStock: !groupOut,
                    url,
                    updatedAt: now,
                  });
                }
              }
            }
          } catch (err) {
            console.warn(`[CryptoRefills] ${cc} (${family}) 拉取失败: ${err.message}`);
          }
        }
      } catch {
        // 个别不支持的国家跳过
      }
    },
    60
  );

  return offers;
}
