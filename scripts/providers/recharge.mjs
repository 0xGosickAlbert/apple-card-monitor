import { COUNTRY_META, detectBrandSeries, fetchText, isExcludedCountry, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "recharge";
const SITE_NAME = "Recharge";
const BASE_COUNTRIES = [
  "ae", "at", "au", "be", "ca", "ch", "de", "dk", "es", "fi", "fr", "gb",
  "ie", "it", "jp", "nl", "no", "nz", "pl", "pt", "sa", "se", "tr", "us",
];
const EXTENDED_COUNTRIES = [
  ...BASE_COUNTRIES,
  "hk", "kr", "my", "sg", "tw", "mx", "br", "in", "id", "th",
];
const BRAND_PAGES = [
  { slug: "apple", brand: "apple", countries: BASE_COUNTRIES },
  { slug: "playstation-store", brand: "playstation", countries: EXTENDED_COUNTRIES },
  { slug: "xbox-gift-card", brand: "xbox", countries: EXTENDED_COUNTRIES },
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
 * 采集 Recharge.com 全球 Apple / PlayStation / Xbox 礼品卡报价（法币平台，已含页内 Service Fee）
 */
export async function collectRecharge(rates = {}) {
  const now = new Date().toISOString();
  const tasks = [];
  for (const cfg of BRAND_PAGES) {
    for (const cc of cfg.countries) {
      if (!isExcludedCountry(cc.toUpperCase(), cfg.brand)) {
        tasks.push({ cc, slug: cfg.slug, brand: cfg.brand });
      }
    }
  }
  const deduped = new Map();

  await mapLimit(
    tasks,
    4,
    async ({ cc, slug, brand }) => {
      const country = normalizeCountry(cc);
      const pageUrl = `https://www.recharge.com/en/${cc}/${slug}`;

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
          if (detectBrandSeries(prod.name) !== brand) continue;
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
              String(prod.name || "").match(/\b(USD|EUR|GBP|CAD|AUD|TRY|JPY|CHF|SEK|NOK|DKK|PLN|AED|SAR|NZD|HKD|KRW|MYR|SGD|TWD|MXN|BRL|INR|IDR|THB)\b/i)?.[1] ||
              COUNTRY_META[country]?.currency ||
              priceCur
            ).toUpperCase();

            const inStock = !/OutOfStock/i.test(String(off?.availability || ""));
            const offer = {
              siteId: SITE_ID,
              siteName: SITE_NAME,
              brand,
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

            const key = `${brand}|${country}|${fvCur}|fixed|${offer.faceValue}`;
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
