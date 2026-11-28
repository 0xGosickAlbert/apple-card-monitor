import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_SERIES, COUNTRY_META, DATA_DIR, isExcludedCountry, loadEnv, roundNum } from "./utils.mjs";
import { fetchExchangeRates } from "./rates.mjs";
import { collectTamana } from "./providers/tamana.mjs";
import { collectCryptoRefills } from "./providers/cryptorefills.mjs";
import { collectCoinsbee } from "./providers/coinsbee.mjs";
import { collectTokenstore } from "./providers/tokenstore.mjs";
import { collectCoinGate } from "./providers/coingate.mjs";
import { collectByteTopup } from "./providers/bytetopup.mjs";
import { collectBitrefillApi } from "./providers/bitrefill.mjs";
import { collectKeys4Coins } from "./providers/keys4coins.mjs";
import { collectBitGift } from "./providers/bitgift.mjs";
import { collectEneba } from "./providers/eneba.mjs";
import { collectRecharge } from "./providers/recharge.mjs";

const ALL_SITES = [
  { id: "tamana", name: "Tamana", mode: "api", paymentType: "crypto" },
  { id: "cryptorefills", name: "CryptoRefills", mode: "api", paymentType: "crypto" },
  { id: "coinsbee", name: "Coinsbee", mode: "api", paymentType: "crypto" },
  { id: "tokenstore", name: "Tokenstore", mode: "ssr", paymentType: "crypto" },
  { id: "coingate", name: "CoinGate", mode: "api", paymentType: "crypto" },
  { id: "bytetopup", name: "ByteTopup", mode: "ssr", paymentType: "crypto" },
  { id: "bitrefill", name: "Bitrefill", mode: "api+browser", paymentType: "crypto" },
  { id: "kryptomate", name: "Kryptomate", mode: "browser", paymentType: "crypto" },
  { id: "keys4coins", name: "Keys4Coins", mode: "api", paymentType: "crypto" },
  { id: "bitgift", name: "BitGift", mode: "ssr", paymentType: "crypto" },
  { id: "eneba", name: "Eneba", mode: "ssr", paymentType: "fiat" },
  { id: "recharge", name: "Recharge", mode: "ssr", paymentType: "fiat" },
];

const SITE_META_MAP = new Map(ALL_SITES.map((s) => [s.id, s]));

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function offerKey(o) {
  const fvPart = o.type === "range" ? `range:${o.minFaceValue}-${o.maxFaceValue}` : `fixed:${o.faceValue}`;
  return `${o.brand || "apple"}|${o.siteId}|${o.country}|${o.currency}|${fvPart}`;
}

function summarizeByBrand(offers) {
  const byBrand = {};
  for (const b of BRAND_SERIES) {
    const bOffers = offers.filter((o) => (o.brand || "apple") === b.id);
    byBrand[b.id] = {
      offerCount: bOffers.length,
      countryCount: new Set(bOffers.map((o) => o.country)).size,
    };
  }
  return byBrand;
}

function effectiveUnitUsd(o) {
  if (o.type === "range") return Number(o.unitPayUsd);
  if (o.faceValue > 0 && o.payUsd > 0) return o.payUsd / o.faceValue;
  return null;
}

