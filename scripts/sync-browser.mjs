import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, isAppleBrandName, normalizeCountry, roundNum } from "./utils.mjs";
import { runCollect } from "./collect.mjs";

const CACHE_FILE = path.join(DATA_DIR, "browser-cache.json");
const TMP_RESULT_FILE = path.join(os.tmpdir(), "apple-monitor-browser-sync.json");

function runEgoBrowserScript(scriptCode) {
  return new Promise((resolve, reject) => {
    const child = spawn("ego-browser", ["nodejs"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(scriptCode);
    child.stdin.end();
  });
}

function parseKryptomateOffers(giftCards, now) {
  const offers = [];
  for (const gc of giftCards || []) {
    if (!isAppleBrandName(gc.name)) continue;
    const isActive = String(gc.status || "ACTIVE").toUpperCase() === "ACTIVE";
    const country = normalizeCountry(gc.countryCode || gc.countries?.[0], gc.name);
    const url = gc.slug
      ? `https://kryptomate.com/zh/gift-cards/${gc.slug}`
      : "https://kryptomate.com/zh/gift-cards?query=Apple";

    for (const item of gc.items || []) {
      const currency = String(item.currencyCode || gc.currency || "USD").toUpperCase();
      const minFV = Number(item.minValue);
      const maxFV = Number(item.maxValue);
      const price = Number(item.price);
      const rate = Number(item.exchangeRate);

      if (!(minFV > 0)) continue;

      if (item.valueType !== "fixed_denomination" && maxFV > minFV) {
        const unitPayUsd = rate > 0 ? rate : (price > 0 ? price / minFV : null);
        if (!(unitPayUsd > 0)) continue;
        offers.push({
          siteId: "kryptomate",
          siteName: "Kryptomate",
          country,
          currency,
          type: "range",
          faceValue: null,
          minFaceValue: roundNum(minFV, 2),
          maxFaceValue: roundNum(maxFV, 2),
          step: 1,
          payUsd: null,
          unitPayUsd: roundNum(unitPayUsd, 6),
          inStock: isActive,
          url,
          updatedAt: now,
        });
      } else {
        const payUsd = price > 0 ? price : (rate > 0 ? minFV * rate : null);
        if (!(payUsd > 0)) continue;
        offers.push({
          siteId: "kryptomate",
          siteName: "Kryptomate",
          country,
          currency,
          type: "fixed",
          faceValue: roundNum(minFV, 2),
          minFaceValue: null,
          maxFaceValue: null,
          step: 1,
          payUsd: roundNum(payUsd, 4),
          unitPayUsd: null,
          inStock: isActive,
          url,
          updatedAt: now,
        });
      }
    }
  }
  return offers;
}

function parseBitrefillOffers(products, now) {
  const offers = [];
  for (const det of products || []) {
    if (!det || (!isAppleBrandName(det.baseName) && !isAppleBrandName(det.name))) continue;
    const country = normalizeCountry(det.countryCode || det.countries?.[0], det.name);
    const currency = String(det.currency || "USD").toUpperCase();
    const inStock = !det.outOfStock;
    const url = `https://www.bitrefill.com/${country.toLowerCase()}/en/gift-cards/${det.slug}/`;

    for (const pkg of det.packages || []) {
      const fv = Number(pkg.amount ?? pkg.value);
      const usd = Number(pkg.usdPrice ?? (pkg.prices?.USD ? pkg.prices.USD / 100 : 0));
      if (!(fv > 0) || !(usd > 0)) continue;

      offers.push({
        siteId: "bitrefill",
        siteName: "Bitrefill",
        country,
        currency,
        type: "fixed",
        faceValue: roundNum(fv, 2),
        minFaceValue: null,
        maxFaceValue: null,
        step: 1,
        payUsd: roundNum(usd, 4),
        unitPayUsd: null,
        inStock,
        url,
        updatedAt: now,
      });
    }

    const r = det.range || (Array.isArray(det.rangedPackages) ? det.rangedPackages[0] : null);
    if (r && Number(r.min) > 0 && Number(r.max) > Number(r.min)) {
      const minFV = Number(r.min);
      const maxFV = Number(r.max);
      const minUsd = Number(r.minUsdPrice ?? (r.prices?.USD ? r.prices.USD / 100 : 0));
      const unitPayUsd = minUsd > 0 ? minUsd / minFV : null;
      if (unitPayUsd > 0) {
        offers.push({
          siteId: "bitrefill",
          siteName: "Bitrefill",
          country,
          currency,
          type: "range",
          faceValue: null,
          minFaceValue: roundNum(minFV, 2),
          maxFaceValue: roundNum(maxFV, 2),
          step: Number(r.step) || 1,
          payUsd: null,
          unitPayUsd: roundNum(unitPayUsd, 6),
          inStock,
          url,
          updatedAt: now,
        });
      }
    }
  }
  return offers;
}

async function main() {
  console.log("正在启动 ego-browser 采集 Kryptomate 与 Bitrefill 全球 Apple 礼品卡...");
  await fs.rm(TMP_RESULT_FILE, { force: true }).catch(() => {});

  const browserScript = `
const fs = await import("node:fs/promises");
const TMP_FILE = ${JSON.stringify(TMP_RESULT_FILE)};
const task = await taskSpace("apple-monitor-sync");
const page = task.page("p1");
const out = { handoff: null, kmCards: [], brProducts: [], errors: [] };

async function isCfChallenge() {
  const title = await page.title().catch(() => "");
  const snap = await page.snapshot().catch(() => "");
  return /just a moment|请稍候|attention required|security check/i.test(title) ||
    /verify you are human|确认您是真人|turnstile/i.test(snap);
}

// 1. 采集 Kryptomate
try {
  await page.goto("https://kryptomate.com/zh/gift-cards?query=Apple", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (await isCfChallenge()) {
    await task.handOff();
    out.handoff = { site: "Kryptomate", spaceId: task.spaceId };
    await fs.writeFile(TMP_FILE, JSON.stringify(out), "utf8");
    console.log("HANDOFF_KRYPTOMATE");
    process.exit(0);
  }
  const kmRes = await page.fetch("https://cryptomate.store/api/v2/home_search?key=Apple", { timeout: 15000 });
  if (kmRes.ok) {
    const kmJson = JSON.parse(kmRes.body);
    out.kmCards = kmJson?.data?.gift_cards || [];
  } else {
    out.errors.push("KM status " + kmRes.status);
  }
} catch (e) {
  out.errors.push("KM: " + e.message);
}

// 2. 采集 Bitrefill
try {
  await page.goto("https://www.bitrefill.com/us/en/", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  if (await isCfChallenge()) {
    await task.handOff();
    out.handoff = { site: "Bitrefill", spaceId: task.spaceId };
    await fs.writeFile(TMP_FILE, JSON.stringify(out), "utf8");
    console.log("HANDOFF_BITREFILL");
    process.exit(0);
  }
  const omniRes = await page.fetch("https://www.bitrefill.com/api/omni?q=apple&limit=100", { timeout: 15000 });
  if (omniRes.ok) {
    const oj = JSON.parse(omniRes.body);
    const slugs = (oj.products || [])
      .filter((p) => {
        const bn = String(p.baseName || "").toLowerCase();
        const id = String(p._id || "").toLowerCase();
        return bn === "apple" || bn.includes("itunes") || id.startsWith("apple-") || id.startsWith("itunes-");
      })
      .map((p) => p._id);
    for (let i = 0; i < slugs.length; i += 5) {
      const batch = slugs.slice(i, i + 5);
      const dets = await Promise.all(
        batch.map(async (slug) => {
          try {
            const r = await page.fetch("https://www.bitrefill.com/api/product/" + encodeURIComponent(slug) + "?paymentCurrency=USD", { timeout: 12000 });
            return r.ok ? JSON.parse(r.body) : null;
          } catch {
            return null;
          }
        })
      );
      for (const d of dets) {
        if (d) out.brProducts.push(d);
      }
    }
  } else {
    out.errors.push("BR omni status " + omniRes.status);
  }
} catch (e) {
  out.errors.push("BR: " + e.message);
}

await task.finish({ keep: [] });
await fs.writeFile(TMP_FILE, JSON.stringify(out), "utf8");
console.log("SYNC_BROWSER_OK", { km: out.kmCards.length, br: out.brProducts.length });
`;

  const res = await runEgoBrowserScript(browserScript);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(TMP_RESULT_FILE, "utf8"));
  } catch {
    console.error("ego-browser 未写出结果文件:\n", res.stdout, "\n", res.stderr);
    process.exit(1);
  }
  await fs.rm(TMP_RESULT_FILE, { force: true }).catch(() => {});
  if (payload.handoff) {
    console.error(
      `\n[需要手动过盾] ${payload.handoff.site} 触发了 Cloudflare 真人验证（ego-browser 空间 #${payload.handoff.spaceId} 已切换给您），请在浏览器中点击完成验证后重新运行 npm run sync:browser。`
    );
    process.exit(2);
  }

  if (payload.errors?.length) {
    console.warn("浏览器采集告警:", payload.errors);
  }

  const now = new Date().toISOString();
  const kmOffers = parseKryptomateOffers(payload.kmCards, now);
  const brOffers = parseBitrefillOffers(payload.brProducts, now);

  console.log(
    `浏览器采集完成: Kryptomate ${payload.kmCards.length} 国 / ${kmOffers.length} 条报价 | Bitrefill ${payload.brProducts.length} 国 / ${brOffers.length} 条报价`
  );

  await fs.mkdir(DATA_DIR, { recursive: true });
  let prevCache = { sites: {} };
  try {
    prevCache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    // 忽略首次不存在
  }

  const nextCache = {
    updatedAt: now,
    sites: {
      ...(prevCache.sites || {}),
      ...(kmOffers.length ? { kryptomate: { updatedAt: now, offers: kmOffers } } : {}),
      ...(brOffers.length ? { bitrefill: { updatedAt: now, offers: brOffers } } : {}),
    },
  };

  await fs.writeFile(CACHE_FILE, JSON.stringify(nextCache), "utf8");
  await runCollect();
}

main().catch((err) => {
  console.error("sync-browser 执行失败:", err);
  process.exit(1);
});
