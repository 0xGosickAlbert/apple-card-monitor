import { fetchJson, isAppleBrandName, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "bitrefill";
const SITE_NAME = "Bitrefill";
const API_BASE = "https://api.bitrefill.com/v2";

/**
 * 采集 Bitrefill 官方 v2 API 数据
 * 注：若账号密钥未开通 Apple 品牌 B2B 权限，API 会返回 not_available，
 * 此时优雅返回空数组，由浏览器缓存快照（browser-cache.json）自动接管展示。
 */
export async function collectBitrefillApi(rates = {}) {
  const apiKey = process.env.BITREFILL_API_KEY;
  if (!apiKey) {
    return { offers: [], sourceStatus: "no_key" };
  }

  const now = new Date().toISOString();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    const searchRes = await fetchJson(
      `${API_BASE}/products?q=apple&include_test_products=false&limit=100`,
      { headers },
      { timeoutMs: 15000 }
    );
    const items = (searchRes?.data || []).filter((item) => isAppleBrandName(item.name || item.base_name));
    if (items.length === 0) {
      return { offers: [], sourceStatus: "restricted_or_empty" };
    }

    const offers = [];
    for (const item of items) {
      try {
        const det = await fetchJson(`${API_BASE}/products/${item.id}`, { headers }, { timeoutMs: 12000 });
        const p = det?.data;
        if (!p) continue;
        const country = normalizeCountry(p.country_code || p.country, p.name);
        const currency = String(p.currency || "USD").toUpperCase();
        const rate = rates[currency] || 1;
        const url = `https://www.bitrefill.com/${country.toLowerCase()}/en/gift-cards/${p.id}/`;

        for (const pkg of p.packages || []) {
          const fv = Number(pkg.value);
          if (!(fv > 0)) continue;
          const usd = Number(pkg.price_usd) || (fv / rate);
          offers.push({
            siteId: SITE_ID,
            siteName: SITE_NAME,
            country,
            currency,
            type: "fixed",
            faceValue: roundNum(fv, 2),
            minFaceValue: null,
            maxFaceValue: null,
            step: 1,
            payUsd: roundNum(usd, 4),
            unitPayUsd: null,
            inStock: Boolean(p.in_stock ?? true),
            url,
            updatedAt: now,
          });
        }
        if (p.range && Number(p.range.min) > 0 && Number(p.range.max) > Number(p.range.min)) {
          offers.push({
            siteId: SITE_ID,
            siteName: SITE_NAME,
            country,
            currency,
            type: "range",
            faceValue: null,
            minFaceValue: roundNum(p.range.min, 2),
            maxFaceValue: roundNum(p.range.max, 2),
            step: Number(p.range.step) || 1,
            payUsd: null,
            unitPayUsd: roundNum(1 / rate, 6),
            inStock: Boolean(p.in_stock ?? true),
            url,
            updatedAt: now,
          });
        }
      } catch {
        // 账号无该国产品权限时跳过
      }
    }

    return {
      offers,
      sourceStatus: offers.length > 0 ? "api_ok" : "restricted_or_empty",
    };
  } catch (err) {
    console.warn(`[Bitrefill API] 请求失败: ${err.message}`);
    return { offers: [], sourceStatus: "api_error" };
  }
}
