import { fetchJson, mapLimit, normalizeCountry, roundNum, sleep } from "../utils.mjs";

const SITE_ID = "coinsbee";
const SITE_NAME = "Coinsbee";
const API_BASE = "https://backend.coinsbee.com/api/v1";

function interpolateRatio(anchors, targetFv) {
  if (!anchors.length) return null;
  if (anchors.length === 1) return anchors[0].ratio;
  if (targetFv <= anchors[0].fv) return anchors[0].ratio;
  const last = anchors[anchors.length - 1];
  if (targetFv >= last.fv) return last.ratio;

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (targetFv >= a.fv && targetFv <= b.fv) {
      if (b.fv === a.fv) return a.ratio;
      const invA = 1 / a.fv;
      const invB = 1 / b.fv;
      const invT = 1 / targetFv;
      const t = (invT - invA) / (invB - invA);
      return a.ratio + t * (b.ratio - a.ratio);
    }
  }
  return last.ratio;
}

/**
 * 采集 Coinsbee 全量 Apple / iTunes 礼品卡报价
 * 每国仅采集 1 个任务：优先 Apple，其次补充 Apple 未覆盖的国家（如日本、台湾）的 iTunes，外层串行防 429
 */
export async function collectCoinsbee() {
  const now = new Date().toISOString();
  let appleCountries = [];
  let itunesCountries = [];

  try {
    const info = await fetchJson(`${API_BASE}/brands/info/Apple/en/us`, {}, { timeoutMs: 15000 });
    appleCountries = (Array.isArray(info?.countries) ? info.countries : [])
      .map((c) => String(c).toLowerCase())
      .filter((cc) => cc && cc !== "kr" && cc !== "my");
  } catch (err) {
    console.warn(`[Coinsbee] Apple 国家目录拉取失败: ${err.message}`);
  }

  try {
    const info = await fetchJson(`${API_BASE}/brands/info/iTunes/en/us`, {}, { timeoutMs: 15000 });
    itunesCountries = (Array.isArray(info?.countries) ? info.countries : [])
      .map((c) => String(c).toLowerCase())
      .filter((cc) => cc && cc !== "kr" && cc !== "my");
  } catch (err) {
    console.warn(`[Coinsbee] iTunes 国家目录拉取失败: ${err.message}`);
  }

  const appleSet = new Set(appleCountries);
  const itunesSet = new Set(itunesCountries);
  const countryTasks = [];
  for (const cc of appleCountries) {
    countryTasks.push({ primary: "Apple", fallback: itunesSet.has(cc) ? "iTunes" : null, ccLower: cc });
  }
  for (const cc of itunesCountries) {
    if (!appleSet.has(cc)) {
      countryTasks.push({ primary: "iTunes", fallback: null, ccLower: cc });
    }
  }

  const rawOffers = [];
  await mapLimit(
    countryTasks,
    1,
    async ({ primary, fallback, ccLower }) => {
      const country = normalizeCountry(ccLower);

      try {
        let usedBrand = primary;
        let listRes = await fetchJson(`${API_BASE}/products/list/${encodeURIComponent(primary)}/${ccLower}`, {}, { timeoutMs: 15000 });
        let products = (listRes?.results || []).filter((p) => Number(p.active) === 1 && !p.prohibited);
        if (!products.length && fallback) {
          usedBrand = fallback;
          await sleep(150);
          listRes = await fetchJson(`${API_BASE}/products/list/${encodeURIComponent(fallback)}/${ccLower}`, {}, { timeoutMs: 15000 });
          products = (listRes?.results || []).filter((p) => Number(p.active) === 1 && !p.prohibited);
        }
        if (!products.length) return;

        const url = `https://www.coinsbee.com/zh/gift-cards/entertainment/${usedBrand.toLowerCase()}/?c=${ccLower.toUpperCase()}`;
        const fixedItems = products
          .filter((p) => !p.isRange && !p.is_ranged && Number(p.value) > 0)
          .sort((a, b) => Number(a.value) - Number(b.value));
        const rangedItems = products.filter(
          (p) => (p.isRange || p.is_ranged) && Number(p.max_face_value) > Number(p.min_face_value)
        );

        const priceMap = new Map();
        const anchors = [];

        if (fixedItems.length > 0) {
          let queryItems;
          if (fixedItems.length <= 5) {
            queryItems = fixedItems;
          } else {
            const preferredVals = [100, 50, 1000, 3000, 10000, 25, 10, 500, 200];
            const picked = new Map();
            for (const target of preferredVals) {
              if (picked.size >= 3) break;
              const match = fixedItems.find((it) => Math.abs(Number(it.value) - target) < 1e-6);
              if (match) picked.set(match.id, match);
            }
            picked.set(fixedItems[0].id, fixedItems[0]);
            picked.set(fixedItems[fixedItems.length - 1].id, fixedItems[fixedItems.length - 1]);
            queryItems = [...picked.values()].slice(0, 5);
          }

          await mapLimit(
            queryItems,
            2,
            async (item) => {
              const val = Number(item.value);
              const cur = String(item.currency || "USD").toUpperCase();
              try {
                const pr = await fetchJson(
                  `${API_BASE}/cart/price/${item.id}/${val}/${cur}?displayCurrency=USD`,
                  {},
                  { timeoutMs: 12000 }
                );
                const usd = Number(pr?.results?.display?.price ?? pr?.results?.supplier?.price);
                if (usd > 0) {
                  priceMap.set(item.id, usd);
                  anchors.push({ fv: val, ratio: usd / val });
                }
              } catch {
                // 单项失败时跳过，交由邻近锚点估算
              }
            },
            180
          );
          anchors.sort((a, b) => a.fv - b.fv);
        }

        for (const item of fixedItems) {
          const fv = Number(item.value);
          const currency = String(item.currency || "USD").toUpperCase();
          const ratio = interpolateRatio(anchors, fv);
          const payUsd = priceMap.get(item.id) ?? (ratio ? fv * ratio : null);
          if (!(payUsd > 0)) continue;

          rawOffers.push({
            siteId: SITE_ID,
            siteName: SITE_NAME,
            country,
            currency,
            type: "fixed",
            faceValue: roundNum(fv, 2),
            minFaceValue: null,
            maxFaceValue: null,
            step: 1,
            payUsd: roundNum(payUsd, 4),
            unitPayUsd: null,
            inStock: Boolean(item.has_supplier ?? true),
            url,
            updatedAt: now,
          });
        }

        for (const item of rangedItems) {
          const minFV = Number(item.min_face_value);
          const maxFV = Number(item.max_face_value);
          const step = Number(item.increment_face_value) || 1;
          const currency = String(item.currency || "USD").toUpperCase();
          const probeVal = minFV > 0 ? minFV : 10;
          try {
            const pr = await fetchJson(
              `${API_BASE}/cart/price/${item.id}/${probeVal}/${currency}?displayCurrency=USD`,
              {},
              { timeoutMs: 12000 }
            );
            const usd = Number(pr?.results?.display?.price ?? pr?.results?.supplier?.price);
            if (usd > 0) {
              rawOffers.push({
                siteId: SITE_ID,
                siteName: SITE_NAME,
                country,
                currency,
                type: "range",
                faceValue: null,
                minFaceValue: roundNum(minFV, 2),
                maxFaceValue: roundNum(maxFV, 2),
                step,
                payUsd: null,
                unitPayUsd: roundNum(usd / probeVal, 6),
                inStock: Boolean(item.has_supplier ?? true),
                url,
                updatedAt: now,
              });
            }
          } catch {
            // 忽略单条区间报价错误
          }
        }
      } catch (err) {
        console.warn(`[Coinsbee] ${primary}/${ccLower} 拉取失败: ${err.message}`);
      }
    },
    250
  );

  // 同国家同规格去重，优先保留有货且更便宜的报价
  const deduped = new Map();
  for (const o of rawOffers) {
    const key = `${o.country}|${o.currency}|${o.type}|${o.type === "range" ? `${o.minFaceValue}-${o.maxFaceValue}` : o.faceValue}`;
    const prev = deduped.get(key);
    if (!prev) {
      deduped.set(key, o);
      continue;
    }
    const oPrice = o.type === "range" ? o.unitPayUsd : o.payUsd;
    const pPrice = prev.type === "range" ? prev.unitPayUsd : prev.payUsd;
    if ((o.inStock && !prev.inStock) || (o.inStock === prev.inStock && oPrice < pPrice)) {
      deduped.set(key, o);
    }
  }

  return [...deduped.values()];
}
