import { fetchJson, isExcludedCountry, mapLimit, normalizeCountry, roundNum, sleep } from "../utils.mjs";

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
 * 采集 Coinsbee 全量 Apple / PlayStation / Xbox 礼品卡报价
 * 外层串行防 429，每国固定面值最多采 3 个锚点以控制整体耗时
 */
export async function collectCoinsbee() {
  const now = new Date().toISOString();
  const brandConfigs = [
    { brand: "apple", primary: "Apple", fallback: "iTunes" },
    { brand: "playstation", primary: "PlayStation", fallback: null },
    { brand: "xbox", primary: "Xbox-Live", fallback: null },
  ];

  const countryTasks = [];
  for (const cfg of brandConfigs) {
    let primaryCountries = [];
    let fallbackCountries = [];
    try {
      const info = await fetchJson(`${API_BASE}/brands/info/${encodeURIComponent(cfg.primary)}/en/us`, {}, { timeoutMs: 15000 });
      primaryCountries = (Array.isArray(info?.countries) ? info.countries : [])
        .map((c) => String(c).toLowerCase())
        .filter((cc) => cc && !isExcludedCountry(cc.toUpperCase(), cfg.brand));
    } catch (err) {
      console.warn(`[Coinsbee] ${cfg.primary} 国家目录拉取失败: ${err.message}`);
    }

    if (cfg.fallback) {
      try {
        const info = await fetchJson(`${API_BASE}/brands/info/${encodeURIComponent(cfg.fallback)}/en/us`, {}, { timeoutMs: 15000 });
        fallbackCountries = (Array.isArray(info?.countries) ? info.countries : [])
          .map((c) => String(c).toLowerCase())
          .filter((cc) => cc && !isExcludedCountry(cc.toUpperCase(), cfg.brand));
      } catch (err) {
        console.warn(`[Coinsbee] ${cfg.fallback} 国家目录拉取失败: ${err.message}`);
      }
    }

    const pSet = new Set(primaryCountries);
    const fSet = new Set(fallbackCountries);
    for (const cc of primaryCountries) {
      countryTasks.push({ brand: cfg.brand, primary: cfg.primary, fallback: fSet.has(cc) ? cfg.fallback : null, ccLower: cc });
    }
    for (const cc of fallbackCountries) {
      if (!pSet.has(cc)) {
        countryTasks.push({ brand: cfg.brand, primary: cfg.fallback, fallback: null, ccLower: cc });
      }
    }
  }

  const isNonGiftCardItem = (p) => {
    const txt = `${p.title || ""} ${p.name || ""} ${p.description || ""}`;
    return /\b(month|months|day|days|week|weeks|year|years|plus|now|essential|extra|deluxe|game\s*pass|gamepass|core|ultimate|ea\s*play|gold|subscription|membership)\b/i.test(txt);
  };

  const rawOffers = [];
  await mapLimit(
    countryTasks,
    1,
    async ({ brand, primary, fallback, ccLower }) => {
      const country = normalizeCountry(ccLower);
      if (isExcludedCountry(country, brand)) return;

      try {
        let usedBrand = primary;
        let listRes = await fetchJson(`${API_BASE}/products/list/${encodeURIComponent(primary)}/${ccLower}`, {}, { timeoutMs: 10000, retries: 0 });
        let products = (listRes?.results || []).filter((p) => Number(p.active) === 1 && !p.prohibited && !isNonGiftCardItem(p));
        if (!products.length && fallback) {
          usedBrand = fallback;
          await sleep(150);
          listRes = await fetchJson(`${API_BASE}/products/list/${encodeURIComponent(fallback)}/${ccLower}`, {}, { timeoutMs: 10000, retries: 0 });
          products = (listRes?.results || []).filter((p) => Number(p.active) === 1 && !p.prohibited && !isNonGiftCardItem(p));
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
          const preferredVals = [100, 50, 1000, 25, 10];
          let anchorItem = null;
          for (const target of preferredVals) {
            anchorItem = fixedItems.find((it) => Math.abs(Number(it.value) - target) < 1e-6);
            if (anchorItem) break;
          }
          if (!anchorItem) {
            anchorItem = fixedItems[Math.floor(fixedItems.length / 2)];
          }
          const val = Number(anchorItem.value);
          const cur = String(anchorItem.currency || "USD").toUpperCase();
          try {
            const pr = await fetchJson(
              `${API_BASE}/cart/price/${anchorItem.id}/${val}/${cur}?displayCurrency=USD`,
              {},
              { timeoutMs: 10000, retries: 0 }
            );
            const usd = Number(pr?.results?.display?.price ?? pr?.results?.supplier?.price);
            if (usd > 0) {
              priceMap.set(anchorItem.id, usd);
              anchors.push({ fv: val, ratio: usd / val });
            }
          } catch {
            // 锚点拉取失败时忽略该国固定面值
          }
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
            brand,
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

        let rangedRatio = anchors[0]?.ratio ?? null;
        for (const item of rangedItems) {
          const minFV = Number(item.min_face_value);
          const maxFV = Number(item.max_face_value);
          const step = Number(item.increment_face_value) || 1;
          const currency = String(item.currency || "USD").toUpperCase();
          if (!(rangedRatio > 0)) {
            const probeVal = minFV > 0 ? minFV : 10;
            try {
              const pr = await fetchJson(
                `${API_BASE}/cart/price/${item.id}/${probeVal}/${currency}?displayCurrency=USD`,
                {},
                { timeoutMs: 10000, retries: 0 }
              );
              const usd = Number(pr?.results?.display?.price ?? pr?.results?.supplier?.price);
              if (usd > 0) {
                rangedRatio = usd / probeVal;
              }
            } catch {
              // 忽略单条区间报价错误
            }
          }
          if (rangedRatio > 0) {
            rawOffers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              brand,
              country,
              currency,
              type: "range",
              faceValue: null,
              minFaceValue: roundNum(minFV, 2),
              maxFaceValue: roundNum(maxFV, 2),
              step,
              payUsd: null,
              unitPayUsd: roundNum(rangedRatio, 6),
              inStock: Boolean(item.has_supplier ?? true),
              url,
              updatedAt: now,
            });
          }
        }
      } catch (err) {
        console.warn(`[Coinsbee] ${primary}/${ccLower} 拉取失败: ${err.message}`);
      }
    },
    180
  );

  // 同品牌同国家同规格去重，优先保留有货且更便宜的报价
  const deduped = new Map();
  for (const o of rawOffers) {
    const key = `${o.brand}|${o.country}|${o.currency}|${o.type}|${o.type === "range" ? `${o.minFaceValue}-${o.maxFaceValue}` : o.faceValue}`;
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
