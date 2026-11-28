import { detectBrandSeries, fetchText, isExcludedCountry, mapLimit, normalizeCountry, roundNum } from "../utils.mjs";

const SITE_ID = "tokenstore";
const SITE_NAME = "Tokenstore";

const BRAND_SLUGS = [
  { slug: "apple", brand: "apple" },
  { slug: "playstation", brand: "playstation" },
  { slug: "xbox", brand: "xbox" },
];

const FALLBACK_PREFIXES = [
  "us/en", "gb/en", "tr/tr", "de/de", "fr/fr", "es/es", "it/it", "nl/nl",
  "at/de", "be/nl", "ch/de", "dk/da", "fi/fi", "no/nb", "se/sv", "pl/pl",
  "pt/pt", "jp/ja", "kr/ko", "hk/zh", "br/pt", "hu/hu", "hr/hr", "lt/lt",
  "lv/lv", "ua/uk", "ww/en",
];

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function slugifyProduct(p) {
  if (p.slug) return `${p.slug}-${p.id}`;
  const clean = String(p.name || "apple")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${clean}-${p.id}`;
}

function parseFaceValueFromDenom(d, fallbackCurrency) {
  const txt = `${d.short_label || ""} ${d.name || ""}`;
  const m = txt.match(/([0-9]+(?:\.[0-9]+)?)\s*(USD|GBP|EUR|TRY|JPY|HKD|TWD|AUD|CAD|CHF|DKK|NOK|SEK|PLN|BRL|KRW|AED|SAR|INR|NGN)/i);
  if (m) {
    return { faceValue: Number(m[1]), currency: m[2].toUpperCase() };
  }
  const numM = txt.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (numM) {
    return { faceValue: Number(numM[1]), currency: String(d.currency || fallbackCurrency || "USD").toUpperCase() };
  }
  return null;
}

/**
 * 采集 Tokenstore 全球各国 Apple 礼品卡报价
 */
export async function collectTokenstore() {
  const now = new Date().toISOString();
  let prefixes = [...FALLBACK_PREFIXES];

  try {
    const homeHtml = await fetchText("https://tokenstore.io/us/en", {}, { timeoutMs: 15000 });
    const found = [...new Set([...homeHtml.matchAll(/https:\/\/tokenstore\.io\/([a-z]{2}\/[a-z]{2})/g)].map((m) => m[1]))];
    if (found.length >= 10) {
      prefixes = found.filter((p) => !p.startsWith("ru/") && !p.startsWith("cn/"));
    }
  } catch {
    // 使用内置前缀列表
  }

  const brandTasks = [];
  for (const prefix of prefixes) {
    for (const b of BRAND_SLUGS) {
      brandTasks.push({ prefix, ...b });
    }
  }

  const productUrls = new Map(); // id -> { brand, url, country, name }
  await mapLimit(
    brandTasks,
    5,
    async ({ prefix, slug, brand }) => {
      try {
        const html = await fetchText(`https://tokenstore.io/${prefix}/brands/${slug}`, {}, { timeoutMs: 12000 });
        const nd = extractNextData(html);
        const products = nd?.props?.pageProps?.products || [];
        for (const p of products) {
          if (!p?.id) continue;
          const detected = detectBrandSeries(p.name) || (slug === "apple" ? "apple" : null);
          if (detected !== brand) continue;
          const catSlug = p.categories?.slug || "ecommerce";
          const url = `https://tokenstore.io/${prefix}/${catSlug}/${slugifyProduct(p)}`;
          const c = normalizeCountry(p.countries?.[0] || prefix.split("/")[0], p.name);
          if (isExcludedCountry(c, brand)) continue;
          if (!productUrls.has(p.id)) {
            productUrls.set(p.id, { id: p.id, brand, url, country: c, name: p.name });
          }
        }
      } catch {
        // 个别国家未上架对应品牌，忽略
      }
    },
    100
  );

  const offers = [];
  await mapLimit(
    [...productUrls.values()],
    4,
    async (entry) => {
      try {
        const html = await fetchText(entry.url, {}, { timeoutMs: 15000 });
        const nd = extractNextData(html);
        const data = nd?.props?.pageProps?.data;
        if (!data) return;

        const country = normalizeCountry(data.countries?.[0] || entry.country, data.name);
        if (isExcludedCountry(country, entry.brand)) return;
        const denoms = data.denominations || [];
        for (const d of denoms) {
          if (d.status && d.status !== "active") continue;
          const parsed = parseFaceValueFromDenom(d, d.currency);
          if (!parsed || !(parsed.faceValue > 0)) continue;

          const payUsd = Number(d.usdt_price ?? d.busd_price ?? d.price);
          if (!(payUsd > 0)) continue;

          offers.push({
            siteId: SITE_ID,
            siteName: SITE_NAME,
            brand: entry.brand,
            country,
            currency: parsed.currency,
            type: "fixed",
            faceValue: roundNum(parsed.faceValue, 2),
            minFaceValue: null,
            maxFaceValue: null,
            step: 1,
            payUsd: roundNum(payUsd, 4),
            unitPayUsd: null,
            inStock: Number(d.stock ?? 1) > 0,
            url: entry.url,
            updatedAt: now,
          });
        }
      } catch (err) {
        console.warn(`[Tokenstore] 商品 ${entry.url} 解析失败: ${err.message}`);
      }
    },
    120
  );

  return offers;
}
