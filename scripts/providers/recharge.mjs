import { COUNTRY_META, EXCLUDED_COUNTRIES, fetchText, isAppleBrandName, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "recharge";
const SITE_NAME = "Recharge";
const TARGET_COUNTRIES = [
  "ae", "at", "au", "be", "ca", "ch", "de", "dk", "es", "fi", "fr", "gb",
  "ie", "it", "jp", "nl", "no", "nz", "pl", "pt", "sa", "se", "tr", "us",
];

function collectProductsFromLdJson(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectProductsFromLdJson(item, out);
    return;
  }
  if (typeof node !== "object") return;
  if (node["@type"] === "Product" && node.offers) {
    out.push(node);
  }
  if (node["@graph"]) collectProductsFromLdJson(node["@graph"], out);
  if (node.itemListElement) collectProductsFromLdJson(node.itemListElement, out);
  if (node.item) collectProductsFromLdJson(node.item, out);
  if (node.hasVariant) collectProductsFromLdJson(node.hasVariant, out);
}

/**
 * 采集 Recharge.com 全球 Apple 礼品卡报价（法币平台，已含页内 Service Fee）
 */
export async function collectRecharge(rates = {}) {
  const now = new Date().toISOString();
  const countries = TARGET_COUNTRIES.filter((c) => !EXCLUDED_COUNTRIES.has(c.toUpperCase()));
  const deduped = new Map();

  await mapLimit(
    countries,
    4,
    async (cc) => {
      const country = normalizeCountry(cc);
      const pageUrl = `https://www.recharge.com/en/${cc}/apple`;

      try {
        const html = await fetchText(pageUrl, {}, { timeoutMs: 12000, retries: 0 });
        const ldBlocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
        const products = [];
        for (const m of ldBlocks) {
          try {
            collectProductsFromLdJson(JSON.parse(m[1]), products);
          } catch {
            // 忽略单块 JSON 解析错误
          }
        }

        for (const prod of products) {
          if (!isAppleBrandName(prod.name)) continue;
          const offersArr = Array.isArray(prod.offers) ? prod.offers : [prod.offers];

          for (const off of offersArr) {
            const totalPrice = Number(off?.price);
            const priceCur = String(off?.priceCurrency || "").toUpperCase();
            if (!(totalPrice > 0) || !priceCur) continue;

            const payUsd =
              priceCur === "USD" || priceCur === "USDT"
                ? totalPrice
                : rates[priceCur] > 0
                  ? totalPrice / rates[priceCur]
                  : null;
            if (!(payUsd > 0)) continue;

            const components = off?.priceSpecification?.priceComponent || [];
            const baseComp = components.find(
              (c) => /voucher value/i.test(c.name || "") || /BaseService/i.test(c.priceType || "")
            );
            let faceValue = Number(baseComp?.price);
            if (!(faceValue > 0)) {
              const nm = String(prod.name || "").match(/([0-9]+(?:\.[0-9]+)?)/);
              faceValue = Number(nm?.[1]);
            }
            if (!(faceValue > 0)) continue;

            const fvCur = String(
              off?.priceSpecification?.priceCurrency ||
              String(prod.name || "").match(/\b(USD|EUR|GBP|CAD|AUD|TRY|JPY|CHF|SEK|NOK|DKK|PLN|AED|SAR|NZD)\b/i)?.[1] ||
              COUNTRY_META[country]?.currency ||
              priceCur
            ).toUpperCase();

            const inStock = !/OutOfStock/i.test(String(off?.availability || ""));
            const offer = {
              siteId: SITE_ID,
              siteName: SITE_NAME,
              paymentType: "fiat",
              country,
              currency: fvCur,
              type: "fixed",
              faceValue: roundNum(faceValue, 2),
              minFaceValue: null,
              maxFaceValue: null,
              step: 1,
              payUsd: roundNum(payUsd, 4),
              unitPayUsd: null,
              inStock,
              stockCount: null,
              url: pageUrl,
              updatedAt: now,
            };

            const key = `${country}|${fvCur}|fixed|${offer.faceValue}`;
            const prev = deduped.get(key);
            if (!prev || (offer.inStock && !prev.inStock) || (offer.inStock === prev.inStock && offer.payUsd < prev.payUsd)) {
              deduped.set(key, offer);
            }
          }
        }
      } catch {
        // 404 表示该国家无 Recharge Apple 页，跳过
      }
    },
    100
  );

  return [...deduped.values()];
}
