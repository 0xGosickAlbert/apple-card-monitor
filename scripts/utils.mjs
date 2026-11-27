import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "docs", "data");

export const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 记录已知需要通过系统 curl 访问的域名，避免每次重试都先卡在 undici TLS 握手
const curlPreferredHosts = new Set();

async function curlRequest(url, options = {}, timeoutMs = 15000) {
  const args = [
    "-sS",
    "-L",
    "--max-time",
    String(Math.max(3, Math.ceil(timeoutMs / 1000))),
    "-w",
    "\n__HTTP_CODE__:%{http_code}",
    "-X",
    options.method || "GET",
  ];
  const headers = {
    "User-Agent": CHROME_UA,
    Accept: "application/json, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    ...(options.headers || {}),
  };
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (options.body !== undefined && options.body !== null) {
    args.push("--data-raw", typeof options.body === "string" ? options.body : JSON.stringify(options.body));
  }
  args.push(url);

  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 25 * 1024 * 1024 });
  const marker = "\n__HTTP_CODE__:";
  const idx = stdout.lastIndexOf(marker);
  const status = idx !== -1 ? Number(stdout.slice(idx + marker.length).trim()) : 200;
  const textBody = idx !== -1 ? stdout.slice(0, idx) : stdout;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return textBody;
    },
    async json() {
      return JSON.parse(textBody);
    },
  };
}

/**
 * 加载项目根目录 .env 文件到 process.env（不覆盖已有环境变量）
 */
