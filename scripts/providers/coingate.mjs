import { EXCLUDED_COUNTRIES, fetchJson, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "coingate";
const SITE_NAME = "CoinGate";
const API_BASE = "https://giftcards-api.coingate.com/api/v2";

/**
 * 采集 CoinGate 全球各国 Apple 礼品卡报价
 * 1) 拉取 brand_group_v2/apple 获取全部支持国家
 * 2) 按国家拉取 denominations 规格列表
 * 3) 通过 details_v2 批量获取精确售价（按每批最多 40 项）
 */
export async function collectCoinGate(rates = {}) {
  const now = new Date().toISOString();
  let cgUsdtRates = {};
  try {
    const merchantRates = await fetchJson("https://api.coingate.com/api/v2/rates/merchant", {}, { timeoutMs: 12000 });
    cgUsdtRates = merchantRates?.USDT || {};
  } catch (err) {
    console.warn(`[CoinGate] 商家 USDT 汇率拉取失败，回退国际汇率: ${err.message}`);
  }
  const batchItems = [];
  const seenBatchKeys = new Set();
  const metaMap = new Map(); // key: `${gift_card_id}|${country}|${denomVal}`

  for (const slug of ["apple", "itunes"]) {
    let baseData;
    try {
      baseData = await fetchJson(`${API_BASE}/gift-cards/brand_group_v2/${slug}?country=US`, {}, { timeoutMs: 15000 });
    } catch (err) {
      console.warn(`[CoinGate] 品牌 ${slug} 目录拉取失败: ${err.message}`);
      continue;
    }
    const countries = (baseData?.countries || [])
      .map((c) => String(c.value || "").toUpperCase())
      .filter((cc) => cc && !EXCLUDED_COUNTRIES.has(cc));
    if (!countries.length) countries.push("US");

    await mapLimit(
      countries,
      5,
      async (cc) => {
        try {
          const data = cc === "US"
            ? baseData
            : await fetchJson(`${API_BASE}/gift-cards/brand_group_v2/${slug}?country=${cc}`, {}, { timeoutMs: 15000 });

          for (const d of data?.denominations || []) {
            if (!d?.gift_card_id) continue;
            const currency = String(d.currency || "USD").toUpperCase();
            if (d.type === "range") {
              const minFV = Number(d.min_denomination);
              const maxFV = Number(d.max_denomination);
              const step = Number(d.custom_denomination_step) || 1;
              if (!(minFV > 0) || !(maxFV >= minFV)) continue;
              const probeVal = Math.max(minFV, Math.min(maxFV, Math.ceil(minFV)));
              const key = `${d.gift_card_id}|${cc}|${probeVal}`;
              if (seenBatchKeys.has(key)) continue;
              seenBatchKeys.add(key);
              batchItems.push({ gift_card_id: d.gift_card_id, country: cc, denomination: probeVal });
              metaMap.set(key, {
                slug,
                type: "range",
                country: normalizeCountry(cc),
                rawCountry: cc,
                currency,
                minFV,
                maxFV,
                step,
                probeVal,
                outOfStock: Boolean(d.out_of_stock),
              });
            } else {
              const fv = Number(d.denomination);
              if (!(fv > 0)) continue;
              const key = `${d.gift_card_id}|${cc}|${fv}`;
              if (seenBatchKeys.has(key)) continue;
              seenBatchKeys.add(key);
              batchItems.push({ gift_card_id: d.gift_card_id, country: cc, denomination: fv });
              metaMap.set(key, {
                slug,
                type: "fixed",
                country: normalizeCountry(cc),
                rawCountry: cc,
                currency,
                fv,
                outOfStock: Boolean(d.out_of_stock),
              });
            }
          }
        } catch (err) {
          console.warn(`[CoinGate] ${slug}/${cc} 目录拉取失败: ${err.message}`);
        }
      },
      80
    );
  }

  // 分批调用 details_v2 获取精确售价（官方限制 max_cart_items = 50）
  const chunks = [];
  for (let i = 0; i < batchItems.length; i += 40) {
    chunks.push(batchItems.slice(i, i + 40));
  }

  const rawOffers = [];
  await mapLimit(
    chunks,
    3,
    async (items) => {
      try {
        const res = await fetchJson(
          `${API_BASE}/gift-cards/details_v2`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
          },
          { timeoutMs: 20000 }
        );

        for (const gc of res?.gift_cards || []) {
          const cc = String(gc.country || "").toUpperCase();
          const denomVal = Number(gc.denomination?.denomination);
          const key = `${gc.id}|${cc}|${denomVal}`;
          const meta = metaMap.get(key);
          if (!meta) continue;

          const priceCur = String(gc.currency?.iso_symbol || meta.currency || "USD").toUpperCase();
          const priceAmt = Number(gc.denomination?.price);
          if (!(priceAmt > 0)) continue;

          const cgRate = Number(cgUsdtRates[priceCur]);
          let payUsd = null;
          if (cgRate > 0) {
            payUsd = priceAmt / cgRate;
          } else if (priceCur === "USD" || priceCur === "USDT") {
            payUsd = priceAmt;
          } else if (rates[priceCur] > 0) {
            payUsd = priceAmt / rates[priceCur];
          }
          if (!(payUsd > 0)) continue;
          const rawStock = gc.stock_count;
          const stockCount =
            rawStock !== null && rawStock !== undefined && Number.isFinite(Number(rawStock))
              ? Math.max(0, Math.floor(Number(rawStock)))
              : null;
          const inStock = !(gc.out_of_stock ?? meta.outOfStock) && (stockCount === null || stockCount > 0);
          const url = `https://coingate.com/gift-cards/${meta.slug}?country=${meta.rawCountry}`;

          if (meta.type === "range") {
            rawOffers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              country: meta.country,
              currency: meta.currency,
              type: "range",
              faceValue: null,
              minFaceValue: roundNum(meta.minFV, 2),
              maxFaceValue: roundNum(meta.maxFV, 2),
              step: meta.step,
              payUsd: null,
              unitPayUsd: roundNum(payUsd / meta.probeVal, 6),
              inStock,
              stockCount,
              url,
              updatedAt: now,
            });
          } else {
            rawOffers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              country: meta.country,
              currency: meta.currency,
              type: "fixed",
              faceValue: roundNum(meta.fv, 2),
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
        console.warn(`[CoinGate] details_v2 批次报价失败: ${err.message}`);
      }
    },
    120
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