export async function runCollect() {
  await loadEnv();
  await fs.mkdir(DATA_DIR, { recursive: true });

  console.log("1) 正在获取最新国际实时货币汇率...");
  const rateInfo = await fetchExchangeRates();
  const { rates } = rateInfo;
  console.log(
    `   汇率源: ${rateInfo.source} | 1 USD = ${rates.CNY} CNY | ${rates.TRY} TRY | ${rates.JPY} JPY | ${rates.TWD} TWD`
  );

  const prevLatest = await readJsonIfExists(path.join(DATA_DIR, "latest.json"));
  const browserCache = await readJsonIfExists(path.join(DATA_DIR, "browser-cache.json"));

  const prevOfferMap = new Map();
  for (const o of prevLatest?.offers || []) {
    prevOfferMap.set(offerKey(o), o);
  }

  console.log("2) 正在并发采集直连平台...");
  const tasks = [
    { id: "tamana", fn: () => collectTamana() },
    { id: "cryptorefills", fn: () => collectCryptoRefills(rates) },
    { id: "coinsbee", fn: () => collectCoinsbee() },
    { id: "tokenstore", fn: () => collectTokenstore() },
    { id: "coingate", fn: () => collectCoinGate(rates) },
    { id: "bytetopup", fn: () => collectByteTopup(rates) },
    { id: "bitrefill", fn: () => collectBitrefillApi(rates) },
    { id: "keys4coins", fn: () => collectKeys4Coins(rates) },
    { id: "bitgift", fn: () => collectBitGift(rates) },
    { id: "eneba", fn: () => collectEneba(rates) },
    { id: "recharge", fn: () => collectRecharge(rates) },
  ];

  const siteStats = {};
  const settled = await Promise.all(
    tasks.map(async (t) => {
      const started = Date.now();
      try {
        const res = await t.fn();
        const offers = Array.isArray(res) ? res : res.offers || [];
        const sourceStatus = Array.isArray(res) ? "ok" : res.sourceStatus || "ok";
        return { id: t.id, offers, sourceStatus, error: null, ms: Date.now() - started };
      } catch (err) {
        console.warn(`[${t.id}] 采集失败: ${err.message}`);
        return { id: t.id, offers: [], sourceStatus: "error", error: err.message, ms: Date.now() - started };
      }
    })
  );

  const mergedOffers = [];
  for (const r of settled) {
    let offers = r.offers;
    let status = r.sourceStatus;
    let updatedAt = offers[0]?.updatedAt || new Date().toISOString();

    // 若 Bitrefill 官方 API 未返回 Apple 产品，自动读取浏览器缓存快照
    if (r.id === "bitrefill" && offers.length === 0 && browserCache?.sites?.bitrefill?.offers?.length) {
      offers = browserCache.sites.bitrefill.offers;
      updatedAt = browserCache.sites.bitrefill.updatedAt || updatedAt;
      status = "browser_cache";
    }

    // 若直连平台本次异常返回 0 条，但上次快照中有数据，则保留上次数据防掉线
    if (offers.length === 0 && r.id !== "bitrefill" && prevLatest?.offers?.length) {
      const prevSiteOffers = prevLatest.offers.filter((o) => o.siteId === r.id);
      if (prevSiteOffers.length > 0) {
        offers = prevSiteOffers;
        updatedAt = prevLatest.sites?.[r.id]?.updatedAt || updatedAt;
        status = "stale_cache";
      }
    }

    offers = offers
      .map((o) => ({ ...o, brand: o.brand || "apple" }))
      .filter((o) => !isExcludedCountry(o.country, o.brand));
    mergedOffers.push(...offers);
    const countriesCount = new Set(offers.map((o) => o.country)).size;
    const siteMeta = SITE_META_MAP.get(r.id);
    siteStats[r.id] = {
      name: siteMeta?.name || r.id,
      paymentType: siteMeta?.paymentType || "crypto",
      status,
      error: r.error,
      offerCount: offers.length,
      countryCount: countriesCount,
      byBrand: summarizeByBrand(offers),
      updatedAt,
      elapsedMs: r.ms,
    };
  }

  // 合并 Kryptomate 浏览器缓存数据
  const kmCache = browserCache?.sites?.kryptomate;
  const kmOffers = (kmCache?.offers?.length
    ? kmCache.offers
    : (prevLatest?.offers || []).filter((o) => o.siteId === "kryptomate")
  )
    .map((o) => ({ ...o, brand: o.brand || "apple" }))
    .filter((o) => !isExcludedCountry(o.country, o.brand));
  mergedOffers.push(...kmOffers);
  siteStats.kryptomate = {
    name: "Kryptomate",
    paymentType: "crypto",
    status: kmOffers.length ? "browser_cache" : "pending_browser_sync",
    error: null,
    offerCount: kmOffers.length,
    countryCount: new Set(kmOffers.map((o) => o.country)).size,
    byBrand: summarizeByBrand(kmOffers),
    updatedAt: kmCache?.updatedAt || prevLatest?.sites?.kryptomate?.updatedAt || null,
    elapsedMs: 0,
  };

  // 过滤无效报价并计算真实汇率比例 & 历史价格浮动
  const finalOffers = [];
  for (const o of mergedOffers) {
    const brand = o.brand || "apple";
    if (isExcludedCountry(o.country, brand)) continue;
    const rate = o.currency === "USD" || o.currency === "USDT" ? 1 : rates[o.currency];
    if (!(rate > 0)) continue;

    if (o.type === "range") {
      if (!(o.unitPayUsd > 0) || !(o.minFaceValue > 0) || !(o.maxFaceValue >= o.minFaceValue)) continue;
    } else {
      if (!(o.faceValue > 0) || !(o.payUsd > 0)) continue;
    }

    const key = offerKey(o);
    const prev = prevOfferMap.get(key);
    const curUnit = effectiveUnitUsd(o);
    const prevUnit = prev ? effectiveUnitUsd(prev) : null;

    let diffPct = null;
    let diffUsd = null;
    let prevPayUsd = prev?.payUsd ?? null;
    let changedAt = prev?.changedAt ?? null;

    if (curUnit > 0 && prevUnit > 0) {
      const pct = ((curUnit - prevUnit) / prevUnit) * 100;
      if (Math.abs(pct) >= 0.01) {
        diffPct = roundNum(pct, 2);
        if (o.type === "fixed" && prev?.payUsd > 0) {
          diffUsd = roundNum(o.payUsd - prev.payUsd, 4);
        }
        changedAt = new Date().toISOString();
      } else {
        diffPct = prev?.diffPct ?? 0;
        diffUsd = prev?.diffUsd ?? 0;
      }
    }

    // 真实汇率比例 = 实际支付 USD / 面值按国际汇率折算的 USD
    const fxRatio = roundNum(curUnit * rate * 100, 2); // 例如 96.85 代表占真实汇率的 96.85%
    const stockCount =
      o.stockCount !== null && o.stockCount !== undefined && Number.isFinite(Number(o.stockCount))
        ? Math.max(0, Math.floor(Number(o.stockCount)))
        : null;
    const inStock = stockCount === 0 ? false : Boolean(o.inStock);
    const paymentType = o.paymentType || SITE_META_MAP.get(o.siteId)?.paymentType || "crypto";

    finalOffers.push({
      ...o,
      brand,
      paymentType,
      inStock,
      stockCount,
      fxRatio,
      prevPayUsd,
      diffUsd,
      diffPct,
      changedAt,
    });
  }

  // 构建国家目录元数据
  const countrySet = new Set(finalOffers.map((o) => o.country));
  const countries = {};
  for (const cc of [...countrySet].sort()) {
    const meta = COUNTRY_META[cc] || { name: cc, en: cc, flag: "🏳️", currency: "USD" };
    const cOffers = finalOffers.filter((o) => o.country === cc);
    countries[cc] = {
      code: cc,
      name: meta.name,
      en: meta.en,
      flag: meta.flag,
      currency: cOffers[0]?.currency || meta.currency,
      offerCount: cOffers.length,
      siteCount: new Set(cOffers.map((o) => o.siteId)).size,
    };
  }

  const brands = {};
  for (const b of BRAND_SERIES) {
    const bOffers = finalOffers.filter((o) => o.brand === b.id);
    brands[b.id] = {
      id: b.id,
      name: b.name,
      icon: b.icon,
      offerCount: bOffers.length,
      countryCount: new Set(bOffers.map((o) => o.country)).size,
      countries: [...new Set(bOffers.map((o) => o.country))].sort(),
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    rateInfo,
    brands,
    countries,
    sites: siteStats,
    offers: finalOffers,
  };

  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(output), "utf8");

  console.log("\n=== 12 大平台采集结果汇总 ===");
  for (const s of ALL_SITES) {
    const st = siteStats[s.id];
    const b = st.byBrand || {};
    const detail = `A:${b.apple?.offerCount || 0} P:${b.playstation?.offerCount || 0} X:${b.xbox?.offerCount || 0}`;
    console.log(
      `  - ${st.name.padEnd(14)} | 状态: ${String(st.status).padEnd(14)} | 国家: ${String(st.countryCount).padStart(2)} | 规格数: ${String(st.offerCount).padStart(4)} (${detail}) | 耗时: ${st.elapsedMs}ms`
    );
  }
  console.log(
    `分系列汇总 -> Apple: ${brands.apple.countryCount}国/${brands.apple.offerCount}条 | PlayStation: ${brands.playstation.countryCount}国/${brands.playstation.offerCount}条 | Xbox: ${brands.xbox.countryCount}国/${brands.xbox.offerCount}条`
  );
  console.log(`总计有效报价: ${finalOffers.length} 条 | 覆盖国家/地区: ${Object.keys(countries).length} 个\n`);
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCollect().catch((err) => {
    console.error("采集运行出错:", err);
    process.exit(1);
  });
}
