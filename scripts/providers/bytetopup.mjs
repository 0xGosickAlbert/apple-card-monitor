import { fetchText, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "bytetopup";
const SITE_NAME = "ByteTopup";
const BASE_URL = "https://www.bytetopup.com";

function extractSkusFromHtml(html) {
  const unescaped = html.replace(/\\"/g, '"');
  const marker = '"skus":[';
  const start = unescaped.indexOf(marker);
  if (start === -1) return [];

  let i = start + marker.length - 1;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (; i < unescaped.length; i++) {
    const ch = unescaped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(unescaped.slice(start + marker.length - 1, i + 1));
          } catch {
            return [];
          }
        }
      }
    }
  }
  return [];
}

/**
 * 采集 ByteTopup 全站 Apple 礼品卡报价
 */
export async function collectByteTopup(rates = {}) {
  const now = new Date().toISOString();
  const productMap = new Map();

  for (const q of ["Apple", "iTunes"]) {
    try {
      const searchHtml = await fetchText(`${BASE_URL}/products?q=${encodeURIComponent(q)}`, {}, { timeoutMs: 15000 });
      const unescaped = searchHtml.replace(/\\"/g, '"');
      const matches = [...unescaped.matchAll(/"id":"(\d+)","name":"([^"]*(?:Apple|iTunes)[^"]*)"[^}]*?"region":"([A-Z]{2})"/gi)];
      for (const m of matches) {
        productMap.set(m[1], { id: m[1], name: m[2], region: m[3] });
      }
      // 兜底匹配未紧邻 region 的产品 id
      const idMatches = [...unescaped.matchAll(/"id":"(\d+)","name":"([^"]*(?:Apple|iTunes)[^"]*)"/gi)];
      for (const m of idMatches) {
        if (!productMap.has(m[1])) {
          productMap.set(m[1], { id: m[1], name: m[2], region: null });
        }
      }
    } catch (err) {
      console.warn(`[ByteTopup] 搜索 ${q} 失败: ${err.message}`);
    }
  }

  if (!productMap.has("2245")) {
    productMap.set("2245", { id: "2245", name: "Apple USA", region: "US" });
  }

  const offers = [];
  await mapLimit(
    [...productMap.values()],
    3,
    async (prod) => {
      const url = `${BASE_URL}/products/${prod.id}`;
      try {
        const html = await fetchText(url, {}, { timeoutMs: 15000 });
        const unescaped = html.replace(/\\"/g, '"');
        const regionMatch = unescaped.match(/"region":"([A-Z]{2})"/);
        const fvCurMatch = unescaped.match(/"faceValueCurrency":"([A-Z]{3})"/);
        const country = normalizeCountry(prod.region || regionMatch?.[1], prod.name);
        const defaultFvCurrency = fvCurMatch?.[1] || (country === "US" ? "USD" : "USD");

        const skus = extractSkusFromHtml(html);
        for (const sku of skus) {
          const retailPrice = Number(sku.retailPrice ?? sku.pricePresentation?.finalPrice ?? sku.pricePresentation?.unitPrice);
          const payCur = String(sku.currency || "USD").toUpperCase();
          const payUsd = payCur === "USD" || payCur === "USDT" ? retailPrice : (rates[payCur] ? retailPrice / rates[payCur] : null);
          const inStock = Boolean(sku.inStock ?? (sku.availability === "in_stock"));

          if (!(payUsd > 0)) continue;

          if (sku.isRange && Number(sku.maxValue) > Number(sku.minValue)) {
            const minFV = Number(sku.minValue);
            const maxFV = Number(sku.maxValue);
            const fv = Number(sku.faceValue) || minFV;
            const unitPayUsd = payUsd / fv;
            offers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              country,
              currency: defaultFvCurrency,
              type: "range",
              faceValue: null,
              minFaceValue: roundNum(minFV, 2),
              maxFaceValue: roundNum(maxFV, 2),
              step: 1,
              payUsd: null,
              unitPayUsd: roundNum(unitPayUsd, 6),
              inStock,
              url: `${url}?skuId=${sku.id}`,
              updatedAt: now,
            });
          } else {
            const fv = Number(sku.faceValue ?? sku.minValue);
            if (!(fv > 0)) continue;
            offers.push({
              siteId: SITE_ID,
              siteName: SITE_NAME,
              country,
              currency: defaultFvCurrency,
              type: "fixed",
              faceValue: roundNum(fv, 2),
              minFaceValue: null,
              maxFaceValue: null,
              step: 1,
              payUsd: roundNum(payUsd, 4),
              unitPayUsd: null,
              inStock,
              url: `${url}?skuId=${sku.id}`,
              updatedAt: now,
            });
          }
        }
      } catch (err) {
        console.warn(`[ByteTopup] 商品 ${prod.id} 解析失败: ${err.message}`);
      }
    },
    100
  );

  return offers;
}
