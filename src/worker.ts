// VortexStock — Cloudflare Worker backend
// Direct Yahoo Finance HTTP API calls (no yahoo-finance2 library)

// ── Global passcode auth ─────────────────────────────────────────────
// HMAC-based token auth. Passcode is verified via SHA-256 hash comparison.
// Token is a signed timestamp that expires after 30 days.

const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const HMAC_SECRET = "vortex-stock-hmac-2026-secret-key";

async function sha256(message: string): Promise<string> {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPasscode(passcode: string): Promise<boolean> {
  const hash = await sha256(passcode);
  return hash === "cc7fe47ada74a02fa01a14369a4ae45c6ab402327a3ad5406bbc55105c086c59";
}

async function createAuthToken(): Promise<string> {
  const payload = Date.now().toString();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return payload + "." + sigHex;
}

async function verifyAuthToken(token: string): Promise<boolean> {
  try {
    const [payload, sigHex] = token.split(".");
    if (!payload || !sigHex) return false;
    // Check expiry
    const ts = parseInt(payload, 10);
    if (isNaN(ts) || Date.now() - ts > TOKEN_TTL) return false;
    // Verify HMAC
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

function getAuthCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/vortex_auth=([^;]+)/);
  return match ? match[1] : null;
}

// ── Simple TTL cache (5 min) ─────────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { data: unknown; expiry: number }>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function cacheSet(key: string, data: unknown): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

// ── Yahoo Finance HTTP helpers ───────────────────────────────────────
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

async function yfSearch(q: string): Promise<any> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=en-US&region=US&quotesCount=8&newsCount=5&enableFuzzyQuery=true&quotesQueryId=tss_match_phrase_query`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Yahoo search failed: ${res.status}`);
  return res.json();
}

async function yfChart(symbol: string, period1: number, period2: number, interval: string = "1d"): Promise<any> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Yahoo chart failed: ${res.status}`);
  return res.json();
}

// ── Yahoo Finance cookie/crumb auth for v7 quote endpoint ───────────
let yfCookie: string | null = null;
let yfCrumb: string | null = null;
let yfAuthExpiry = 0;

async function ensureYfAuth(): Promise<void> {
  if (yfCookie && yfCrumb && Date.now() < yfAuthExpiry) return;
  try {
    // Step 1: Get cookie from fc.yahoo.com
    // Try both redirect modes and header access patterns for CF Workers compatibility
    let setCookieVal: string | null = null;

    // Attempt 1: default redirect (follow) — fc.yahoo.com returns 404 with set-cookie
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": YF_HEADERS["User-Agent"] },
    });
    setCookieVal = cookieRes.headers.get("set-cookie");
    if (!setCookieVal) {
      const all = (cookieRes.headers as any).getAll?.("set-cookie");
      if (all && all.length > 0) setCookieVal = all[0];
    }

    // Attempt 2: manual redirect if first attempt got nothing
    if (!setCookieVal) {
      const cookieRes2 = await fetch("https://fc.yahoo.com", {
        headers: { "User-Agent": YF_HEADERS["User-Agent"] },
        redirect: "manual",
      });
      setCookieVal = cookieRes2.headers.get("set-cookie");
      if (!setCookieVal) {
        const all = (cookieRes2.headers as any).getAll?.("set-cookie");
        if (all && all.length > 0) setCookieVal = all[0];
      }
    }

    // Attempt 3: try login.yahoo.com which also sets A3 cookie
    if (!setCookieVal) {
      const cookieRes3 = await fetch("https://login.yahoo.com", {
        headers: { "User-Agent": YF_HEADERS["User-Agent"] },
        redirect: "manual",
      });
      setCookieVal = cookieRes3.headers.get("set-cookie");
      if (!setCookieVal) {
        const all = (cookieRes3.headers as any).getAll?.("set-cookie");
        if (all && all.length > 0) setCookieVal = all.find((c: string) => c.startsWith("A3=")) || all[0];
      }
    }

    if (!setCookieVal) throw new Error("No cookie returned from any Yahoo endpoint");
    // Extract just the cookie name=value pair
    yfCookie = setCookieVal.split(";")[0];

    // Step 2: Get crumb using the cookie
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YF_HEADERS["User-Agent"], "Cookie": yfCookie },
    });
    if (!crumbRes.ok) throw new Error(`Failed to get crumb: ${crumbRes.status}`);
    yfCrumb = (await crumbRes.text()).trim();
    if (!yfCrumb || yfCrumb.length < 3) throw new Error("Invalid crumb");
    yfAuthExpiry = Date.now() + 10 * 60 * 1000; // 10 min TTL
  } catch (e) {
    yfCookie = null;
    yfCrumb = null;
  }
}

async function yfQuote(symbol: string): Promise<any> {
  await ensureYfAuth();
  if (!yfCookie || !yfCrumb) return null;
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&crumb=${encodeURIComponent(yfCrumb)}`;
    const res = await fetch(url, {
      headers: { ...YF_HEADERS, "Cookie": yfCookie },
    });
    if (!res.ok) {
      // Invalidate auth on failure so next call refreshes
      yfAuthExpiry = 0;
      return null;
    }
    const data: any = await res.json();
    return data?.quoteResponse?.result?.[0] || null;
  } catch {
    return null;
  }
}

