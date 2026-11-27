import { fetchJson } from "./utils.mjs";

/**
 * 获取基于 USD 的全球法币实时汇率（主备双源合并）
 */
export async function fetchExchangeRates() {
  const rates = { USD: 1, USDT: 1 };
  let updatedAt = new Date().toISOString();
  let source = "";

  try {
    const primary = await fetchJson("https://open.er-api.com/v6/latest/USD", {}, { timeoutMs: 12000 });
    if (primary?.rates) {
      for (const [k, v] of Object.entries(primary.rates)) {
        if (typeof v === "number" && v > 0) rates[k.toUpperCase()] = v;
      }
      if (primary.time_last_update_utc) {
        updatedAt = new Date(primary.time_last_update_utc).toISOString();
      }
      source = "open.er-api.com";
    }
  } catch (err) {
    console.warn(`[汇率] 主源 open.er-api.com 失败: ${err.message}`);
  }

  try {
    const backup = await fetchJson(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      {},
      { timeoutMs: 12000 }
    );
    if (backup?.usd) {
      for (const [k, v] of Object.entries(backup.usd)) {
        const code = k.toUpperCase();
        if (!(code in rates) && typeof v === "number" && v > 0) {
          rates[code] = v;
        }
      }
      if (!source) source = "jsdelivr currency-api";
    }
  } catch (err) {
    console.warn(`[汇率] 备源 jsdelivr currency-api 失败: ${err.message}`);
  }

  if (!rates.CNY) {
    throw new Error("未能获取到有效的 CNY 基准汇率");
  }

  // USDT 按 1:1 锚定 USD（若备源提供了极小偏差，也仅作参考，礼品卡市场以 1 USDT ≈ 1 USD 计价）
  rates.USD = 1;
  rates.USDT = 1;

  return {
    base: "USD",
    source,
    updatedAt,
    rates,
  };
}