export async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(ROOT_DIR, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env 不存在时忽略（GitHub Actions 环境使用 Secrets）
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchWithRetry(url, options = {}, { timeoutMs = 15000, retries = 2 } = {}) {
  const host = new URL(url).host;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      let res;
      if (curlPreferredHosts.has(host)) {
        res = await curlRequest(url, options, timeoutMs);
      } else {
        try {
          const headers = {
            "User-Agent": CHROME_UA,
            Accept: "application/json, text/html, */*",
            "Accept-Language": "en-US,en;q=0.9",
            ...(options.headers || {}),
          };
          res = await fetch(url, {
            ...options,
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (fetchErr) {
          // Node undici 在部分 TLS 环境下会断连，自动记忆域名并切换系统 curl
          curlPreferredHosts.add(host);
          res = await curlRequest(url, options, timeoutMs);
        }
      }
      if (res.status === 429) {
        const err = new Error("HTTP 429");
        err.is429 = true;
        throw err;
      }
      if (res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await sleep((err.is429 ? 1500 : 500) * (i + 1));
      }
    }
  }
  throw lastErr;
}

export async function fetchJson(url, options = {}, cfg = {}) {
  const res = await fetchWithRetry(url, options, cfg);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 160)}`);
  }
  return res.json();
}

export async function fetchText(url, options = {}, cfg = {}) {
  const res = await fetchWithRetry(url, options, cfg);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/**
 * 并发限制执行器
 */
export async function mapLimit(items, concurrency, fn, delayMs = 0) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
      if (delayMs > 0 && idx < items.length) {
        await sleep(delayMs);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export const COUNTRY_META = {
  US: { name: "美国", en: "United States", flag: "🇺🇸", currency: "USD" },
  GB: { name: "英国", en: "United Kingdom", flag: "🇬🇧", currency: "GBP" },
  JP: { name: "日本", en: "Japan", flag: "🇯🇵", currency: "JPY" },
  HK: { name: "中国香港", en: "Hong Kong", flag: "🇭🇰", currency: "HKD" },
  TW: { name: "中国台湾", en: "Taiwan", flag: "🇹🇼", currency: "TWD" },
  TR: { name: "土耳其", en: "Turkey", flag: "🇹🇷", currency: "TRY" },
  NG: { name: "尼日利亚", en: "Nigeria", flag: "🇳🇬", currency: "NGN" },
  IN: { name: "印度", en: "India", flag: "🇮🇳", currency: "INR" },
  AU: { name: "澳大利亚", en: "Australia", flag: "🇦🇺", currency: "AUD" },
  CA: { name: "加拿大", en: "Canada", flag: "🇨🇦", currency: "CAD" },
  DE: { name: "德国", en: "Germany", flag: "🇩🇪", currency: "EUR" },
  FR: { name: "法国", en: "France", flag: "🇫🇷", currency: "EUR" },
  IT: { name: "意大利", en: "Italy", flag: "🇮🇹", currency: "EUR" },
  ES: { name: "西班牙", en: "Spain", flag: "🇪🇸", currency: "EUR" },
  NL: { name: "荷兰", en: "Netherlands", flag: "🇳🇱", currency: "EUR" },
  BE: { name: "比利时", en: "Belgium", flag: "🇧🇪", currency: "EUR" },
  AT: { name: "奥地利", en: "Austria", flag: "🇦🇹", currency: "EUR" },
  PT: { name: "葡萄牙", en: "Portugal", flag: "🇵🇹", currency: "EUR" },
  FI: { name: "芬兰", en: "Finland", flag: "🇫🇮", currency: "EUR" },
  IE: { name: "爱尔兰", en: "Ireland", flag: "🇮🇪", currency: "EUR" },
  GR: { name: "希腊", en: "Greece", flag: "🇬🇷", currency: "EUR" },
  LU: { name: "卢森堡", en: "Luxembourg", flag: "🇱🇺", currency: "EUR" },
  CH: { name: "瑞士", en: "Switzerland", flag: "🇨🇭", currency: "CHF" },
  SE: { name: "瑞典", en: "Sweden", flag: "🇸🇪", currency: "SEK" },
  NO: { name: "挪威", en: "Norway", flag: "🇳🇴", currency: "NOK" },
  DK: { name: "丹麦", en: "Denmark", flag: "🇩🇰", currency: "DKK" },
  PL: { name: "波兰", en: "Poland", flag: "🇵🇱", currency: "PLN" },
  CZ: { name: "捷克", en: "Czechia", flag: "🇨🇿", currency: "CZK" },
  RO: { name: "罗马尼亚", en: "Romania", flag: "🇷🇴", currency: "RON" },
  HU: { name: "匈牙利", en: "Hungary", flag: "🇭🇺", currency: "HUF" },
  AE: { name: "阿联酋", en: "UAE", flag: "🇦🇪", currency: "AED" },
  SA: { name: "沙特阿拉伯", en: "Saudi Arabia", flag: "🇸🇦", currency: "SAR" },
  QA: { name: "卡塔尔", en: "Qatar", flag: "🇶🇦", currency: "QAR" },
  KW: { name: "科威特", en: "Kuwait", flag: "🇰🇼", currency: "KWD" },
  BH: { name: "巴林", en: "Bahrain", flag: "🇧🇭", currency: "BHD" },
  OM: { name: "阿曼", en: "Oman", flag: "🇴🇲", currency: "OMR" },
  EG: { name: "埃及", en: "Egypt", flag: "🇪🇬", currency: "EGP" },
  ZA: { name: "南非", en: "South Africa", flag: "🇿🇦", currency: "ZAR" },
  KE: { name: "肯尼亚", en: "Kenya", flag: "🇰🇪", currency: "KES" },
  SG: { name: "新加坡", en: "Singapore", flag: "🇸🇬", currency: "SGD" },
  MY: { name: "马来西亚", en: "Malaysia", flag: "🇲🇾", currency: "MYR" },
  ID: { name: "印度尼西亚", en: "Indonesia", flag: "🇮🇩", currency: "IDR" },
  TH: { name: "泰国", en: "Thailand", flag: "🇹🇭", currency: "THB" },
  PH: { name: "菲律宾", en: "Philippines", flag: "🇵🇭", currency: "PHP" },
  VN: { name: "越南", en: "Vietnam", flag: "🇻🇳", currency: "VND" },
  KR: { name: "韩国", en: "South Korea", flag: "🇰🇷", currency: "KRW" },
  NZ: { name: "新西兰", en: "New Zealand", flag: "🇳🇿", currency: "NZD" },
  BR: { name: "巴西", en: "Brazil", flag: "🇧🇷", currency: "BRL" },
  MX: { name: "墨西哥", en: "Mexico", flag: "🇲🇽", currency: "MXN" },
  AR: { name: "阿根廷", en: "Argentina", flag: "🇦🇷", currency: "ARS" },
  CL: { name: "智利", en: "Chile", flag: "🇨🇱", currency: "CLP" },
  CO: { name: "哥伦比亚", en: "Colombia", flag: "🇨🇴", currency: "COP" },
  CN: { name: "中国大陆", en: "China", flag: "🇨🇳", currency: "CNY" },
  EU: { name: "欧元区", en: "Europe", flag: "🇪🇺", currency: "EUR" },
  WW: { name: "全球", en: "Global", flag: "🌐", currency: "USD" },
};

const NAME_TO_CODE = {
  usa: "US",
  "united states": "US",
  us: "US",
  uk: "GB",
  "united kingdom": "GB",
  britain: "GB",
  gb: "GB",
  ksa: "SA",
  "saudi arabia": "SA",
  uae: "AE",
  "united arab emirates": "AE",
  turkey: "TR",
  turkiye: "TR",
  "türkiye": "TR",
  japan: "JP",
  "hong kong": "HK",
  taiwan: "TW",
  nigeria: "NG",
  india: "IN",
  australia: "AU",
  canada: "CA",
  germany: "DE",
  france: "FR",
  italy: "IT",
  spain: "ES",
  netherlands: "NL",
  belgium: "BE",
  austria: "AT",
  portugal: "PT",
  finland: "FI",
  ireland: "IE",
  greece: "GR",
  luxembourg: "LU",
  switzerland: "CH",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  poland: "PL",
  czech: "CZ",
  czechia: "CZ",
  romania: "RO",
  hungary: "HU",
  egypt: "EG",
  "south africa": "ZA",
  singapore: "SG",
  malaysia: "MY",
  indonesia: "ID",
  thailand: "TH",
  philippines: "PH",
  vietnam: "VN",
  "south korea": "KR",
  korea: "KR",
  "new zealand": "NZ",
  brazil: "BR",
  mexico: "MX",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  qatar: "QA",
  kuwait: "KW",
  bahrain: "BH",
  oman: "OM",
  china: "CN",
  europe: "EU",
  global: "WW",
};

/**
 * 归一化国家代码（ISO 3166-1 alpha-2 大写）
 */
export function normalizeCountry(raw, fallbackText = "") {
  if (raw) {
    const code = String(raw).trim().toUpperCase();
    if (code === "UK") return "GB";
    if (code === "EN") return "US";
    if (/^[A-Z]{2}$/.test(code)) return code;
    const mapped = NAME_TO_CODE[String(raw).trim().toLowerCase()];
    if (mapped) return mapped;
  }
  if (fallbackText) {
    const lower = fallbackText.toLowerCase();
    for (const [key, code] of Object.entries(NAME_TO_CODE)) {
      if (new RegExp(`\\b${key}\\b`, "i").test(lower)) {
        return code;
      }
    }
  }
  return "WW";
}

export function isAppleBrandName(name) {
  if (!name) return false;
  const s = String(name).trim();
  const excluded =
    /\b(applebee|applebees|apple\s*&\s*eve|pineapple|snapple|big\s*apple|red\s*apple|green\s*apple|bad\s*apple|macbook\s*repair|airpods|iphone|ipad|macbook|imac|apple\s*watch|watch\s*(se|series|ultra)|pencil|airtag|homepod|vision\s*pro|magsafe|earpods|magic\s*(mouse|keyboard|trackpad)|studio\s*display|mac\s*(mini|studio|pro)|beats|charger|adapter|cable|aluminium|aluminum|sport\s*band|gps|40mm|42mm|44mm|46mm|128gb|256gb|512gb|1tb|usb-c)\b|애플펜슬|主動消噪|클라우드/i;
  if (excluded.test(s)) return false;
  return /\b(apple|itunes|app\s*store|appstore)\b|苹果/i.test(s);
}

export function roundNum(n, digits = 4) {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}