// ── Sentiment lexicon ────────────────────────────────────────────────
const POSITIVE_WORDS = new Set([
  "growth", "beat", "surge", "profit", "gain", "rally", "upgrade", "record",
  "bullish", "outperform", "strong", "boost", "soar", "rise", "positive",
  "buy", "exceed", "breakout", "momentum", "innovation", "partnership",
  "revenue", "expansion", "recover", "success", "earnings", "approval",
  "launch", "demand",
]);

const NEGATIVE_WORDS = new Set([
  "miss", "drop", "lawsuit", "loss", "decline", "downgrade", "bearish",
  "crash", "sell", "weak", "risk", "warning", "fear", "cut", "bankruptcy",
  "debt", "default", "recall", "fraud", "investigation", "penalty", "layoff",
  "restructure", "plunge", "slump", "inflation", "tariff", "concern",
  "volatility", "recession", "overvalued", "underperform", "delay", "shortage",
]);

function scoreSentiment(title: string): number {
  const words = title.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
  let score = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) score++;
    if (NEGATIVE_WORDS.has(w)) score--;
  }
  return score;
}

// ── Technical indicators ─────────────────────────────────────────────
function computeSMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      result.push(sum / period);
    }
  }
  return result;
}

function computeRSI(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  if (closes.length < 2) return result;
  const alpha = 1 / period;
  result.push(null);
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period && i < changes.length; i++) {
    if (changes[i] > 0) avgGain += changes[i]; else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = 1; i < period; i++) result.push(null);
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = alpha * gain + (1 - alpha) * avgGain;
    avgLoss = alpha * loss + (1 - alpha) * avgLoss;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return result;
}

function computeATR(highs: number[], lows: number[], closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const n = closes.length;
  if (n < 2) return [null];
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const alpha = 1 / period;
  for (let i = 0; i < period - 1; i++) result.push(null);
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period; result.push(atr);
  for (let i = period; i < n; i++) { atr = alpha * tr[i] + (1 - alpha) * atr; result.push(atr); }
  return result;
}

function computeADX(highs: number[], lows: number[], closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const result: (number | null)[] = new Array(n).fill(null);
  if (n < period * 2) return result;
  const alpha = 1 / period;
  const plusDM: number[] = [0], minusDM: number[] = [0], tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1], downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 1; i <= period; i++) { smoothTR += tr[i]; smoothPlusDM += plusDM[i]; smoothMinusDM += minusDM[i]; }
  const dxValues: number[] = [];
  let plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
  let minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
  let diSum = plusDI + minusDI;
  let dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  dxValues.push(dx);
  for (let i = period + 1; i < n; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
    minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
    diSum = plusDI + minusDI;
    dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dxValues.push(dx);
  }
  if (dxValues.length < period) return result;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxValues[i];
  adx /= period;
  const adxStartIdx = 2 * period - 1;
  result[adxStartIdx] = adx;
  for (let i = period; i < dxValues.length; i++) {
    adx = alpha * dxValues[i] + (1 - alpha) * adx;
    result[adxStartIdx + (i - period) + 1] = adx;
  }
  return result;
}

// ── Regime / signal ──────────────────────────────────────────────────
function classifyRegime(price: number, sma50: number | null, sma200: number | null, rsi: number | null, adx: number | null): string {
  if (rsi == null || sma50 == null || sma200 == null || adx == null) return "Chop / Ranging";
  if (rsi > 75) return "Overbought / Blowoff";
  if (rsi < 25) return "Oversold / Capitulation";
  // ADX >= 20 = trending (industry-standard threshold for directional strength)
  if (price > sma50 && sma50 > sma200 && adx >= 20) return "Strong Bull";
  if (price > sma50 && sma50 > sma200 && adx < 20) return "Weak Bull";
  if (price < sma50 && sma50 < sma200 && adx >= 20) return "Strong Bear";
  if (price < sma50 && sma50 < sma200 && adx < 20) return "Weak Bear";
  return "Chop / Ranging";
}

function classifySignal(regime: string): "LONG" | "SHORT" | "CASH" {
  if (regime === "Strong Bull" || regime === "Weak Bull" || regime === "Oversold / Capitulation") return "LONG";
  if (regime === "Strong Bear" || regime === "Weak Bear") return "SHORT";
  return "CASH";
}

// ── JSON response helper ─────────────────────────────────────────────
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ── Route handlers ───────────────────────────────────────────────────

async function handleSearch(url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  if (!q.trim()) return json({ results: [] });

  try {
    const data = await yfSearch(q);
    const quotes = (data.quotes || [])
      .filter((item: any) => item.quoteType === "EQUITY" || item.typeDisp === "Equity" || item.typeDisp === "equity")
      .slice(0, 8)
      .map((item: any) => ({
        symbol: item.symbol,
        name: item.shortname || item.longname || item.symbol,
        exchange: item.exchDisp || item.exchange || "",
      }));
    return json({ results: quotes });
  } catch (err: any) {
    return json({ error: err.message || "Search failed" }, 500);
  }
}

// ── Fundamental data extractor (robust, handles missing keys) ────────
function extractFundamentals(q: any): any {
  if (!q) return null;
  const g = (key: string, fallback: any = null) => q[key] ?? fallback;
  return {
    // Company profile
    sector: g("sector"),
    industry: g("industry"),
    longBusinessSummary: g("longBusinessSummary"),
    fullTimeEmployees: g("fullTimeEmployees"),
    website: g("website"),
    exchange: g("fullExchangeName") || g("exchange"),
    quoteType: g("quoteType"),
    // Valuation
    marketCap: g("marketCap"),
    trailingPE: g("trailingPE"),
    forwardPE: g("forwardPE"),
    priceToBook: g("priceToBook"),
    priceToSalesTrailing12Months: g("priceToSalesTrailing12Months"),
    enterpriseValue: g("enterpriseValue"),
    enterpriseToRevenue: g("enterpriseToRevenue"),
    enterpriseToEbitda: g("enterpriseToEbitda"),
    // Profitability
    profitMargins: g("profitMargins") != null ? +(g("profitMargins") * 100).toFixed(2) : null,
    operatingMargins: g("operatingMargins") != null ? +(g("operatingMargins") * 100).toFixed(2) : null,
    grossMargins: g("grossMargins") != null ? +(g("grossMargins") * 100).toFixed(2) : null,
    returnOnEquity: g("returnOnEquity") != null ? +(g("returnOnEquity") * 100).toFixed(2) : null,
    returnOnAssets: g("returnOnAssets") != null ? +(g("returnOnAssets") * 100).toFixed(2) : null,
    // Growth & earnings
    revenueGrowth: g("revenueGrowth") != null ? +(g("revenueGrowth") * 100).toFixed(2) : null,
    earningsGrowth: g("earningsGrowth") != null ? +(g("earningsGrowth") * 100).toFixed(2) : null,
    earningsQuarterlyGrowth: g("earningsQuarterlyGrowth") != null ? +(g("earningsQuarterlyGrowth") * 100).toFixed(2) : null,
    totalRevenue: g("totalRevenue"),
    revenuePerShare: g("revenuePerShare"),
    trailingEps: g("trailingEps"),
    forwardEps: g("forwardEps"),
    // Dividends
    dividendYield: g("dividendYield") != null ? +(g("dividendYield") * 100).toFixed(2) : null,
    dividendRate: g("dividendRate"),
    payoutRatio: g("payoutRatio") != null ? +(g("payoutRatio") * 100).toFixed(2) : null,
    exDividendDate: g("exDividendDate"),
    // Balance sheet
    totalCash: g("totalCash"),
    totalDebt: g("totalDebt"),
    debtToEquity: g("debtToEquity"),
    currentRatio: g("currentRatio"),
    bookValue: g("bookValue"),
    // Share stats
    sharesOutstanding: g("sharesOutstanding"),
    floatShares: g("floatShares"),
    shortRatio: g("shortRatio"),
    shortPercentOfFloat: g("shortPercentOfFloat") != null ? +(g("shortPercentOfFloat") * 100).toFixed(2) : null,
    beta: g("beta"),
    // Target & analyst
    targetMeanPrice: g("targetMeanPrice"),
    targetHighPrice: g("targetHighPrice"),
    targetLowPrice: g("targetLowPrice"),
    recommendationKey: g("recommendationKey"),
    numberOfAnalystOpinions: g("numberOfAnalystOpinions"),
  };
}

// ── Extended quote fetcher (requests all available modules) ──────────
async function yfQuoteFull(symbol: string): Promise<any> {
  await ensureYfAuth();
  if (!yfCookie || !yfCrumb) return null;
  try {
    // v10 quoteSummary gives us deep fundamental data
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,defaultKeyStatistics,financialData,summaryDetail&crumb=${encodeURIComponent(yfCrumb)}`;
    const res = await fetch(url, {
      headers: { ...YF_HEADERS, "Cookie": yfCookie },
    });
    if (!res.ok) {
      // Don't invalidate auth for v10-specific failures
      // (v7 might still work with same cookie/crumb)
      return null;
    }
    const data: any = await res.json();
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return null;
    // Flatten all modules into one object for easy extraction
    return {
      ...(r.assetProfile || {}),
      ...(r.defaultKeyStatistics || {}),
      ...(r.financialData || {}),
      ...(r.summaryDetail || {}),
    };
  } catch {
    return null;
  }
}

// Fallback: extract fundamentals from v7 quote data (limited but works reliably)
function extractFundamentalsFromQuote(q: any): any {
  if (!q) return null;
  const g = (key: string, fallback: any = null) => q[key] ?? fallback;
  return {
    sector: null,
    industry: null,
    longBusinessSummary: null,
    fullTimeEmployees: null,
    website: null,
    exchange: g("fullExchangeName") || g("exchange"),
    quoteType: g("quoteType"),
    marketCap: g("marketCap"),
    trailingPE: g("trailingPE"),
    forwardPE: g("forwardPE"),
    priceToBook: g("priceToBook"),
    priceToSalesTrailing12Months: null,
    enterpriseValue: null,
    enterpriseToRevenue: null,
    enterpriseToEbitda: null,
    profitMargins: null,
    operatingMargins: null,
    grossMargins: null,
    returnOnEquity: null,
    returnOnAssets: null,
    revenueGrowth: null,
    earningsGrowth: null,
    earningsQuarterlyGrowth: null,
    totalRevenue: null,
    revenuePerShare: null,
    trailingEps: g("trailingEps") || g("epsTrailingTwelveMonths"),
    forwardEps: g("epsForward"),
    dividendYield: g("trailingAnnualDividendYield") != null ? +(g("trailingAnnualDividendYield") * 100).toFixed(2) : null,
    dividendRate: g("trailingAnnualDividendRate"),
    payoutRatio: null,
    exDividendDate: g("dividendDate"),
    totalCash: null,
    totalDebt: null,
    debtToEquity: null,
    currentRatio: null,
    bookValue: g("bookValue"),
    sharesOutstanding: g("sharesOutstanding"),
    floatShares: null,
    shortRatio: null,
    shortPercentOfFloat: null,
    beta: null,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    recommendationKey: null,
    numberOfAnalystOpinions: null,
  };
}

// ── Helper to unwrap Yahoo's {raw, fmt} value objects ────────────────
function unwrapYahoo(obj: any): any {
  if (obj == null) return null;
  if (typeof obj !== "object") return obj;
  if ("raw" in obj) return obj.raw;
  if (Array.isArray(obj)) return obj.map(unwrapYahoo);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = unwrapYahoo(v);
  }
  return out;
}

async function handleStock(symbol: string): Promise<Response> {
  const sym = symbol.toUpperCase();
  const cacheKey = `stock:${sym}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return json(cached);

  try {
    const now = Math.floor(Date.now() / 1000);
    // Fetch max ~20 years of data for ALL time chart support
    const maxHistory = now - (20 * 365 * 24 * 60 * 60);

    // Fetch chart + v7 quote + v10 deep fundamentals in parallel
    const [chartData, quoteData, deepData] = await Promise.all([
      yfChart(sym, maxHistory, now, "1d"),
      yfQuote(sym),
      yfQuoteFull(sym),
    ]);



    const chartResult = chartData?.chart?.result?.[0];
    if (!chartResult) throw new Error("No data returned for symbol");

    const meta = chartResult.meta || {};
    const timestamps = chartResult.timestamp || [];
    const ohlcv = chartResult.indicators?.quote?.[0] || {};

    // Build OHLCV array
    const fullChart: any[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = ohlcv.close?.[i];
      const h = ohlcv.high?.[i];
      const l = ohlcv.low?.[i];
      const o = ohlcv.open?.[i];
      if (c != null && h != null && l != null && o != null) {
        const d = new Date(timestamps[i] * 1000);
        fullChart.push({
          date: d.toISOString().split("T")[0],
          open: o, high: h, low: l, close: c,
          volume: ohlcv.volume?.[i] || 0,
        });
      }
    }

    if (fullChart.length === 0) throw new Error("No valid price data");

    // Build quote
    const prevClose = quoteData?.regularMarketPreviousClose ?? (fullChart.length >= 2 ? fullChart[fullChart.length - 2].close : meta.chartPreviousClose);
    const curPrice = quoteData?.regularMarketPrice ?? meta.regularMarketPrice ?? fullChart[fullChart.length - 1].close;
    const quote: any = {
      symbol: meta.symbol || sym,
      shortName: quoteData?.shortName || meta.shortName || meta.longName || sym,
      regularMarketPrice: curPrice,
      previousClose: prevClose,
      regularMarketChange: prevClose ? curPrice - prevClose : null,
      regularMarketChangePercent: prevClose ? ((curPrice - prevClose) / prevClose) * 100 : null,
      marketCap: quoteData?.marketCap ?? null,
      trailingPE: quoteData?.trailingPE ?? null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      averageDailyVolume3Month: quoteData?.averageDailyVolume3Month ?? null,
      currency: meta.currency || "USD",
    };

    const closes = fullChart.map((c: any) => c.close as number);
    const highs = fullChart.map((c: any) => c.high as number);
    const lows = fullChart.map((c: any) => c.low as number);

    const sma50Full = computeSMA(closes, 50);
    const sma200Full = computeSMA(closes, 200);
    const rsiFull = computeRSI(closes, 14);
    const adxFull = computeADX(highs, lows, closes, 14);
    const atrFull = computeATR(highs, lows, closes, 14);

    // Send ALL chart data to frontend (let frontend slice by range)
    const chart = fullChart;
    const indicators = {
      sma50: sma50Full,
      sma200: sma200Full,
      rsi: rsiFull,
      adx: adxFull,
      atr: atrFull,
    };

    const lastIdx = fullChart.length - 1;
    const latest = {
      price: closes[lastIdx], sma50: sma50Full[lastIdx], sma200: sma200Full[lastIdx],
      rsi: rsiFull[lastIdx], adx: adxFull[lastIdx], atr: atrFull[lastIdx],
    };

    // Compute 52-week high/low from data if not in meta
    if (!quote.fiftyTwoWeekHigh || !quote.fiftyTwoWeekLow) {
      const yearData = fullChart.slice(-252);
      const yearHighs = yearData.map((d: any) => d.high);
      const yearLows = yearData.map((d: any) => d.low);
      if (!quote.fiftyTwoWeekHigh) quote.fiftyTwoWeekHigh = Math.max(...yearHighs);
      if (!quote.fiftyTwoWeekLow) quote.fiftyTwoWeekLow = Math.min(...yearLows);
    }

    // Compute avg volume from data
    const last63 = fullChart.slice(-63);
    if (last63.length > 0) {
      quote.averageDailyVolume3Month = Math.round(last63.reduce((s: number, d: any) => s + d.volume, 0) / last63.length);
    }

    const regime = classifyRegime(closes[lastIdx], sma50Full[lastIdx], sma200Full[lastIdx], rsiFull[lastIdx], adxFull[lastIdx]);
    const signal = classifySignal(regime);

    // Extract fundamentals from v10 deep data (with unwrapped Yahoo value objects)
    // Falls back to v7 quote data if v10 fails
    const unwrapped = unwrapYahoo(deepData);
    const fundamentals = extractFundamentals(unwrapped) || extractFundamentalsFromQuote(quoteData);

    const result = { quote, chart, indicators, latest, regime, signal, fundamentals };
    cacheSet(cacheKey, result);
    return json(result);
  } catch (err: any) {
    return json({ error: err.message || "Failed to fetch stock data" }, 500);
  }
}

async function handleNews(symbol: string): Promise<Response> {
  const sym = symbol.toUpperCase();
  const cacheKey = `news:${sym}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return json(cached);

  try {
    // Use search endpoint with newsCount to get news
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&lang=en-US&region=US&quotesCount=0&newsCount=5`;
    const res = await fetch(url, { headers: YF_HEADERS });
    if (!res.ok) throw new Error(`Yahoo news failed: ${res.status}`);
    const data: any = await res.json();

    const newsItems = (data.news || []).slice(0, 5);
    const headlines = newsItems.map((item: any) => ({
      title: item.title, publisher: item.publisher || "", link: item.link || "",
      score: scoreSentiment(item.title || ""),
    }));
    const scores = headlines.map((h: any) => h.score as number);
    const avgScore = scores.length > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
    let overall: "Bullish" | "Neutral" | "Bearish" = "Neutral";
    if (avgScore > 0.25) overall = "Bullish";
    else if (avgScore < -0.25) overall = "Bearish";
    const result = { headlines, overall, avgScore };
    cacheSet(cacheKey, result);
    return json(result);
  } catch (err: any) {
    return json({ error: err.message || "Failed to fetch news" }, 500);
  }
}

// ── Intraday chart handler (1D = 5min, 1W = 15min) ─────────────────

async function handleIntradayChart(symbol: string, reqUrl: URL): Promise<Response> {
  const sym = symbol.toUpperCase();
  const range = (reqUrl.searchParams.get("range") || "1D").toUpperCase();
  const cacheKey = `intraday:${sym}:${range}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return json(cached);

  try {
    const now = Math.floor(Date.now() / 1000);
    let period1: number;
    let interval: string;

    if (range === "1W") {
      period1 = now - 7 * 24 * 60 * 60;
      interval = "15m";
    } else {
      // 1D
      period1 = now - 2 * 24 * 60 * 60; // fetch 2 days to ensure we get a full trading day
      interval = "5m";
    }

    const chartData = await yfChart(sym, period1, now, interval);
    const chartResult = chartData?.chart?.result?.[0];
    if (!chartResult) throw new Error("No intraday data");

    const timestamps = chartResult.timestamp || [];
    const ohlcv = chartResult.indicators?.quote?.[0] || {};

    const points: any[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = ohlcv.close?.[i];
      if (c != null) {
        const d = new Date(timestamps[i] * 1000);
        points.push({
          date: d.toISOString(),
          close: c,
          volume: ohlcv.volume?.[i] || 0,
        });
      }
    }

    const result = { chart: points, range };
    cacheSet(cacheKey, result);
    return json(result);
  } catch (err: any) {
    return json({ error: err.message || "Failed to fetch intraday data" }, 500);
  }
}

// ── Vortex Radar — Smart suggestion engine ──────────────────────────
// Scans ~300 highly liquid US & UK stocks, runs full Vortex Logic on each.
// Surfaces Strong Bull, Weak Bull, Oversold, and Overbought setups.
// Cache is date-based: refreshes once per trading day.

// Date-based cache key — ensures one fresh scan per calendar day
function getRadarCacheDate(): string {
  // Use UTC date string as cache key
  return new Date().toISOString().split("T")[0];
}

let radarCache: { data: any; cacheDate: string } | null = null;
let radarScanInProgress = false;

const RADAR_UNIVERSE: string[] = [
  // ── US Stocks (~200) ────────────────────────────────────────────────
  // Mega-cap tech
  "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","AVGO","ORCL","ADBE",
  "CRM","CSCO","ACN","AMD","INTC","QCOM","TXN","INTU","NOW","IBM",
  "AMAT","ADI","LRCX","MU","KLAC","SNPS","CDNS","MRVL","PANW","CRWD",
  "FTNT","NXPI","MCHP","ON","SHOP","SQ","PLTR","NET","DDOG","ZS",
  // Finance
  "JPM","V","MA","BAC","WFC","GS","MS","AXP","BLK","SCHW",
  "C","USB","PNC","TFC","COF","BK","AIG","MET","PRU","ICE",
  // Healthcare
  "UNH","JNJ","LLY","PFE","ABBV","MRK","TMO","ABT","DHR","BMY",
  "AMGN","GILD","ISRG","MDT","SYK","VRTX","REGN","ZTS","BDX","EW",
  // Consumer
  "WMT","PG","KO","PEP","COST","MCD","NKE","SBUX","TGT","LOW",
  "HD","TJX","CMG","YUM","DG","DLTR","ROST","EL","CL","KMB",
  // Industrials
  "CAT","DE","HON","UNP","UPS","RTX","BA","LMT","GE","MMM",
  "GD","NOC","ITW","EMR","FDX","CSX","NSC","WM","ETN","PH",
  // Energy
  "XOM","CVX","COP","EOG","SLB","MPC","PSX","VLO","OXY","DVN",
  "HES","HAL","BKR","FANG","PXD",
  // Communication / Media
  "NFLX","DIS","CMCSA","T","VZ","TMUS","CHTR","EA","TTWO",
  // Real estate / Utilities / Materials
  "AMT","PLD","CCI","EQIX","SPG","NEE","DUK","SO","D","AEP",
  "LIN","APD","ECL","SHW","NEM","FCX","GOLD","DOW","DD","PPG",
  // ETFs (broad market pulse)
  "SPY","QQQ","IWM","DIA","XLF","XLE","XLK","XLV","XLI","XLP",
  // Additional high-volume names
  "UBER","ABNB","COIN","RIVN","LCID","SNAP","PINS","ROKU","HOOD","SOFI",
  "PYPL","BKNG","MELI","SE","GRAB","ARM","SMCI","DELL","HPQ","LULU",
  // ── FTSE 100 / FTSE 250 top-tier UK stocks (~100) ─────────────────
  "SHEL.L","AZN.L","HSBA.L","ULVR.L","DGE.L","RIO.L","GLEN.L","BP.L",
  "GSK.L","REL.L","LSEG.L","AAL.L","CRH.L","EXPN.L","RKT.L","BAE.L",
  "LLOY.L","NXT.L","PRU.L","ABF.L","BNZL.L","BDEV.L","BKG.L","BRBY.L",
  "AV.L","CCH.L","DCC.L","DPLM.L","FERG.L","FLTR.L","HLMA.L","HLN.L",
  "IMI.L","INF.L","ITRK.L","JD.L","LGEN.L","MNG.L","MNDI.L","NWG.L",
  "PHNX.L","PSN.L","RR.L","RTO.L","SBRY.L","SDR.L","SGE.L","SKG.L",
  "SMIN.L","SMT.L","SSE.L","STAN.L","SVT.L","TATE.L","VOD.L","WEIR.L",
  "WPP.L","WTB.L","ADM.L","AHT.L","ANTO.L","AUTO.L","DARK.L","ENT.L",
  "ESNT.L","GAW.L","HIK.L","HL.L","IMB.L","ITV.L","JMAT.L","KGF.L",
  "LAND.L","CMC.L","CRDA.L","EZJ.L","FOUR.L","MKS.L","TUI.L","WIZZ.L",
  "WOSG.L","III.L","BOY.L","FRAS.L","GRG.L","HWDN.L","JET.L","OCDO.L",
  "PSH.L","BEZ.L","SN.L","SPX.L","BME.L","EDVN.L","CNA.L","FCIT.L",
  "RMV.L","UU.L","BAB.L","SMDS.L","PSON.L","SJP.L",
];

interface RadarHit {
  symbol: string;
  name: string;
  price: number;
  change: number | null;
  changePercent: number | null;
  regime: string;
  rsi: number;
  adx: number;
  sma50: number;
  sma200: number;
}

// Lightweight chart fetch — needs ~260 days of data for 200 SMA
async function radarFetchChart(symbol: string): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  const lookback = now - 400 * 24 * 60 * 60; // ~400 days for 200 SMA warmup
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${lookback}&period2=${now}&interval=1d&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Analyze a single stock — returns a RadarHit if it qualifies, else null
function analyzeForRadar(chartData: any): RadarHit | null {
  const result = chartData?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const ohlcv = result.indicators?.quote?.[0] || {};

  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = ohlcv.close?.[i], h = ohlcv.high?.[i], l = ohlcv.low?.[i];
    if (c != null && h != null && l != null) {
      closes.push(c); highs.push(h); lows.push(l);
    }
  }
  if (closes.length < 210) return null; // need enough data for 200 SMA

  const sma50 = computeSMA(closes, 50);
  const sma200 = computeSMA(closes, 200);
  const rsi = computeRSI(closes, 14);
  const adx = computeADX(highs, lows, closes, 14);

  const last = closes.length - 1;
  const price = closes[last];
  const s50 = sma50[last];
  const s200 = sma200[last];
  const rsiVal = rsi[last];
  const adxVal = adx[last];

  if (s50 == null || s200 == null || rsiVal == null || adxVal == null) return null;

  const regime = classifyRegime(price, s50, s200, rsiVal, adxVal);

  // Radar only surfaces Strong Bull setups
  if (regime !== "Strong Bull") return null;

  // Calculate daily change from last two closes
  const prevClose = closes.length >= 2 ? closes[last - 1] : null;
  const change = prevClose != null ? price - prevClose : null;
  const changePercent = prevClose != null ? ((price - prevClose) / prevClose) * 100 : null;

  return {
    symbol: meta.symbol || "",
    name: meta.shortName || meta.longName || meta.symbol || "",
    price,
    change,
    changePercent,
    regime,
    rsi: rsiVal,
    adx: adxVal,
    sma50: s50,
    sma200: s200,
  };
}

// Scan in batches to avoid hammering Yahoo Finance
async function runRadarScan(): Promise<RadarHit[]> {
  const hits: RadarHit[] = [];
  const BATCH_SIZE = 10; // 10 concurrent fetches at a time

  for (let i = 0; i < RADAR_UNIVERSE.length; i += BATCH_SIZE) {
    const batch = RADAR_UNIVERSE.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(sym => radarFetchChart(sym))
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        const hit = analyzeForRadar(r.value);
        if (hit) hits.push(hit);
      }
    }
    // Small delay between batches to be respectful
    if (i + BATCH_SIZE < RADAR_UNIVERSE.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // Sort Strong Bulls by ADX (highest directional strength first)
  hits.sort((a, b) => b.adx - a.adx);

  return hits;
}

async function handleLiveRadar(): Promise<Response> {
  const today = getRadarCacheDate();

  // Return cached data if it's from today
  if (radarCache && radarCache.cacheDate === today) {
    return json(radarCache.data);
  }

  // If a scan is already running, return stale cache or scanning message
  if (radarScanInProgress) {
    if (radarCache) return json(radarCache.data);
    return json({ hits: [], scanning: true, lastUpdated: null });
  }

  // Trigger a fresh scan for today
  radarScanInProgress = true;
  try {
    const hits = await runRadarScan();
    const data = {
      hits,
      scanning: false,
      lastUpdated: new Date().toISOString(),
      totalScanned: RADAR_UNIVERSE.length,
    };
    radarCache = { data, cacheDate: today };
    return json(data);
  } catch (err: any) {
    // On error, return stale cache if available
    if (radarCache) return json(radarCache.data);
    return json({ error: err.message || "Radar scan failed", hits: [] }, 500);
  } finally {
    radarScanInProgress = false;
  }
}

// ── Worker fetch handler ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // ── Auth endpoint (always accessible) ─────────────────────────
    if (path === "/api/auth" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const passcode = body?.passcode || "";
        if (await verifyPasscode(passcode)) {
          const token = await createAuthToken();
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `vortex_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`,
            },
          });
        }
        return json({ ok: false, error: "Invalid passcode" }, 401);
      } catch {
        return json({ ok: false, error: "Bad request" }, 400);
      }
    }

    // ── Auth check endpoint (for frontend to verify session) ──────
    if (path === "/api/auth/check") {
      const token = getAuthCookie(request);
      if (token && await verifyAuthToken(token)) {
        return json({ authenticated: true });
      }
      return json({ authenticated: false }, 401);
    }

    // ── Logout endpoint ───────────────────────────────────────────
    if (path === "/api/auth/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `vortex_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        },
      });
    }

    // ── Protect all other API routes behind auth ──────────────────
    if (path.startsWith("/api/")) {
      const token = getAuthCookie(request);
      if (!token || !(await verifyAuthToken(token))) {
        return json({ error: "Unauthorized" }, 401);
      }
    }

    // API routes (authenticated)
    if (path === "/api/search") {
      return handleSearch(url);
    }

    const stockMatch = path.match(/^\/api\/stock\/([^/]+)$/);
    if (stockMatch) {
      return handleStock(stockMatch[1]);
    }

    const newsMatch = path.match(/^\/api\/news\/([^/]+)$/);
    if (newsMatch) {
      return handleNews(newsMatch[1]);
    }

    const intradayMatch = path.match(/^\/api\/chart\/([^/]+)$/);
    if (intradayMatch) {
      return handleIntradayChart(intradayMatch[1], url);
    }

    if (path === "/api/live-radar") {
      return handleLiveRadar();
    }

    // Static assets always served (lock screen is client-side)
    return env.ASSETS.fetch(request);
  },
};
