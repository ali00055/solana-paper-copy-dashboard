import http from "node:http";
import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8787);
const CHAT_FILE = "codex-mobile-chat.json";
let freeAlphaScanInFlight = null;
let stateCache = { at: 0, value: null, promise: null };
let oracleCache = { at: 0, llama: null };
let oracleDiscoveryCache = { at: 0, value: null };
let socialRadarCache = { at: 0, value: null };
let nansenSmartCache = { at: 0, value: null };
let trendMapCache = { at: 0, value: null };

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function readText(file, fallback = "") {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return fallback;
  }
}

async function readTailText(file, maxBytes = 1024 * 1024) {
  try {
    const stat = await fs.stat(file);
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString("utf8");
      if (start > 0) {
        const firstBreak = text.indexOf("\n");
        text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
      }
      return text;
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function publicConfig(config) {
  const copy = JSON.parse(JSON.stringify(config || {}));
  for (const key of ["heliusApiKey", "nansenApiKey", "gmgnApiKey", "cieloApiKey", "birdeyeApiKey", "definedApiKey", "geyserAuthToken"]) {
    if (copy[key]) copy[key] = "********";
  }
  if (copy.gmgn?.apiKey) copy.gmgn.apiKey = "********";
  if (copy.gmgn?.privateKeyPem) copy.gmgn.privateKeyPem = "********";
  if (copy.telegram?.botToken) copy.telegram.botToken = "********";
  if (copy.telegram?.chatId) copy.telegram.chatId = "********";
  return copy;
}

async function readChatMessages() {
  const data = await readJson(CHAT_FILE, { messages: [] });
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return messages.slice(-200);
}

async function appendChatMessage({ role = "user", text = "" } = {}) {
  const cleanText = String(text || "").trim().slice(0, 4000);
  if (!cleanText) throw new Error("mesaj bos");
  const messages = await readChatMessages();
  const message = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: role === "assistant" ? "assistant" : "user",
    text: cleanText,
    at: new Date().toISOString()
  };
  messages.push(message);
  await writeJson(CHAT_FILE, { updatedAt: message.at, messages: messages.slice(-200) });
  return message;
}

function toFiniteNumber(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function eventDedupKey(event) {
  if (!event?.signature) return null;
  const paperKind = event.paper?.position
    ? "paper-buy"
    : event.paper?.pnlTry !== undefined
      ? "paper-sell"
      : event.paper?.skipped
        ? `skip:${event.paper.skipped}`
        : "signal";
  return [event.signature, event.wallet || "", event.type || "", event.mint || "", paperKind].join("|");
}

async function readEvents(limit = 80) {
  const maxBytes = Math.min(8 * 1024 * 1024, Math.max(512 * 1024, limit * 1800));
  const text = await readTailText("paper-events.ndjson", maxBytes);
  const parsed = text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
  const seen = new Set();
  const deduped = [];
  for (const event of parsed) {
    const key = eventDedupKey(event);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(event);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function parseJsonBuffer(buffer, fallback = null) {
  for (const encoding of ["utf8", "utf16le"]) {
    try {
      return JSON.parse(buffer.toString(encoding).replace(/^\uFEFF/, ""));
    } catch {}
  }
  return fallback;
}

async function readJsonAnyEncoding(file, fallback = null) {
  try {
    return parseJsonBuffer(await fs.readFile(file), fallback);
  } catch {
    return fallback;
  }
}

async function solanaRpc(config, method, params, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.rpcHttp || "https://solana-rpc.publicnode.com", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function heliusKey(config) {
  return process.env.HELIUS_API_KEY || config.heliusApiKey || "";
}

function cieloKey(config) {
  return process.env.CIELO_API_KEY || config.cieloApiKey || "";
}

function birdeyeKey(config) {
  return process.env.BIRDEYE_API_KEY || config.birdeyeApiKey || "";
}

function definedKey(config) {
  return process.env.DEFINED_API_KEY || config.definedApiKey || "";
}

function nansenKey(config) {
  return process.env.NANSEN_API_KEY || config.nansenApiKey || "";
}

function xBearerToken(config) {
  return process.env.X_BEARER_TOKEN || config.xBearerToken || config.socialRadar?.xBearerToken || "";
}

function gmgnLocalNodePath() {
  return "tools\\node-portable\\node-v24.15.0-win-x64\\node.exe";
}

function gmgnCliScriptPath() {
  return "tools\\gmgn-cli-runtime\\node_modules\\gmgn-cli\\dist\\index.js";
}

function gmgnConfigPath() {
  return `${process.env.USERPROFILE || ""}\\.config\\gmgn\\.env`;
}

function parseDotEnv(text = "") {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function maskSecret(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 10) return "********";
  return `${text.slice(0, 5)}...${text.slice(-4)}`;
}

async function gmgnEnvFile() {
  const text = await readText(gmgnConfigPath(), "");
  return parseDotEnv(text);
}

function escapeEnvMultiline(value = "") {
  return String(value || "").replace(/\r?\n/g, "\\n");
}

async function gmgnWriteEnv(apiKey, privateKeyPem = "") {
  const dir = `${process.env.USERPROFILE || ""}\\.config\\gmgn`;
  await fs.mkdir(dir, { recursive: true });
  const lines = [`GMGN_API_KEY=${String(apiKey || "").trim()}`];
  if (privateKeyPem) lines.push(`GMGN_PRIVATE_KEY="${escapeEnvMultiline(privateKeyPem)}"`);
  await fs.writeFile(gmgnConfigPath(), `${lines.join("\n")}\n`, "utf8");
}

async function gmgnCliReady() {
  try {
    await fs.stat(gmgnCliScriptPath());
    return true;
  } catch {
    return false;
  }
}

async function runGmgnCli(args = [], timeoutMs = 45000) {
  let nodePath = process.execPath;
  try {
    await fs.stat(gmgnLocalNodePath());
    nodePath = gmgnLocalNodePath();
  } catch {
    nodePath = process.execPath;
  }
  const env = {
    ...process.env,
    PATH: `tools\\node-portable\\node-v24.15.0-win-x64;tools\\git-portable\\mingit\\cmd;${process.env.PATH || ""}`,
    GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS || "1500"
  };
  const { stdout, stderr } = await execFileAsync(nodePath, [gmgnCliScriptPath(), ...args], {
    env,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  return { stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() };
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function solAddr(value = "") {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || "").trim());
}

function gmgnShort(value = "") {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

async function looksLikeGmgnPublicKey(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/BEGIN PUBLIC KEY|END PUBLIC KEY|ssh-ed25519/i.test(text)) return true;
  const publicPem = await readText("gmgn-public-key.txt", "");
  const publicBody = publicPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "")
    .trim();
  return Boolean(publicBody && text.replace(/\s+/g, "") === publicBody) || /^MCowBQYDK2Vw/i.test(text);
}

async function apiGmgnStatus() {
  const envFile = await gmgnEnvFile();
  const cliReady = await gmgnCliReady();
  const privateKeyPresent = Boolean(envFile.GMGN_PRIVATE_KEY);
  const apiKeyPresent = Boolean(envFile.GMGN_API_KEY);
  const apiLooksPublic = await looksLikeGmgnPublicKey(envFile.GMGN_API_KEY);
  let test = { ok: false, skipped: true, message: apiKeyPresent ? "Test edilmedi." : "GMGN API key yok." };
  if (apiLooksPublic) {
    test = { ok: false, skipped: true, message: "API key alanina public key kaydedilmis. GMGN'in olusturdugu API key gerekli." };
  } else if (cliReady && apiKeyPresent) {
    try {
      const { stdout } = await runGmgnCli(["market", "trending", "--chain", "sol", "--interval", "1h", "--limit", "1", "--raw"], 30000);
      const parsed = safeJsonParse(stdout, null);
      test = { ok: true, skipped: false, message: "GMGN API baglantisi calisiyor.", sampleType: Array.isArray(parsed) ? "array" : typeof parsed };
    } catch (error) {
      test = { ok: false, skipped: false, message: String(error?.stderr || error?.message || error).slice(0, 500) };
    }
  }
  return {
    ok: cliReady && apiKeyPresent && test.ok,
    cliReady,
    apiKeyPresent,
    apiKeyMasked: maskSecret(envFile.GMGN_API_KEY),
    apiLooksPublic,
    privateKeyPresent,
    envPath: gmgnConfigPath(),
    publicKeyPem: await readText("gmgn-public-key.txt", ""),
    test
  };
}

async function apiGmgnSetup(body = {}) {
  const apiKey = String(body.apiKey || "").trim();
  if (!apiKey || apiKey.length < 8) throw new Error("GMGN API key eksik veya cok kisa.");
  if (await looksLikeGmgnPublicKey(apiKey)) {
    throw new Error("Bu public key. Buraya GMGN'in olusturdugu API key yapistirilmali.");
  }
  let privateKeyPem = "";
  if (body.includePrivateKey !== false) {
    privateKeyPem = await readText("secrets\\binance-official\\id_ed25519", "");
  }
  await gmgnWriteEnv(apiKey, privateKeyPem);
  return apiGmgnStatus();
}

function normalizeGmgnList(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.list)) return raw.list;
  if (Array.isArray(raw?.data?.list)) return raw.data.list;
  if (Array.isArray(raw?.data?.rank)) return raw.data.rank;
  if (Array.isArray(raw?.rank)) return raw.rank;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function gmgnTradeRow(item = {}, source = "smartmoney") {
  const token = item.base_token || item.token || {};
  const info = item.maker_info || {};
  return {
    source,
    maker: item.maker || info.address || "",
    makerName: info.name || info.twitter_username || info.twitter_name || "",
    side: item.side || "",
    token: token.symbol || item.symbol || gmgnShort(item.base_address || item.token_address),
    address: item.base_address || item.token_address || token.address || "",
    amountUsd: Number(item.amount_usd || item.cost_usd || 0),
    priceUsd: Number(item.price_usd || 0),
    priceNow: Number(item.price_now || 0),
    priceChange: Number(item.price_change || 0),
    timestamp: Number(item.timestamp || item.trigger_at || 0),
    openClose: item.is_open_or_close,
    tags: info.tags || item.tags || [],
    tx: item.transaction_hash || item.tx_hash || ""
  };
}

function gmgnClusterRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.address) continue;
    const key = `${row.address}:${row.side || ""}`;
    const group = grouped.get(key) || { address: row.address, token: row.token, side: row.side, makers: new Set(), amountUsd: 0, sources: new Set(), rows: [] };
    if (row.maker) group.makers.add(row.maker);
    group.amountUsd += Number(row.amountUsd || 0);
    group.sources.add(row.source);
    group.rows.push(row);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => ({
      address: group.address,
      token: group.token,
      side: group.side,
      makers: group.makers.size,
      amountUsd: group.amountUsd,
      sources: [...group.sources],
      strength: group.makers.size >= 3 && group.sources.has("smartmoney") ? "GUCLU" : group.makers.size >= 2 ? "ORTA" : "ZAYIF"
    }))
    .filter((group) => group.makers >= 2)
    .sort((a, b) => b.makers - a.makers || b.amountUsd - a.amountUsd)
    .slice(0, 12);
}

async function apiGmgnTrack(force = false) {
  const status = await apiGmgnStatus();
  if (!status.apiKeyPresent || !status.cliReady) return { ok: false, status, trades: [], clusters: [], error: status.test?.message || "GMGN hazir degil." };
  const calls = [
    runGmgnCli(["track", "smartmoney", "--chain", "sol", "--limit", "80", "--raw"], 45000).then((res) => ({ source: "smartmoney", raw: safeJsonParse(res.stdout, {}) })),
    runGmgnCli(["track", "kol", "--chain", "sol", "--limit", "60", "--raw"], 45000).then((res) => ({ source: "kol", raw: safeJsonParse(res.stdout, {}) }))
  ];
  const settled = await Promise.allSettled(calls);
  const errors = [];
  const trades = [];
  for (const item of settled) {
    if (item.status === "rejected") {
      errors.push(String(item.reason?.stderr || item.reason?.message || item.reason).slice(0, 400));
      continue;
    }
    trades.push(...normalizeGmgnList(item.value.raw).map((row) => gmgnTradeRow(row, item.value.source)));
  }
  trades.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return {
    ok: trades.length > 0,
    status,
    trades: trades.slice(0, 80),
    clusters: gmgnClusterRows(trades),
    errors
  };
}

function gmgnTokenQuality(item = {}) {
  const smart = Number(item.smart_degen_count ?? item.wallet_tags_stat?.smart_wallets ?? 0);
  const kol = Number(item.renowned_count ?? item.wallet_tags_stat?.renowned_wallets ?? 0);
  const rug = Number(item.rug_ratio ?? item.stat?.rug_ratio ?? 0);
  const wash = Boolean(item.is_wash_trading);
  const liquidity = Number(item.liquidity || item.pool?.liquidity || 0);
  const volume = Number(item.volume || item.volume_1h || item.price?.volume_1h || 0);
  let score = 45 + Math.min(25, smart * 6) + Math.min(12, kol * 4);
  if (liquidity >= 50000) score += 8;
  if (volume >= 100000) score += 8;
  if (rug > 0.3) score -= 35;
  if (wash) score -= 25;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function gmgnMarketRow(item = {}, source = "trending") {
  const score = gmgnTokenQuality(item);
  return {
    source,
    address: item.address || item.token_address || "",
    symbol: item.symbol || item.name || "-",
    name: item.name || "",
    marketCap: Number(item.market_cap || item.usd_market_cap || 0),
    liquidity: Number(item.liquidity || 0),
    volume: Number(item.volume || item.volume_1h || item.volume_24h || 0),
    priceChange1h: Number(item.price_change_percent1h || item.price_change_percent || 0),
    smartDegens: Number(item.smart_degen_count || 0),
    renowned: Number(item.renowned_count || 0),
    holders: Number(item.holder_count || 0),
    platform: item.launchpad_platform || item.exchange || item.launchpad || "",
    rugRatio: Number(item.rug_ratio || 0),
    washTrading: Boolean(item.is_wash_trading),
    score,
    verdict: score >= 75 ? "SCOUT" : score >= 58 ? "IZLE" : "ELE"
  };
}

async function apiGmgnMarket() {
  const status = await apiGmgnStatus();
  if (!status.apiKeyPresent || !status.cliReady) return { ok: false, status, rows: [], errors: [status.test?.message || "GMGN hazir degil."] };
  const calls = [
    runGmgnCli(["market", "trending", "--chain", "sol", "--interval", "5m", "--order-by", "volume", "--limit", "40", "--raw"], 45000).then((res) => ({ source: "trend5m", raw: safeJsonParse(res.stdout, {}) })),
    runGmgnCli(["market", "signal", "--chain", "sol", "--groups", '[{"signal_type":[12]},{"signal_type":[6,7]}]', "--raw"], 45000).then((res) => ({ source: "signals", raw: safeJsonParse(res.stdout, {}) })),
    runGmgnCli(["market", "trenches", "--chain", "sol", "--type", "new_creation", "--type", "near_completion", "--filter-preset", "smart-money", "--limit", "40", "--raw"], 45000).then((res) => ({ source: "trenches", raw: safeJsonParse(res.stdout, {}) }))
  ];
  const settled = await Promise.allSettled(calls);
  const rows = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === "rejected") {
      errors.push(String(item.reason?.stderr || item.reason?.message || item.reason).slice(0, 400));
      continue;
    }
    rows.push(...normalizeGmgnList(item.value.raw).map((row) => gmgnMarketRow(row, item.value.source)));
  }
  const byAddress = new Map();
  for (const row of rows) {
    const key = row.address || `${row.source}:${row.symbol}`;
    const current = byAddress.get(key);
    if (!current || row.score > current.score) byAddress.set(key, row);
  }
  return { ok: byAddress.size > 0, status, rows: [...byAddress.values()].sort((a, b) => b.score - a.score).slice(0, 60), errors };
}

async function apiGmgnToken(address = "") {
  const status = await apiGmgnStatus();
  const mint = String(address || "").trim();
  if (!solAddr(mint)) return { ok: false, status, error: "Gecerli Solana token adresi gir." };
  if (!status.apiKeyPresent || !status.cliReady) return { ok: false, status, error: status.test?.message || "GMGN hazir degil." };
  const calls = [
    runGmgnCli(["token", "info", "--chain", "sol", "--address", mint, "--raw"], 30000).then((res) => ({ key: "info", raw: safeJsonParse(res.stdout, {}) })),
    runGmgnCli(["token", "security", "--chain", "sol", "--address", mint, "--raw"], 30000).then((res) => ({ key: "security", raw: safeJsonParse(res.stdout, {}) })),
    runGmgnCli(["token", "traders", "--chain", "sol", "--address", mint, "--tag", "smart_degen", "--order-by", "profit", "--direction", "desc", "--limit", "20", "--raw"], 45000).then((res) => ({ key: "smartTraders", raw: safeJsonParse(res.stdout, {}) }))
  ];
  const settled = await Promise.allSettled(calls);
  const result = { ok: true, status, address: mint, info: null, security: null, smartTraders: [], errors: [] };
  for (const item of settled) {
    if (item.status === "rejected") {
      result.errors.push(String(item.reason?.stderr || item.reason?.message || item.reason).slice(0, 400));
      continue;
    }
    if (item.value.key === "smartTraders") result.smartTraders = normalizeGmgnList(item.value.raw).slice(0, 20);
    else result[item.value.key] = item.value.raw;
  }
  return result;
}

async function heliusRpc(config, method, params) {
  const key = heliusKey(config);
  if (!key) return null;
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "research", method, params })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function heliusEnhancedTransactions(config, signatures) {
  const key = heliusKey(config);
  if (!key || !signatures?.length) return [];
  const response = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: signatures.slice(0, 20) })
  });
  if (!response.ok) return [];
  return await response.json().catch(() => []);
}

async function nansenPost(config, path, body) {
  const key = nansenKey(config);
  if (!key) return { enabled: false, data: null, error: null };
  const response = await fetch(`https://api.nansen.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": key
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    return { enabled: true, data: null, error: `${response.status} ${response.statusText}: ${typeof data === "string" ? data.slice(0, 220) : JSON.stringify(data).slice(0, 220)}` };
  }
  return { enabled: true, data, error: null };
}

function normalizeNansenLabels(payload) {
  const candidates = [
    payload?.data,
    payload?.data?.labels,
    payload?.labels,
    payload?.results,
    payload?.result,
    Array.isArray(payload) ? payload : null
  ].filter(Boolean);
  const list = candidates.find(Array.isArray) || [];
  return list.map((item) => ({
    label: item.label || item.name || item.display_name || item.displayName || item.category || JSON.stringify(item).slice(0, 80),
    category: item.category || item.label_type || item.type || item.group || "-",
    confidence: item.confidence || item.score || null
  })).slice(0, 40);
}

async function nansenAddressProfile(config, address, chain = "solana") {
  if (!nansenKey(config)) return { enabled: false, labels: [], premiumLabels: [], error: null };
  const body = {
    address,
    chain,
    pagination: { page: 1, per_page: 100 }
  };
  const [labels, premium] = await Promise.all([
    nansenPost(config, "/api/v1/profiler/address/labels", body),
    nansenPost(config, "/api/v1/profiler/address/premium-labels", body)
  ]);
  return {
    enabled: true,
    labels: normalizeNansenLabels(labels.data),
    premiumLabels: normalizeNansenLabels(premium.data),
    error: labels.error || premium.error || null
  };
}

function nansenRows(payload) {
  const candidates = [
    payload?.data,
    payload?.data?.rows,
    payload?.data?.items,
    payload?.rows,
    payload?.results,
    payload?.result,
    Array.isArray(payload) ? payload : null
  ].filter(Boolean);
  return candidates.find(Array.isArray) || [];
}

function firstValue(item, keys, fallback = null) {
  for (const key of keys) {
    if (item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== "") return item[key];
  }
  return fallback;
}

function normalizeNansenSmartTrade(item = {}) {
  const trader = String(firstValue(item, ["trader_address", "address", "wallet", "maker", "signer"], "") || "");
  const boughtMint = String(firstValue(item, ["token_bought_address", "bought_token_address", "token_in_address", "to_token_address", "token_address"], "") || "");
  const soldMint = String(firstValue(item, ["token_sold_address", "sold_token_address", "token_out_address", "from_token_address"], "") || "");
  const boughtSymbol = String(firstValue(item, ["token_bought_symbol", "bought_token_symbol", "token_in_symbol", "to_token_symbol", "symbol"], "") || "");
  const soldSymbol = String(firstValue(item, ["token_sold_symbol", "sold_token_symbol", "token_out_symbol", "from_token_symbol"], "") || "");
  const boughtAmount = Number(firstValue(item, ["token_bought_amount", "bought_token_amount", "amount_bought"], 0) || 0);
  const soldAmount = Number(firstValue(item, ["token_sold_amount", "sold_token_amount", "amount_sold"], 0) || 0);
  let amountUsd = Number(firstValue(item, ["amount_usd", "value_usd", "volume_usd", "trade_value_usd", "token_bought_amount_usd", "usd_value"], 0) || 0);
  let amountSol = Number(firstValue(item, ["amount_sol", "value_sol", "sol_value"], 0) || 0);
  if (!amountSol && ["SOL", "WSOL", "JITOSOL"].includes(soldSymbol.toUpperCase())) amountSol = soldAmount;
  if (!amountUsd && ["USDC", "USDT"].includes(soldSymbol.toUpperCase())) amountUsd = soldAmount;
  if (!amountUsd && amountSol) amountUsd = amountSol * 180;
  const rawAt = firstValue(item, ["block_timestamp", "timestamp", "time", "datetime"], null);
  const at = rawAt ? new Date(rawAt).toISOString() : null;
  const labelRaw = firstValue(item, ["trader_address_label", "trader_label", "address_label", "label"], "");
  const labels = Array.isArray(labelRaw) ? labelRaw.map(String) : String(labelRaw || "").split(/[,|]/).map((part) => part.trim()).filter(Boolean);
  const hash = String(firstValue(item, ["transaction_hash", "tx_hash", "signature", "hash"], "") || "");
  return {
    trader,
    labels,
    boughtMint,
    boughtSymbol,
    soldMint,
    soldSymbol,
    amountUsd,
    amountSol,
    at,
    hash,
    raw: item
  };
}

function isBaseAsset(symbolOrMint = "") {
  const value = String(symbolOrMint || "").toUpperCase();
  return ["SOL", "WSOL", "USDC", "USDT", "BONK", "JITOSOL"].includes(value);
}

function smartLabelScore(labels = []) {
  const text = labels.join(" ").toLowerCase();
  let score = 12;
  if (/smart|fund|whale|fresh wallet|dex trader|early|pro/i.test(text)) score += 20;
  if (/sniper|mev|bot/i.test(text)) score += 8;
  if (/exchange|cex|bridge|deposit|withdraw/i.test(text)) score -= 24;
  return score;
}

async function apiNansenSmart(force = false) {
  if (!force && nansenSmartCache.value && Date.now() - nansenSmartCache.at < 45 * 1000) return nansenSmartCache.value;
  const config = await readJson("config.json", {});
  if (!nansenKey(config)) {
    return { ok: false, enabled: false, error: "Nansen API key yok.", wallets: [], tokens: [], trades: [] };
  }

  const body = {
    chains: ["solana"],
    pagination: { page: 1, per_page: 100 },
    order_by: [{ field: "block_timestamp", direction: "DESC" }]
  };
  const response = await nansenPost(config, "/api/v1/smart-money/dex-trades", body);
  if (response.error) {
    const result = { ok: false, enabled: true, error: response.error, wallets: [], tokens: [], trades: [], sources: ["Nansen Smart Money DEX Trades"] };
    nansenSmartCache = { at: Date.now(), value: result };
    return result;
  }

  const trades = nansenRows(response.data)
    .map(normalizeNansenSmartTrade)
    .filter((trade) => trade.trader && trade.boughtMint && !isBaseAsset(trade.boughtSymbol || trade.boughtMint))
    .slice(0, 100);

  const walletMap = new Map();
  const tokenMap = new Map();
  for (const trade of trades) {
    const minutesAgo = trade.at ? Math.max(0, (Date.now() - new Date(trade.at).getTime()) / 60000) : 9999;
    const freshness = minutesAgo <= 10 ? 18 : minutesAgo <= 60 ? 12 : minutesAgo <= 360 ? 6 : 0;
    const sizeScore = trade.amountUsd >= 25000 ? 18 : trade.amountUsd >= 5000 ? 12 : trade.amountUsd >= 1000 ? 7 : trade.amountSol >= 5 ? 10 : trade.amountSol >= 1 ? 5 : 0;
    const labelScore = smartLabelScore(trade.labels);

    const wallet = walletMap.get(trade.trader) || {
      address: trade.trader,
      labels: new Set(),
      buyCount: 0,
      uniqueTokens: new Set(),
      amountUsd: 0,
      amountSol: 0,
      lastAt: trade.at,
      sampleTokens: []
    };
    trade.labels.forEach((label) => wallet.labels.add(label));
    wallet.buyCount += 1;
    wallet.uniqueTokens.add(trade.boughtMint);
    wallet.amountUsd += trade.amountUsd || 0;
    wallet.amountSol += trade.amountSol || 0;
    if (trade.at && (!wallet.lastAt || new Date(trade.at) > new Date(wallet.lastAt))) wallet.lastAt = trade.at;
    if (wallet.sampleTokens.length < 5) wallet.sampleTokens.push(trade.boughtSymbol || trade.boughtMint.slice(0, 6));
    walletMap.set(trade.trader, wallet);

    const token = tokenMap.get(trade.boughtMint) || {
      mint: trade.boughtMint,
      symbol: trade.boughtSymbol || trade.boughtMint.slice(0, 6),
      buyers: new Set(),
      labels: new Set(),
      buyCount: 0,
      amountUsd: 0,
      amountSol: 0,
      lastAt: trade.at,
      maxTradeUsd: 0,
      baseScore: 0
    };
    token.buyCount += 1;
    token.buyers.add(trade.trader);
    trade.labels.forEach((label) => token.labels.add(label));
    token.amountUsd += trade.amountUsd || 0;
    token.amountSol += trade.amountSol || 0;
    token.maxTradeUsd = Math.max(token.maxTradeUsd, trade.amountUsd || 0);
    token.baseScore += freshness + sizeScore + Math.max(0, labelScore / 4);
    if (trade.at && (!token.lastAt || new Date(trade.at) > new Date(token.lastAt))) token.lastAt = trade.at;
    tokenMap.set(trade.boughtMint, token);
  }

  const wallets = [...walletMap.values()].map((wallet) => {
    const labelList = [...wallet.labels].slice(0, 8);
    const score = clamp(
      smartLabelScore(labelList) +
      Math.min(22, wallet.buyCount * 5) +
      Math.min(18, wallet.uniqueTokens.size * 4) +
      (wallet.amountUsd >= 25000 ? 22 : wallet.amountUsd >= 5000 ? 14 : wallet.amountUsd >= 1000 ? 8 : wallet.amountSol >= 5 ? 10 : 0)
    );
    return {
      ...wallet,
      labels: labelList,
      uniqueTokens: wallet.uniqueTokens.size,
      score: Number(score.toFixed(1)),
      grade: edgeGrade(score),
      mode: score >= 82 ? "premium-alert" : score >= 70 ? "watch" : "izle",
      url: gmgnWalletUrl(wallet.address)
    };
  }).sort((a, b) => b.score - a.score).slice(0, 25);

  const tokens = [...tokenMap.values()].map((token) => {
    const labelList = [...token.labels].slice(0, 8);
    const buyerCount = token.buyers.size;
    const score = clamp(
      token.baseScore / Math.max(1, token.buyCount) +
      Math.min(30, buyerCount * 12) +
      Math.min(18, token.buyCount * 4) +
      (token.amountUsd >= 50000 ? 18 : token.amountUsd >= 10000 ? 12 : token.amountUsd >= 2500 ? 7 : 0)
    );
    return {
      mint: token.mint,
      symbol: token.symbol,
      labels: labelList,
      buyers: buyerCount,
      buyCount: token.buyCount,
      amountUsd: token.amountUsd,
      amountSol: token.amountSol,
      maxTradeUsd: token.maxTradeUsd,
      lastAt: token.lastAt,
      score: Number(score.toFixed(1)),
      grade: edgeGrade(score),
      mode: score >= 82 ? "premium-token" : score >= 68 ? "watch-hot" : "izle",
      url: `https://dexscreener.com/solana/${token.mint}`
    };
  }).sort((a, b) => b.score - a.score).slice(0, 30);

  const result = {
    ok: true,
    enabled: true,
    now: new Date().toISOString(),
    wallets,
    tokens,
    trades: trades.slice(0, 50),
    counts: { trades: trades.length, wallets: wallets.length, tokens: tokens.length },
    sources: ["Nansen Smart Money DEX Trades"]
  };
  nansenSmartCache = { at: Date.now(), value: result };
  return result;
}

function pidFile(script) {
  return `${script.replace(/\.mjs$/i, "")}.pid`;
}

async function readPid(script) {
  try {
    const pid = Number((await fs.readFile(pidFile(script), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readBotLockPid() {
  try {
    const lock = JSON.parse(await fs.readFile("bot-runtime.lock", "utf8"));
    const pid = Number(lock?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function writePid(script, pid) {
  await fs.writeFile(pidFile(script), `${pid}`, "utf8");
}

async function removePid(script) {
  await fs.rm(pidFile(script), { force: true }).catch(() => {});
}

function isRunningPid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listBotProcessIds() {
  if (process.platform !== "win32") {
    const ids = [await readPid("bot.mjs"), await readBotLockPid()]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return [...new Set(ids)].filter((pid) => isRunningPid(pid));
  }
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '(^| )bot\\.mjs( |$)' } | ForEach-Object { $_.ProcessId }"
    ], { windowsHide: true, timeout: 8000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    const ids = [await readPid("bot.mjs"), await readBotLockPid()]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return [...new Set(ids)].filter((pid) => isRunningPid(pid));
  }
}

async function getBotStatus() {
  const pid = await readPid("bot.mjs");
  const processIds = await listBotProcessIds();
  if (!processIds.length) {
    if (pid) await removePid("bot.mjs");
    return { running: false, processes: [] };
  }
  const preferred = processIds.includes(pid) ? pid : processIds[0];
  if (preferred !== pid) await writePid("bot.mjs", preferred);
  return {
    running: true,
    processes: processIds.map((ProcessId) => ({ ProcessId, CommandLine: `${process.execPath} bot.mjs` }))
  };
}

async function stopBotProcess() {
  const pids = await listBotProcessIds();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const pid of pids) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (isRunningPid(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await removePid("bot.mjs");
  await new Promise((resolve) => setTimeout(resolve, 500));
  return await getBotStatus();
}

async function startBotProcess() {
  const status = await getBotStatus();
  if (status.running) return status;

  const out = await fs.open("bot.out.log", "a");
  const err = await fs.open("bot.err.log", "a");
  const child = spawn(process.execPath, ["bot.mjs"], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out.fd, err.fd]
  });
  child.unref();
  await writePid("bot.mjs", child.pid);
  await out.close().catch(() => {});
  await err.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return await getBotStatus();
}

async function restartBotProcess() {
  await stopBotProcess();
  return await startBotProcess();
}

function queueBotRestart(reason = "config change") {
  setTimeout(() => {
    restartBotProcess().catch((error) => {
      console.error(`[control restart:${reason}]`, error?.message || String(error));
    });
  }, 50);
}

const CONTROL_SETTING_FIELDS = {
  startingTry: "number",
  normalTradeTry: "number",
  highConfidenceTradeTry: "number",
  maxOpenPositions: "integer",
  maxCoreOpenPositions: "integer",
  maxMoonshotOpenPositions: "integer",
  maxOpenPerWallet: "integer",
  walletCooldownSec: "integer",
  tokenCooldownMin: "integer",
  walletSignalWindowSec: "integer",
  maxWalletBuySignalsPerMinute: "integer",
  maxAutoRelatedPerWallet: "integer",
  maxBuyMarketCapUsd: "nullableNumber",
  minLiquidityUsd: "nullableNumber",
  minVolume24hUsd: "nullableNumber",
  strongLiquidityUsd: "nullableNumber",
  strongVolume24hUsd: "nullableNumber",
  minPairAgeSec: "integer",
  maxPairAgeHours: "nullableNumber",
  minTxns5m: "integer",
  rejectNoLiquidity: "boolean",
  authorityRiskGate: "boolean",
  rejectMintAuthority: "boolean",
  rejectFreezeAuthority: "boolean",
  maxTopHolderPct: "nullableNumber",
  maxTop10HolderPct: "nullableNumber",
  rejectPaidDexOrders: "boolean",
  requireMultiWalletConfirm: "boolean",
  confirmMinWallets: "integer",
  confirmWindowMin: "integer",
  singleWalletScoutMode: "boolean",
  singleWalletScoutMinScore: "number",
  singleWalletScoutTradeTry: "number",
  dynamicLotSizing: "boolean",
  dynamicMinTradeTry: "number",
  dynamicMaxTradeTry: "number",
  dynamicMaxMultiplier: "number",
  sourceSizeGateEnabled: "boolean",
  minSourceBuySol: "number",
  maxSourceBuySol: "nullableNumber",
  sourceScaleEnabled: "boolean",
  sourceScalePct: "number",
  vetoBuyOnSellPressure: "boolean",
  sellPressureWindowMin: "integer",
  sellPressureMinSellers: "integer",
  sellPressureVetoRatio: "number",
  exitOnSellPressure: "boolean",
  exitSellPressureMinSellers: "integer",
  exitSellPressureRatio: "number",
  sellPressureExitFraction: "number",
  maxDailyDrawdownTry: "nullableNumber",
  maxDailyDrawdownPct: "nullableNumber",
  dailyDrawdownCooldownMin: "integer",
  globalLossBrake: "boolean",
  maxConsecutiveLosses: "integer",
  globalLossBrakeCooldownMin: "integer",
  tokenLossBlockTry: "nullableNumber",
  tokenLossBlockMin: "integer",
  autoDemoteLosers: "boolean",
  autoDemoteMinClosed: "integer",
  autoDemoteWinRatePct: "number",
  autoDemoteRealizedTry: "number",
  autoDemoteCooldownMin: "integer",
  noPriceRetryDelaySec: "integer",
  noPriceRetryMaxAgeSec: "integer",
  noPriceRetryMaxAttempts: "integer",
  noPriceRetryQueueLimit: "integer",
  minClosedTradesForPenalty: "integer",
  penaltyWinRatePct: "number",
  penaltyRealizedTry: "number",
  walletPenaltyCooldownMin: "integer",
  feeHaircutPct: "number",
  buySlippagePct: "number",
  sellSlippagePct: "number",
  platformFeePct: "number",
  priorityFeeTry: "number",
  stopLossPct: "number",
  coreProfitLockTry: "number",
  coreProfitLockFraction: "number",
  takeProfit1Pct: "number",
  takeProfit2Pct: "number",
  trailingStopPct: "number",
  moonshotStopLossPct: "number",
  moonshotTakeProfit1Pct: "number",
  moonshotTakeProfit2Pct: "number",
  moonshotTrailingStopPct: "number",
  moonshotTp1Fraction: "number",
  moonshotTp2Fraction: "number",
  runnerExitIfWalletSoldBelowPct: "number",
  autoTrackTransferTargets: "boolean",
  copyTransferInAsBuy: "boolean",
  inferNoPriceFromSol: "boolean",
  tradeHistoricalOnStartup: "boolean"
};

const INTELLIGENCE_SETTING_FIELDS = {
  cieloApiKey: "string",
  birdeyeApiKey: "string",
  definedApiKey: "string",
  heliusWebhookUrl: "string",
  geyserGrpcEndpoint: "string",
  geyserAuthToken: "string",
  geyserProvider: "string",
  jitoTipMinSol: "number",
  ultraCrashGatePct: "number",
  enableCieloPnl: "boolean",
  enableBirdeyeFirstBuyers: "boolean",
  enableFakeSmartFilter: "boolean",
  enableBundleHardGate: "boolean",
  enableTransferChainFollow: "boolean",
  enableUltraOnchainLayer: "boolean",
  enableGeyserJitoLayer: "boolean",
  enableBytecodeGuard: "boolean",
  enableGenesisTrace: "boolean",
  enableExperimentalWebsockets: "boolean"
};

function applySettingsPatch(config, patch) {
  for (const [key, type] of Object.entries(CONTROL_SETTING_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (type === "boolean") {
      config[key] = toBoolean(patch[key]);
    } else if (type === "integer") {
      const value = toFiniteNumber(patch[key], config[key]);
      if (value !== null) config[key] = Math.max(0, Math.round(value));
    } else if (type === "nullableNumber") {
      const value = toFiniteNumber(patch[key], null);
      config[key] = value === null || value <= 0 ? null : value;
    } else {
      const value = toFiniteNumber(patch[key], config[key]);
      if (value !== null) config[key] = value;
    }
  }
  for (const [key, type] of Object.entries(INTELLIGENCE_SETTING_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (type === "boolean") config[key] = toBoolean(patch[key]);
    else {
      const value = String(patch[key] || "").trim();
      if (value === "********") continue;
      config[key] = value.slice(0, 800);
    }
  }
  return config;
}

async function updateControlSettings(patch, restart = true) {
  const config = await readJson("config.json", {});
  applySettingsPatch(config, patch || {});
  await writeJson("config.json", config);
  if (restart) queueBotRestart("settings");
  const bot = await getBotStatus();
  return { ok: true, restarting: Boolean(restart), bot, config: publicConfig(config) };
}

async function updateControlWallet(patch, restart = true) {
  const config = await readJson("config.json", {});
  const wallets = config.wallets || [];
  const wallet = wallets.find((item) => item.name === patch.name || item.address === patch.address);
  if (!wallet) throw new Error("wallet not found");

  const denied = new Set((config.copyDenylist || []).map((item) => String(item).trim()).filter(Boolean));
  const copyDenied = patch.mode === "copy" && (denied.has(wallet.name) || denied.has(wallet.address));
  if (copyDenied) throw new Error(`${wallet.name} copy denylistte; once denylistten cikar`);

  const manualCopy = patch.mode === "copy";
  if (["copy", "alert", "off"].includes(patch.mode)) wallet.mode = patch.mode;
  if (patch.tradeTry !== undefined) wallet.tradeTry = Math.max(0, Math.round(toFiniteNumber(patch.tradeTry, wallet.tradeTry || 0) || 0));
  if (patch.score !== undefined) wallet.score = Math.max(0, Math.min(100, Math.round(toFiniteNumber(patch.score, wallet.score || 0) || 0)));
  if (["AG", "A", "B", "C", "D"].includes(patch.class)) wallet.class = patch.class;
  if (["normal", "high"].includes(patch.confidence)) wallet.confidence = patch.confidence;
  if (patch.moonshot !== undefined) wallet.moonshot = toBoolean(patch.moonshot);
  if (typeof patch.note === "string") wallet.note = patch.note.slice(0, 600);
  if (wallet.mode === "off" && patch.tradeTry === undefined) wallet.tradeTry = 0;
  if (manualCopy) {
    wallet.manualOverrideAt = new Date().toISOString();
    wallet.manualOverrideUntil = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  } else if (["alert", "off"].includes(patch.mode)) {
    delete wallet.manualOverrideAt;
    delete wallet.manualOverrideUntil;
  }

  await writeJson("config.json", config);
  if (manualCopy) {
    const state = await readJson("paper-state.json", null);
    if (state?.risk?.autoDemoted?.[wallet.name]) {
      delete state.risk.autoDemoted[wallet.name];
      await writeJson("paper-state.json", state);
    }
  }
  if (restart) queueBotRestart(`wallet ${wallet.name}`);
  const bot = await getBotStatus();
  return { ok: true, restarting: Boolean(restart), bot, wallet, config: publicConfig(config) };
}

function cleanWalletAddress(address) {
  const value = String(address || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error("invalid solana wallet address");
  return value;
}

function nextWalletName(config, prefix = "Aday") {
  const used = new Set((config.wallets || []).map((wallet) => wallet.name));
  for (let index = 1; index < 1000; index += 1) {
    const name = `${prefix}-${String(index).padStart(2, "0")}`;
    if (!used.has(name)) return name;
  }
  return `${prefix}-${Date.now()}`;
}

async function addControlWallet(body, restart = true) {
  const config = await readJson("config.json", {});
  config.wallets ||= [];
  const address = cleanWalletAddress(body.address || body.wallet);
  const denied = new Set((config.copyDenylist || []).map((item) => String(item).trim()).filter(Boolean));
  const existing = config.wallets.find((wallet) => wallet.address === address);
  if (existing) {
    if (body.mode === "copy" && (denied.has(existing.name) || denied.has(existing.address))) {
      throw new Error(`${existing.name} copy denylistte; once denylistten cikar`);
    }
    if (body.mode && ["copy", "alert", "off"].includes(body.mode)) existing.mode = body.mode;
    if (body.tradeTry !== undefined) existing.tradeTry = Math.max(0, Math.round(toFiniteNumber(body.tradeTry, existing.tradeTry || 0) || 0));
    if (body.note) existing.note = String(body.note).slice(0, 600);
    await writeJson("config.json", config);
    if (restart) queueBotRestart(`wallet existing ${existing.name}`);
    return { ok: true, existing: true, wallet: existing, config: publicConfig(config) };
  }

  const mode = ["copy", "alert", "off"].includes(body.mode) ? body.mode : "alert";
  if (mode === "copy" && denied.has(address)) throw new Error("wallet copy denylistte; once denylistten cikar");
  const wallet = {
    name: String(body.name || "").trim().slice(0, 32) || nextWalletName(config, body.prefix || "Aday"),
    address,
    mode,
    confidence: ["normal", "high"].includes(body.confidence) ? body.confidence : "normal",
    class: ["AG", "A", "B", "C", "D"].includes(body.class) ? body.class : (mode === "copy" ? "B" : "C"),
    score: Math.max(0, Math.min(100, Math.round(toFiniteNumber(body.score, mode === "copy" ? 60 : 45) || 0))),
    tradeTry: Math.max(0, Math.round(toFiniteNumber(body.tradeTry, mode === "copy" ? 60 : 0) || 0)),
    moonshot: body.moonshot === undefined ? true : toBoolean(body.moonshot),
    note: String(body.note || "Panelden eklendi; önce paper/alert doğrulama.").slice(0, 600)
  };
  if (mode !== "copy") wallet.tradeTry = Math.max(0, wallet.tradeTry || 0);
  config.wallets.push(wallet);
  await writeJson("config.json", config);
  if (restart) queueBotRestart(`wallet add ${wallet.name}`);
  return { ok: true, existing: false, wallet, config: publicConfig(config) };
}

async function batchWalletMode(mode, restart = true) {
  if (!["copy", "alert", "off"].includes(mode)) throw new Error("invalid wallet mode");
  const config = await readJson("config.json", {});
  for (const wallet of config.wallets || []) {
    wallet.mode = mode;
    if (mode === "off") wallet.tradeTry = 0;
  }
  await writeJson("config.json", config);
  if (restart) queueBotRestart(`wallet batch ${mode}`);
  const bot = await getBotStatus();
  return { ok: true, restarting: Boolean(restart), bot, config: publicConfig(config) };
}

function closePaperPositionAt(state, position, exitTry, reason = "manual panel close") {
  const fraction = 1;
  const amountToSell = position.amount * fraction;
  const closedAt = new Date().toISOString();
  const grossProceedsTry = amountToSell * exitTry;
  const sellCostPct = position.sellCostPct ?? 0;
  const proceedsTry = grossProceedsTry * (1 - sellCostPct / 100);
  const costBasisTry = position.investedTry * fraction;
  const pnlTry = proceedsTry - costBasisTry;
  state.cashTry += proceedsTry;
  state.realizedTry += pnlTry;
  state.positions = (state.positions || []).filter((item) => item.id !== position.id);
  state.closedTrades ||= [];
  state.closedTrades.unshift({
    id: `${position.id}-manual-${Date.now()}`,
    openedAt: position.openedAt,
    closedAt,
    wallet: position.wallet,
    symbol: position.symbol,
    mint: position.mint,
    reason,
    investedTry: costBasisTry,
    proceedsTry,
    pnlTry,
    gainPct: position.entryTry ? ((exitTry - position.entryTry) / position.entryTry) * 100 : 0,
    url: position.url
  });
  state.closedTrades = state.closedTrades.slice(0, 300);
  return { pnlTry, proceedsTry };
}

async function manualClosePosition(positionId) {
  const wasRunning = (await getBotStatus()).running;
  if (wasRunning) await stopBotProcess();
  const [config, state] = await Promise.all([
    readJson("config.json", {}),
    readJson("paper-state.json", null)
  ]);
  if (!state) throw new Error("paper state not found");
  const position = (state.positions || []).find((item) => item.id === positionId);
  if (!position) throw new Error("position not found");
  const price = await getTokenPriceTry(position.mint, config.tryPerSol || 4350);
  if (!price) throw new Error("price not found");
  const closed = closePaperPositionAt(state, position, price.priceTry, "manual panel close");
  await writeJson("paper-state.json", state);
  const bot = wasRunning ? await startBotProcess() : await getBotStatus();
  return { ok: true, bot, closed };
}

function gmgnWalletUrl(address) {
  return `https://gmgn.ai/sol/address/${address}`;
}

function solscanWalletUrl(address) {
  return `https://solscan.io/account/${address}`;
}

function cieloWalletUrl(address) {
  return `https://app.cielo.finance/profile/${address}`;
}

function arkhamSearchUrl(address) {
  return `https://platform.arkhamintelligence.com/explorer/address/${address}`;
}

function nansenSearchUrl(address) {
  return `https://app.nansen.ai/search?query=${address}`;
}

function researchVerdict(item, lastSeenAt = null) {
  if (!item) {
    return {
      grade: "BILINMIYOR",
      action: "Once GMGN/Birdeye ile dogrula",
      confidence: 0,
      reasons: ["lokal taramada veri yok"]
    };
  }
  const closed = Number(item.closed || 0);
  const winRate = Number(item.winRate || 0);
  const pnlSol = Number(item.pnlSol || 0);
  const loss = Math.abs(Math.min(0, Number(item.biggestLossSol || 0)));
  const maxX = Number(item.maxX || 1);
  const activeHours = lastSeenAt ? (Date.now() - new Date(lastSeenAt).getTime()) / 36e5 : null;

  let confidence = 0;
  confidence += Math.min(22, closed * 1.4);
  confidence += Math.min(22, Math.max(0, winRate - 35) * 0.55);
  confidence += Math.min(24, Math.max(0, pnlSol) * 3.5);
  confidence += Math.min(18, Math.log2(Math.max(1, maxX)) * 5);
  confidence -= Math.min(24, loss * 5);
  if (activeHours !== null) confidence += activeHours <= 24 ? 8 : activeHours <= 96 ? 4 : -6;
  if ((item.sources || []).length >= 2) confidence += 5;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const reasons = [
    `${closed} kapanis`,
    `WR ${winRate.toFixed(1)}%`,
    `PnL ${pnlSol.toFixed(2)} SOL`,
    `max ${maxX.toFixed(1)}x`,
    `max zarar -${loss.toFixed(2)} SOL`,
    activeHours === null ? "aktiflik bilinmiyor" : activeHours <= 24 ? "son 24s aktif" : `${Math.round(activeHours / 24)} gun once aktif`
  ];

  if (confidence >= 78 && loss <= 1.5 && closed >= 10) {
    return { grade: "A", action: "2 cüzdan onayi gelirse copy adayi", confidence, reasons };
  }
  if (maxX >= 10 && pnlSol > 0 && loss <= 2) {
    return { grade: "MOON", action: "tek basina mini, ikinci onayda buyut", confidence, reasons };
  }
  if (confidence >= 58 && pnlSol > 0) {
    return { grade: "B", action: "alarm + kucuk lot adayi", confidence, reasons };
  }
  if (pnlSol > 0 && maxX >= 4) {
    return { grade: "WATCH", action: "sadece izle, cluster bekle", confidence, reasons };
  }
  return { grade: "RISK", action: "copy kapali, sadece manuel kontrol", confidence, reasons };
}

async function apiResearch(address = "") {
  const config = await readJson("config.json", {});
  const normalized = String(address || "").trim();
  const [state, successful, smart, moonExisting, deep, pir, freeAlpha] = await Promise.all([
    readJson("paper-state.json", {}),
    readJsonAnyEncoding("successful-traders-shortlist.json", { traders: [] }),
    readJsonAnyEncoding("smart-wallet-shortlist.json", { wallets: [] }),
    readJsonAnyEncoding("moonshot-existing-roi-candidates.json", []),
    readJsonAnyEncoding("deep-scan-result.json", { ranked: [] }),
    readJsonAnyEncoding("pir-scan-result.json", { ranked: [] }),
    readJsonAnyEncoding("free-alpha-radar-result.json", { wallets: [], clusters: [] })
  ]);

  const configured = new Map((config.wallets || []).map((wallet) => [wallet.address, wallet]));
  const merge = new Map();
  const add = (item, source, extra = {}) => {
    if (!item?.wallet) return;
    const previous = merge.get(item.wallet) || {};
    merge.set(item.wallet, {
      ...previous,
      ...item,
      ...extra,
      wallet: item.wallet,
      sources: [...new Set([...(previous.sources || []), source])],
      configured: configured.get(item.wallet) || previous.configured || null
    });
  };
  for (const item of successful?.traders || []) add(item, "successful");
  for (const item of smart?.wallets || []) add(item, "smart");
  for (const item of Array.isArray(moonExisting) ? moonExisting : []) add(item, "moonshot-existing");
  for (const item of deep?.ranked || []) add(item, "deep-scan");
  for (const item of pir?.ranked || []) add(item, "pir-scan");

  const candidates = [...merge.values()].map((item) => {
    const best = item.best || [];
    const maxRoiPct = Math.max(0, ...best.map((trade) => Number(trade.roiPct ?? ((trade.roiX ?? 1) - 1) * 100)).filter(Number.isFinite));
    const maxX = Number((1 + maxRoiPct / 100).toFixed(2));
    const loss = Number(item.biggestLossSol || 0);
    const closed = Number(item.closed || 0);
    const winRate = Number(item.winRate || 0);
    const pnlSol = Number(item.pnlSol || 0);
    const score =
      Math.min(30, closed * 1.3) +
      winRate * 0.35 +
      Math.min(35, Math.max(0, pnlSol) * 3.5) +
      Math.min(18, Math.log2(Math.max(1, maxX)) * 5) -
      Math.abs(Math.min(0, loss)) * 4;
    return {
      wallet: item.wallet,
      name: item.configured?.name || item.name || "-",
      mode: item.configured?.mode || "-",
      sources: item.sources || [],
      tokens: item.tokens || [],
      closed,
      winRate,
      pnlSol,
      biggestLossSol: loss,
      maxX,
      score: Number(score.toFixed(1)),
      best: best.slice(0, 3)
    };
  }).map((item) => ({
    ...item,
    verdict: researchVerdict(item),
    classifier: walletClassifier(item),
    walletGate: walletSixGate(item)
  })).sort((a, b) => b.verdict.confidence - a.verdict.confidence || b.score - a.score);

  let wallet = null;
  if (normalized) {
    const local = candidates.find((item) => item.wallet === normalized) || null;
    const alphaLocal = (freeAlpha?.wallets || []).find((item) => item.wallet === normalized) || null;
    const [balanceLamports, signatures, heliusAssets, nansen, cielo] = await Promise.all([
      solanaRpc(config, "getBalance", [normalized]).catch(() => null),
      solanaRpc(config, "getSignaturesForAddress", [normalized, { limit: 12 }]).catch(() => []),
      heliusRpc(config, "getAssetsByOwner", {
        ownerAddress: normalized,
        page: 1,
        limit: 20,
        displayOptions: { showFungible: true, showNativeBalance: true }
      }).catch(() => null),
      nansenAddressProfile(config, normalized, "solana").catch((error) => ({
        enabled: Boolean(nansenKey(config)),
        labels: [],
        premiumLabels: [],
        error: error?.message || String(error)
      })),
      config.enableCieloPnl ? cieloWalletPnl(config, normalized).catch((error) => ({ enabled: Boolean(cieloKey(config)), ok: false, error: error?.message || String(error) })) : Promise.resolve({ enabled: Boolean(cieloKey(config)), ok: false, error: "Cielo PnL modulu kapali" })
    ]);
    const enhanced = await heliusEnhancedTransactions(config, (signatures || []).map((item) => item.signature));
    wallet = {
      address: normalized,
      balanceSol: balanceLamports?.value !== undefined ? balanceLamports.value / 1e9 : null,
      lastSeenAt: signatures?.[0]?.blockTime ? new Date(signatures[0].blockTime * 1000).toISOString() : null,
      helius: {
        enabled: Boolean(heliusKey(config)),
        assetCount: heliusAssets?.total ?? null,
        nativeBalanceSol: heliusAssets?.nativeBalance?.lamports !== undefined ? heliusAssets.nativeBalance.lamports / 1e9 : null,
        topAssets: (heliusAssets?.items || []).slice(0, 8).map((asset) => ({
          id: asset.id,
          symbol: asset.content?.metadata?.symbol || asset.token_info?.symbol || asset.id?.slice(0, 6),
          name: asset.content?.metadata?.name || asset.token_info?.name || "-",
          balance: asset.token_info?.balance ?? null,
          decimals: asset.token_info?.decimals ?? null,
          price: asset.token_info?.price_info?.price_per_token ?? null
        })),
        enhancedTransactions: (enhanced || []).slice(0, 8).map((tx) => ({
          signature: tx.signature,
          type: tx.type,
          source: tx.source,
          description: tx.description,
          timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null
        }))
      },
      nansen,
      cielo,
      recentSignatures: (signatures || []).map((item) => ({
        signature: item.signature,
        time: item.blockTime ? new Date(item.blockTime * 1000).toISOString() : null,
        err: item.err || null,
        solscan: `https://solscan.io/tx/${item.signature}`
      })),
      local,
      alphaLocal,
      verdict: researchVerdict(local, signatures?.[0]?.blockTime ? new Date(signatures[0].blockTime * 1000).toISOString() : null),
      links: {
        gmgn: gmgnWalletUrl(normalized),
        solscan: solscanWalletUrl(normalized),
        cielo: cieloWalletUrl(normalized),
        arkham: arkhamSearchUrl(normalized),
        nansen: nansenSearchUrl(normalized)
      }
    };
  }

  const classicSmartWallets = candidates
    .filter((item) => item.verdict?.confidence >= 55 && item.pnlSol > 0)
    .slice(0, 12)
    .map((item) => ({
      wallet: item.wallet,
      profile: item.verdict?.grade === "A" ? "SMART WALLET" : item.verdict?.grade || "WATCH",
      archetypes: ["KLASIK SMART"],
      alphaScore: item.verdict?.confidence || item.score || 0,
      insiderScore: Math.min(100, Math.round((item.maxX || 1) * 8 + (item.pnlSol || 0) * 4)),
      sniperScore: 0,
      hits: item.closed,
      earlyHits: 0,
      pnlSol: item.pnlSol,
      winRate: item.winRate,
      maxX: item.maxX,
      biggestLossSol: item.biggestLossSol,
      riskFlags: Math.abs(Math.min(0, item.biggestLossSol || 0)) > 2 ? ["büyük zarar izi"] : [],
      action: item.verdict?.action || "önce izle",
      lotTry: item.verdict?.grade === "A" ? 100 : 50,
      tokens: item.tokens || []
    }));
  const enrichWalletRows = (rows = []) => rows.map((row) => ({
    ...row,
    classifier: row.classifier || walletClassifier(row),
    walletGate: row.walletGate || walletSixGate(row)
  }));

  return {
    now: new Date().toISOString(),
    apiNotes: [
      { name: "Helius Wallet API", status: heliusKey(config) ? "bagli" : "API key gerekli", use: "cuzdan assetleri, token transfer, funded-by; insider fon kaynagi icin en mantikli ilk entegrasyon", link: "https://www.helius.dev/docs/wallet-api/overview" },
      { name: "Helius Enhanced Transactions", status: heliusKey(config) ? "bagli" : "API key gerekli", use: "ham imzalari swap/transfer olarak parse eder; bizim no-price ve swap ayrimi derdini azaltir", link: "https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions" },
      { name: "Nansen Address Labels", status: nansenKey(config) ? "key var / kredi test edilir" : "API key gerekli", use: "cuzdan etiketleri, smart money/alpha trader/premium label dogrulamasi; tek cüzdan kontrolünde otomatik cekilir", link: "https://docs.nansen.ai/api/profiler/address-labels" },
      { name: "Cielo Wallet PnL", status: cieloKey(config) ? (config.enableCieloPnl ? "key var / aktif" : "key var / modul kapali") : "API key gerekli", use: "gercek wallet PnL, token bazli kar/zarar ve win rate; smart wallet kapilarini guclendirir", link: "https://developer.cielo.finance/" },
      { name: "Birdeye Token Trades", status: birdeyeKey(config) ? (config.enableBirdeyeFirstBuyers ? "key var / aktif" : "key var / modul kapali") : "API key gerekli", use: "yeni token ilk alicilarini bulup cüzdan avcisina aday uretir", link: "https://docs.birdeye.so/" },
      { name: "Birdeye Wallet APIs", status: birdeyeKey(config) ? "key var" : "API key gerekli", use: "wallet PnL summary, per-token PnL, portfolio, net worth, tx history; GMGN yerine en pratik PnL dogrulama", link: "https://docs.birdeye.so/reference/get-wallet-v2-pnl-summary" },
      { name: "Bitquery Traders API", status: "API key/ucretli", use: "Solana/Base/EVM real-time trade stream, wallet trade query, top trader siralama; buy/sell USD aggregation", link: "https://docs.bitquery.io/docs/trading/crypto-trades-api/traders-api/" },
      { name: "Moralis PnL API", status: "API key gerekli", use: "realized wallet PnL summary/breakdown ve top traders by token; EVM + Solana dogrulama icin iyi", link: "https://docs.moralis.com/data-api/data-features/data-enrichment/profitability-pnl" },
      { name: "Shyft Parsed Transactions", status: "API key gerekli", use: "parsed transaction history, parsed callbacks/webhooks; Solana swap gecmisi icin uygun", link: "https://docs.shyft.to/solana-apis/transactions/transaction-apis" },
      { name: "Solana RPC", status: "aktif", use: "ucretsiz temel bakiye/son imza; ama swap PnL icin tek basina zahmetli", link: "https://solana.com/docs/rpc" },
      { name: "DexScreener", status: "aktif/public", use: "token fiyat, likidite, mcap, hacim; wallet PnL vermez", link: "https://docs.dexscreener.com/api/reference" },
      { name: "GMGN / Cielo / Arkham", status: "site/link veya ozel API", use: "manuel dogrulama, etiket ve iliski analizi; API erisimi genelde hesap/plan ister", link: "https://gmgn.ai/" }
    ],
    candidates: candidates.slice(0, 40),
    freeAlpha: {
      createdAt: freeAlpha?.createdAt || null,
      wallets: enrichWalletRows(freeAlpha?.wallets || []).slice(0, 20),
      clusters: (freeAlpha?.clusters || []).slice(0, 20),
      hunter: {
        sniperWallets: enrichWalletRows(freeAlpha?.hunter?.sniperWallets || []).slice(0, 12),
        insiderLikeWallets: enrichWalletRows(freeAlpha?.hunter?.insiderLikeWallets || []).slice(0, 12),
        smartWallets: enrichWalletRows([...(freeAlpha?.hunter?.smartWallets || []), ...classicSmartWallets]).slice(0, 12),
        suggestedWatchlist: enrichWalletRows([...(freeAlpha?.hunter?.suggestedWatchlist || []), ...classicSmartWallets]).slice(0, 18),
        rules: freeAlpha?.hunter?.rules || []
      }
    },
    wallet,
    configSummary: {
      trackedWallets: (config.wallets || []).length,
      copyWallets: (config.wallets || []).filter((wallet) => wallet.mode === "copy").length,
      maxBuyMarketCapUsd: config.maxBuyMarketCapUsd ?? null,
      heliusEnabled: Boolean(heliusKey(config)),
      nansenEnabled: Boolean(nansenKey(config)),
      cieloEnabled: Boolean(cieloKey(config)),
      birdeyeEnabled: Boolean(birdeyeKey(config)),
      cashTry: state.cashTry ?? null,
      realizedTry: state.realizedTry ?? null
    }
  };
}

function looksSolanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || "").trim());
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function logScore(value, low, high) {
  const number = Math.max(0, Number(value || 0));
  if (number <= low) return 0;
  const lowLog = Math.log10(Math.max(1, low));
  const highLog = Math.log10(Math.max(2, high));
  return clamp(((Math.log10(number) - lowLog) / (highLog - lowLog)) * 100);
}

function minutesSince(timestamp) {
  if (!timestamp) return null;
  return (Date.now() - Number(timestamp)) / 60000;
}

async function fetchJsonLoose(url, fallback = null, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "codex-local-oracle/1.0"
      }
    });
    if (!response.ok) return fallback;
    return await response.json().catch(() => fallback);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithHeaders(url, headers = {}, fallback = null, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "codex-local-oracle/1.0",
        ...headers
      }
    });
    if (!response.ok) return fallback;
    return await response.json().catch(() => fallback);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function cieloWalletPnl(config, wallet) {
  const key = cieloKey(config);
  if (!key || !looksSolanaAddress(wallet)) return { enabled: Boolean(key), ok: false, error: key ? "invalid wallet" : "Cielo API key yok" };
  const headers = { "x-api-key": key, authorization: `Bearer ${key}` };
  const urls = [
    `https://feed-api.cielo.finance/api/v1/${wallet}/pnl/tokens`,
    `https://feed-api.cielo.finance/v1/${wallet}/pnl`
  ];
  for (const url of urls) {
    const data = await fetchJsonWithHeaders(url, headers, null, 12000);
    if (!data) continue;
    const rows = Array.isArray(data?.data?.items) ? data.data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data?.items) ? data.items : [];
    const realizedUsd = Number(data?.data?.realized_pnl_usd ?? data?.realized_pnl_usd ?? rows.reduce((sum, item) => sum + Number(item.realized_pnl_usd ?? item.realizedPnlUsd ?? item.pnl_usd ?? 0), 0));
    const wins = rows.filter((item) => Number(item.realized_pnl_usd ?? item.realizedPnlUsd ?? item.pnl_usd ?? 0) > 0).length;
    const losses = rows.filter((item) => Number(item.realized_pnl_usd ?? item.realizedPnlUsd ?? item.pnl_usd ?? 0) < 0).length;
    const closed = wins + losses || rows.length;
    return {
      enabled: true,
      ok: true,
      source: url,
      realizedUsd: Number(realizedUsd.toFixed(2)),
      closed,
      winRate: closed ? Number(((wins / closed) * 100).toFixed(1)) : null,
      tokenCount: rows.length,
      tokens: rows.slice(0, 12).map((item) => ({
        symbol: item.token_symbol || item.symbol || item.token?.symbol || item.mint?.slice?.(0, 6) || "-",
        mint: item.token_address || item.mint || item.token?.address || null,
        realizedUsd: Number(item.realized_pnl_usd ?? item.realizedPnlUsd ?? item.pnl_usd ?? 0),
        txs: Number(item.num_swaps ?? item.tx_count ?? item.transactions ?? 0)
      }))
    };
  }
  return { enabled: true, ok: false, error: "Cielo cevap vermedi veya endpoint/plan kapali" };
}

async function birdeyeTokenTrades(config, mint, limit = 50) {
  const key = birdeyeKey(config);
  if (!key || !looksSolanaAddress(mint)) return { enabled: Boolean(key), ok: false, error: key ? "invalid mint" : "Birdeye API key yok", trades: [] };
  const url = `https://public-api.birdeye.so/defi/txs/token?address=${encodeURIComponent(mint)}&tx_type=swap&limit=${Math.max(10, Math.min(50, Number(limit || 50)))}`;
  const data = await fetchJsonWithHeaders(url, { "X-API-KEY": key, "x-chain": "solana" }, null, 12000);
  const rows = Array.isArray(data?.data?.items) ? data.data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data?.items) ? data.items : [];
  const buyers = new Map();
  for (const row of rows) {
    const owner = row.owner || row.wallet || row.trader || row.tx_from || row.from || row.userAddress;
    if (!looksSolanaAddress(owner)) continue;
    const side = String(row.side || row.txType || row.type || "").toLowerCase();
    const blockTime = Number(row.blockUnixTime || row.block_time || row.timestamp || 0);
    const current = buyers.get(owner) || { wallet: owner, buys: 0, sells: 0, firstAt: blockTime || null, amountUsd: 0 };
    if (/sell/.test(side)) current.sells += 1;
    else current.buys += 1;
    current.amountUsd += Number(row.volumeUsd || row.amount_usd || row.valueUsd || 0);
    if (blockTime && (!current.firstAt || blockTime < current.firstAt)) current.firstAt = blockTime;
    buyers.set(owner, current);
  }
  const firstBuyers = [...buyers.values()]
    .filter((item) => item.buys > 0)
    .sort((a, b) => (a.firstAt || Infinity) - (b.firstAt || Infinity))
    .slice(0, 20)
    .map((item) => ({ ...item, firstAtIso: item.firstAt ? new Date(item.firstAt * 1000).toISOString() : null, amountUsd: Number(item.amountUsd.toFixed(2)) }));
  return {
    enabled: true,
    ok: Boolean(data),
    tradeCount: rows.length,
    firstBuyers,
    source: url
  };
}

function normalizeOracleQuery(input) {
  const raw = String(input || "").trim();
  const dexMatch = raw.match(/dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (dexMatch) return { raw, value: dexMatch[1], kind: "dex-url" };
  if (looksSolanaAddress(raw)) return { raw, value: raw, kind: "address" };
  return { raw, value: raw.replace(/^[$#]+/, "").trim(), kind: "search" };
}

function bestSolanaPair(pairs = [], preferredAddress = "") {
  const preferred = String(preferredAddress || "");
  return (pairs || [])
    .filter((pair) => pair?.chainId === "solana")
    .sort((a, b) => {
      const aPreferred = [a.pairAddress, a.baseToken?.address, a.quoteToken?.address].includes(preferred) ? 1 : 0;
      const bPreferred = [b.pairAddress, b.baseToken?.address, b.quoteToken?.address].includes(preferred) ? 1 : 0;
      return bPreferred - aPreferred || Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0) || Number(b.volume?.h24 || 0) - Number(a.volume?.h24 || 0);
    })[0] || null;
}

async function resolveDexToken(query) {
  const normalized = normalizeOracleQuery(query);
  if (!normalized.value) return { normalized, pair: null, pairs: [], source: "empty" };

  if (normalized.kind === "dex-url") {
    const byPair = await fetchJsonLoose(`https://api.dexscreener.com/latest/dex/pairs/solana/${encodeURIComponent(normalized.value)}`, { pairs: [] });
    const pair = bestSolanaPair(byPair?.pairs || [], normalized.value);
    if (pair) return { normalized, pair, pairs: byPair.pairs || [], source: "dex-pair" };
  }

  if (normalized.kind === "address") {
    const byToken = await fetchJsonLoose(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(normalized.value)}`, []);
    const tokenPairs = Array.isArray(byToken) ? byToken : byToken?.pairs || [];
    const tokenPair = bestSolanaPair(tokenPairs, normalized.value);
    if (tokenPair) return { normalized, pair: tokenPair, pairs: tokenPairs, source: "dex-token" };

    const byPair = await fetchJsonLoose(`https://api.dexscreener.com/latest/dex/pairs/solana/${encodeURIComponent(normalized.value)}`, { pairs: [] });
    const pair = bestSolanaPair(byPair?.pairs || [], normalized.value);
    if (pair) return { normalized, pair, pairs: byPair.pairs || [], source: "dex-pair" };
  }

  const search = await fetchJsonLoose(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(normalized.value)}`, { pairs: [] });
  const pair = bestSolanaPair(search?.pairs || [], normalized.value);
  return { normalized, pair, pairs: search?.pairs || [], source: "dex-search" };
}

function tokenAddressFromPair(pair, queryValue = "") {
  const q = String(queryValue || "");
  if (q && pair?.quoteToken?.address === q) return pair.quoteToken.address;
  return pair?.baseToken?.address || q || "";
}

function socialLinksFromPair(pair) {
  const links = [];
  for (const item of pair?.info?.websites || []) {
    if (item?.url) links.push({ type: "website", label: item.label || "website", url: item.url });
  }
  for (const item of pair?.info?.socials || []) {
    if (item?.url) links.push({ type: item.type || "social", label: item.type || "social", url: item.url });
  }
  return links;
}

async function dexSideData(mint) {
  const [orders, boostsLatest, boostsTop] = await Promise.all([
    fetchJsonLoose(`https://api.dexscreener.com/orders/v1/solana/${encodeURIComponent(mint)}`, []),
    fetchJsonLoose("https://api.dexscreener.com/token-boosts/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/token-boosts/top/v1", [])
  ]);
  const boostRows = [...(Array.isArray(boostsLatest) ? boostsLatest : []), ...(Array.isArray(boostsTop) ? boostsTop : [])]
    .filter((item) => item?.chainId === "solana" && item?.tokenAddress === mint);
  return {
    orders: Array.isArray(orders) ? orders : [],
    boostAmount: boostRows.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    boostTotalAmount: boostRows.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0),
    boosts: boostRows.slice(0, 6)
  };
}

async function rugCheckOracleData(mint) {
  const [summary, report] = await Promise.all([
    fetchJsonLoose(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`, null, 9000),
    fetchJsonLoose(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`, null, 11000)
  ]);
  if (!summary && !report) return { enabled: false, error: "veri yok" };
  return {
    enabled: true,
    score: summary?.score ?? report?.score ?? null,
    scoreNormalised: summary?.score_normalised ?? report?.score_normalised ?? null,
    risks: summary?.risks || report?.risks || [],
    lpLockedPct: summary?.lpLockedPct ?? report?.markets?.[0]?.lp?.lpLockedPct ?? null,
    rugged: report?.rugged ?? false,
    creator: report?.creator || null,
    creatorTokens: Array.isArray(report?.creatorTokens) ? report.creatorTokens.slice(0, 8) : [],
    totalHolders: report?.totalHolders ?? null,
    totalMarketLiquidity: report?.totalMarketLiquidity ?? null,
    insiderNetworks: report?.insiderNetworks || null,
    graphInsidersDetected: report?.graphInsidersDetected ?? null,
    deployPlatform: report?.deployPlatform || report?.launchpad || null,
    verification: report?.verification || null,
    topHolders: (report?.topHolders || []).slice(0, 8).map((holder) => ({
      owner: holder.owner || holder.address,
      pct: holder.pct ?? null,
      insider: Boolean(holder.insider)
    }))
  };
}

async function pumpFunOracleData(mint) {
  const data = await fetchJsonLoose(`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`, null, 9000);
  if (!data?.mint) return { enabled: false, error: "pump.fun kaydi yok" };
  return {
    enabled: true,
    creator: data.creator || null,
    createdAt: data.created_timestamp ? new Date(Number(data.created_timestamp)).toISOString() : null,
    complete: Boolean(data.complete),
    isBanned: Boolean(data.is_banned),
    nsfw: Boolean(data.nsfw),
    tokenizedAgent: Boolean(data.tokenized_agent),
    replyCount: data.reply_count ?? null,
    currentlyLive: Boolean(data.is_currently_live),
    twitter: data.twitter || null,
    website: data.website || null,
    protocol: data.protocol || null,
    usdMarketCap: data.usd_market_cap ?? null,
    athMarketCap: data.ath_market_cap ?? null,
    poolAddress: data.pool_address || data.pump_swap_pool || null,
    realSolReserves: data.real_sol_reserves ?? null,
    virtualSolReserves: data.virtual_sol_reserves ?? null
  };
}

async function geckoTerminalOracleData(mint) {
  const data = await fetchJsonLoose(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}`, null, 9000);
  const attrs = data?.data?.attributes;
  if (!attrs) return { enabled: false, error: "geckoterminal veri yok" };
  return {
    enabled: true,
    priceUsd: attrs.price_usd !== undefined ? Number(attrs.price_usd) : null,
    fdvUsd: attrs.fdv_usd !== undefined ? Number(attrs.fdv_usd) : null,
    reserveUsd: attrs.total_reserve_in_usd !== undefined ? Number(attrs.total_reserve_in_usd) : null,
    volume24Usd: attrs.volume_usd?.h24 !== undefined ? Number(attrs.volume_usd.h24) : null,
    marketCapUsd: attrs.market_cap_usd !== undefined ? Number(attrs.market_cap_usd) : null,
    coingeckoCoinId: attrs.coingecko_coin_id || null,
    launchpad: attrs.launchpad_details || null,
    topPools: (data?.data?.relationships?.top_pools?.data || []).slice(0, 5).map((pool) => pool.id)
  };
}

async function defiLlamaOracleData(mint) {
  const now = Date.now();
  const [coin] = await Promise.all([
    fetchJsonLoose(`https://coins.llama.fi/prices/current/solana:${encodeURIComponent(mint)}`, { coins: {} })
  ]);
  if (!oracleCache.llama || now - oracleCache.at > 10 * 60 * 1000) {
    const [chains, stablecoins] = await Promise.all([
      fetchJsonLoose("https://api.llama.fi/chains", []),
      fetchJsonLoose("https://stablecoins.llama.fi/stablecoins?includePrices=false", { peggedAssets: [] })
    ]);
    const solana = (Array.isArray(chains) ? chains : []).find((chain) => String(chain.name || "").toLowerCase() === "solana") || null;
    const solanaStableUsd = (stablecoins?.peggedAssets || []).reduce((sum, asset) => {
      const value =
        asset?.chainCirculating?.Solana?.current?.peggedUSD ??
        asset?.chainCirculating?.Solana?.peggedUSD ??
        asset?.circulating?.Solana?.peggedUSD ??
        0;
      return sum + Number(value || 0);
    }, 0);
    oracleCache = {
      at: now,
      llama: {
        solanaTvlUsd: solana?.tvl ?? null,
        solanaStableUsd: solanaStableUsd || null,
        chainsSeen: Array.isArray(chains) ? chains.length : 0
      }
    };
  }
  return {
    price: coin?.coins?.[`solana:${mint}`] || null,
    context: oracleCache.llama
  };
}

async function tokenOnchainRisk(config, mint) {
  const [supply, largest, parsed] = await Promise.all([
    solanaRpc(config, "getTokenSupply", [mint]).catch(() => null),
    solanaRpc(config, "getTokenLargestAccounts", [mint]).catch(() => null),
    solanaRpc(config, "getParsedAccountInfo", [mint]).catch(() => null)
  ]);
  const supplyAmount = Number(supply?.value?.uiAmount || supply?.value?.uiAmountString || 0);
  const holders = (largest?.value || []).map((item) => ({
    address: item.address,
    amount: Number(item.uiAmount || item.uiAmountString || 0),
    pct: supplyAmount > 0 ? (Number(item.uiAmount || item.uiAmountString || 0) / supplyAmount) * 100 : null
  }));
  const info = parsed?.value?.data?.parsed?.info || {};
  const top1 = holders[0]?.pct ?? null;
  const top10 = holders.slice(0, 10).reduce((sum, item) => sum + Number(item.pct || 0), 0);
  return {
    supply: supplyAmount || null,
    decimals: supply?.value?.decimals ?? info.decimals ?? null,
    top1Pct: top1,
    top10Pct: holders.length ? top10 : null,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    holders: holders.slice(0, 10)
  };
}

function cleanSearchText(...parts) {
  return parts
    .filter(Boolean)
    .map((part) => String(part).replace(/[^a-zA-Z0-9 _.-]/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 220);
}

async function githubTokenSignal(symbol, name, mint) {
  const q = cleanSearchText(symbol, name, "solana crypto token");
  if (!q) return { total: 0, items: [], error: "empty query" };
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=8`;
  const data = await fetchJsonLoose(url, { total_count: 0, items: [] });
  const mintData = looksSolanaAddress(mint)
    ? await fetchJsonLoose(`https://api.github.com/search/code?q=${encodeURIComponent(mint)}`, { total_count: 0, items: [] })
    : { total_count: 0, items: [] };
  return {
    query: q,
    total: data?.total_count || 0,
    mintMentions: mintData?.total_count || 0,
    items: (data?.items || []).slice(0, 8).map((repo) => ({
      name: repo.full_name,
      url: repo.html_url,
      description: repo.description || "",
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      openIssues: repo.open_issues_count || 0,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at
    }))
  };
}

async function redditTokenSignal(symbol, name, mint) {
  const q = cleanSearchText(symbol, name, "solana crypto");
  if (!q) return { count: 0, posts: [], error: "empty query" };
  const data = await fetchJsonLoose(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=month&limit=12`, { data: { children: [] } });
  const cryptoContext = /solana|crypto|token|coin|memecoin|meme coin|dex|pump|pumpfun|pump\.fun|jupiter|raydium|phantom|wallet|mint/i;
  const posts = (data?.data?.children || [])
    .map((child) => child.data || {})
    .filter((post) => {
      const haystack = `${post.title || ""} ${post.selftext || ""} ${post.url || ""}`;
      return haystack.includes(mint) || cryptoContext.test(haystack);
    })
    .slice(0, 12)
    .map((post) => ({
    title: post.title || "",
    subreddit: post.subreddit || "",
    score: post.score || 0,
    comments: post.num_comments || 0,
    createdAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    url: post.permalink ? `https://www.reddit.com${post.permalink}` : post.url,
    selftext: post.selftext ? String(post.selftext).slice(0, 220) : ""
  }));
  return {
    query: q,
    count: posts.length,
    totalScore: posts.reduce((sum, post) => sum + Number(post.score || 0), 0),
    totalComments: posts.reduce((sum, post) => sum + Number(post.comments || 0), 0),
    mintMentionLikely: posts.some((post) => `${post.title} ${post.selftext}`.includes(mint)),
    posts
  };
}

function scoreOracle({ pair, side, llama, onchain, github, reddit, socialLinks, rugcheck, pumpfun, gecko }) {
  const liquidityUsd = Number(pair?.liquidity?.usd || 0);
  const volume24 = Number(pair?.volume?.h24 || 0);
  const fdv = Number(pair?.fdv || pair?.marketCap || 0);
  const tx5 = Number(pair?.txns?.m5?.buys || 0) + Number(pair?.txns?.m5?.sells || 0);
  const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys24 = Number(pair?.txns?.h24?.buys || 0);
  const sells24 = Number(pair?.txns?.h24?.sells || 0);
  const ageMin = minutesSince(pair?.pairCreatedAt);
  const top1 = onchain?.top1Pct;
  const top10 = onchain?.top10Pct;
  const bundle = holderBundleProxy(onchain || {});
  const paidOrders = (side?.orders || []).filter((order) => ["approved", "processing"].includes(String(order.status || "").toLowerCase())).length;
  const rugRiskCount = Array.isArray(rugcheck?.risks) ? rugcheck.risks.length : 0;
  const rugScore = Number(rugcheck?.scoreNormalised ?? rugcheck?.score ?? 0);
  const lpLockedPct = rugcheck?.lpLockedPct === null || rugcheck?.lpLockedPct === undefined ? null : Number(rugcheck.lpLockedPct);
  const holderCount = Number(rugcheck?.totalHolders || 0);
  const creatorTokenCount = Array.isArray(rugcheck?.creatorTokens) ? rugcheck.creatorTokens.length : 0;
  const geckoReserve = Number(gecko?.reserveUsd || 0);
  const pumpAgeMin = pumpfun?.createdAt ? minutesSince(new Date(pumpfun.createdAt).getTime()) : null;

  const liquidityScore = logScore(liquidityUsd, 800, 75000);
  const activityScore = clamp(logScore(volume24, 2000, 500000) * 0.58 + logScore(tx1h + tx5 * 3, 2, 250) * 0.42);
  const momentumScore = clamp(
    50 +
    Number(pair?.priceChange?.m5 || 0) * 1.2 +
    Number(pair?.priceChange?.h1 || 0) * 0.75 +
    Number(pair?.priceChange?.h6 || 0) * 0.28 +
    Number(pair?.priceChange?.h24 || 0) * 0.12,
    0,
    100
  );
  const buyPressureScore = clamp(50 + ((buys24 - sells24) / Math.max(1, buys24 + sells24)) * 55);
  const socialScore = clamp(
    socialLinks.length * 10 +
    (socialLinks.some((link) => /twitter|x\.com/i.test(link.url)) ? 18 : 0) +
    (pumpfun?.twitter ? 10 : 0) +
    (pumpfun?.website ? 6 : 0) +
    Math.min(12, Number(pumpfun?.replyCount || 0) * 0.35) +
    Math.min(28, Number(reddit?.count || 0) * 4 + Number(reddit?.totalComments || 0) * 0.25) +
    Math.min(18, Number(github?.total || 0) * 2 + Number(github?.mintMentions || 0) * 5) +
    Math.min(12, Number(side?.boostTotalAmount || 0) / 20)
  );
  const devScore = clamp(Math.min(70, Number(github?.total || 0) * 4 + Number(github?.mintMentions || 0) * 12) + (llama?.price ? 20 : 0));
  const trustScore = clamp(
    (rugcheck?.enabled ? Math.max(0, 45 - rugScore * 8 - rugRiskCount * 7) : 15) +
    (lpLockedPct !== null ? Math.min(25, lpLockedPct * 0.25) : 0) +
    Math.min(15, holderCount / 90) +
    (pumpfun?.complete ? 8 : 0) +
    (gecko?.enabled ? 7 : 0) +
    (geckoReserve > 0 ? Math.min(10, logScore(geckoReserve, 1000, 100000) * 0.1) : 0)
  );
  const ageScore = ageMin === null ? 45 : ageMin < 8 ? 24 : ageMin < 45 ? 58 : ageMin < 1440 ? 72 : ageMin < 10080 ? 54 : 34;

  const riskFlags = [];
  if (liquidityUsd < 2000) riskFlags.push("likidite cok dusuk");
  if (fdv > 0 && liquidityUsd / fdv < 0.01) riskFlags.push("likidite/fdv orani zayif");
  if (top1 !== null && top1 > 35) riskFlags.push(`top1 holder ${top1.toFixed(1)}%`);
  if (top10 !== null && top10 > 82) riskFlags.push(`top10 holder ${top10.toFixed(1)}%`);
  if (bundle.bundleScore >= 80) riskFlags.push(`BUNDLE_KESIN ${bundle.bundleScore.toFixed(0)}`);
  else if (bundle.bundleScore >= 60) riskFlags.push(`BUNDLE_SUPHESI ${bundle.bundleScore.toFixed(0)}`);
  if (onchain?.freezeAuthority) riskFlags.push("freeze authority acik");
  if (onchain?.mintAuthority) riskFlags.push("mint authority acik");
  if (sells24 > buys24 * 1.45 && sells24 > 20) riskFlags.push("satis baskisi yuksek");
  if (paidOrders >= 2) riskFlags.push("paid hype/order var");
  if (ageMin !== null && ageMin < 8) riskFlags.push("cok yeni pair");
  if (rugcheck?.rugged) riskFlags.push("RugCheck rugged");
  for (const risk of rugcheck?.risks || []) {
    const label = risk.name || risk.description || risk.level || "rugcheck risk";
    riskFlags.push(`RugCheck: ${label}`);
  }
  if (lpLockedPct !== null && lpLockedPct < 40) riskFlags.push(`LP lock zayif ${lpLockedPct.toFixed(1)}%`);
  if (pumpfun?.isBanned) riskFlags.push("pump.fun banned");
  if (pumpfun?.nsfw) riskFlags.push("pump.fun nsfw");
  if (creatorTokenCount >= 6) riskFlags.push(`creator cok token cikarmis ${creatorTokenCount}+`);
  if (geckoReserve > 0 && liquidityUsd > 0 && geckoReserve < liquidityUsd * 0.35) riskFlags.push("Gecko/Dex likidite farki");
  if (pumpAgeMin !== null && pumpAgeMin < 5) riskFlags.push("pump cikisi cok yeni");

  const riskPenalty = Math.min(55, riskFlags.length * 8 + rugScore * 3 + (top1 && top1 > 55 ? 10 : 0) + (liquidityUsd < 1000 ? 8 : 0));
  const overall = clamp(
    liquidityScore * 0.18 +
    activityScore * 0.17 +
    momentumScore * 0.14 +
    buyPressureScore * 0.12 +
    socialScore * 0.13 +
    devScore * 0.07 +
    trustScore * 0.14 +
    ageScore * 0.05 -
    riskPenalty
  );

  const action =
    overall >= 78 && riskPenalty <= 18 ? "Guclu aday: yine de sadece simulasyon/mini lot ile dogrula" :
    overall >= 62 && riskPenalty <= 28 ? "Izle + scout lot: ikinci cuzdan/sosyal onay bekle" :
    overall >= 48 ? "Radar: acele alma, sosyal ve holder riski izle" :
    "Zayif/riskli: copy kapali, sadece kayit";
  const verdict =
    overall >= 78 ? "A" :
    overall >= 62 ? "B" :
    overall >= 48 ? "WATCH" :
    "RISK";

  const reasons = [
    `likidite $${Math.round(liquidityUsd).toLocaleString("en-US")}`,
    `24s hacim $${Math.round(volume24).toLocaleString("en-US")}`,
    `5dk islem ${tx5}`,
    `buy/sell ${buys24}/${sells24}`,
    `sosyal link ${socialLinks.length}`,
    `reddit ${reddit?.count || 0}`,
    `github ${github?.total || 0}`,
    `rug ${rugcheck?.enabled ? `${rugRiskCount} risk / LP ${lpLockedPct === null ? "-" : lpLockedPct.toFixed(0) + "%"}` : "veri yok"}`,
    `pump ${pumpfun?.enabled ? (pumpfun.complete ? "graduated" : "bonding") : "yok"}`,
    `risk ${riskFlags.length}`
  ];

  return {
    overall: Number(overall.toFixed(1)),
    verdict,
    action,
    reasons,
    riskFlags,
    modules: {
      liquidity: Number(liquidityScore.toFixed(1)),
      activity: Number(activityScore.toFixed(1)),
      momentum: Number(momentumScore.toFixed(1)),
      buyPressure: Number(buyPressureScore.toFixed(1)),
      social: Number(socialScore.toFixed(1)),
      dev: Number(devScore.toFixed(1)),
      trust: Number(trustScore.toFixed(1)),
      age: Number(ageScore.toFixed(1)),
      riskPenalty: Number(riskPenalty.toFixed(1))
    },
    bundle
  };
}

async function jupiterQuoteCheck(mint, solAmount = 0.15) {
  if (!looksSolanaAddress(mint)) {
    return { ok: false, verdict: "UNKNOWN", action: "mint gecersiz", error: "invalid mint" };
  }
  const solMint = "So11111111111111111111111111111111111111112";
  const amount = Math.max(1000, Math.round(Number(solAmount || 0.15) * 1e9));
  const url =
    "https://quote-api.jup.ag/v6/quote?inputMint=" +
    encodeURIComponent(solMint) +
    "&outputMint=" +
    encodeURIComponent(mint) +
    "&amount=" +
    amount +
    "&slippageBps=1500";
  const data = await fetchJsonLoose(url, null, 6500);
  const routes = Array.isArray(data?.routePlan) ? data.routePlan.length : 0;
  const impact = data?.priceImpactPct === undefined || data?.priceImpactPct === null ? null : Number(data.priceImpactPct);
  const impactPct = impact === null ? null : impact * 100;
  const outAmount = Number(data?.outAmount || 0);
  const ok = Boolean(data && outAmount > 0);
  const verdict =
    !ok ? "UNKNOWN" :
    impactPct !== null && impactPct >= 18 ? "RISK" :
    impactPct !== null && impactPct >= 8 ? "WATCH" :
    routes <= 0 ? "WATCH" :
    "OK";
  return {
    ok,
    routeCount: routes,
    priceImpactPct: impactPct === null ? null : Number(impactPct.toFixed(2)),
    outAmount: outAmount || null,
    verdict,
    action:
      verdict === "OK" ? "Jupiter route var; slippage makul gorunuyor" :
      verdict === "WATCH" ? "Route var ama slippage/derinlik dikkat" :
      verdict === "RISK" ? "Fiyat etkisi yuksek; scout bile riskli" :
      "Jupiter route okunamadi; manuel fiyat kontrolu gerekir",
    source: "Jupiter quote v6"
  };
}

function tokenLifecycle(pair, scores = {}, riskFlags = []) {
  const ageMin = minutesSince(pair?.pairCreatedAt);
  const tx5 = Number(pair?.txns?.m5?.buys || 0) + Number(pair?.txns?.m5?.sells || 0);
  const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys24 = Number(pair?.txns?.h24?.buys || 0);
  const sells24 = Number(pair?.txns?.h24?.sells || 0);
  const liq = Number(pair?.liquidity?.usd || 0);
  const h1 = Number(pair?.priceChange?.h1 || 0);
  const h6 = Number(pair?.priceChange?.h6 || 0);
  const h24 = Number(pair?.priceChange?.h24 || 0);
  const sellPressure = sells24 > buys24 * 1.35 && sells24 > 25;
  let stage = "RADAR";
  if (ageMin !== null && ageMin < 45 && h1 > 15 && tx5 >= 5) stage = "LAUNCH";
  else if (h1 > 35 || h6 > 70 || tx1h > 180) stage = "PUMP";
  else if (sellPressure && (h1 < 8 || h6 < 20)) stage = "DISTRIBUTION";
  else if (h1 < -18 || h6 < -35 || h24 < -55) stage = "DUMP";
  else if ((ageMin !== null && ageMin > 10080 && tx1h < 5) || liq < 1200) stage = "DEAD";
  const confidence = clamp(
    (scores.overall || 0) * 0.32 +
    logScore(tx1h + tx5 * 4, 3, 260) * 0.28 +
    logScore(liq, 1000, 60000) * 0.18 +
    Math.min(18, Math.abs(h1) * 0.35 + Math.abs(h6) * 0.12) -
    Math.min(24, riskFlags.length * 4)
  );
  return {
    stage,
    confidence: Number(confidence.toFixed(1)),
    reasons: [
      ageMin === null ? "pair yasi bilinmiyor" : `pair yasi ${Math.round(ageMin)} dk`,
      `1s degisim ${h1.toFixed(1)}%`,
      `6s degisim ${h6.toFixed(1)}%`,
      `1s tx ${tx1h}`,
      `buy/sell ${buys24}/${sells24}`
    ],
    action:
      stage === "LAUNCH" ? "Erken ama riskli; sadece kapilar temizse scout" :
      stage === "PUMP" ? "FOMO riski var; ikinci onay ve trailing plan gerekir" :
      stage === "DISTRIBUTION" ? "Cuzdan cikislarini izle; yeni giris icin zayif" :
      stage === "DUMP" ? "Dususte yakalama denemesi degil; veri topla" :
      stage === "DEAD" ? "Aktivite zayif; copy kapali" :
      "Izle; henuz net evre yok"
  };
}

function sixGateTokenRisk({ pair, onchain, rugcheck, side, jupiter, scores }) {
  const liq = Number(pair?.liquidity?.usd || 0);
  const fdv = Number(pair?.fdv || pair?.marketCap || 0);
  const tx5 = Number(pair?.txns?.m5?.buys || 0) + Number(pair?.txns?.m5?.sells || 0);
  const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys24 = Number(pair?.txns?.h24?.buys || 0);
  const sells24 = Number(pair?.txns?.h24?.sells || 0);
  const paidOrders = (side?.orders || []).filter((order) => ["approved", "processing"].includes(String(order.status || "").toLowerCase())).length;
  const lpLockedPct = rugcheck?.lpLockedPct === null || rugcheck?.lpLockedPct === undefined ? null : Number(rugcheck.lpLockedPct);
  const rugRisks = Array.isArray(rugcheck?.risks) ? rugcheck.risks.length : 0;
  const gates = [
    {
      name: "Likidite",
      status: liq >= 5000 ? "PASS" : liq >= 2000 ? "WARN" : "FAIL",
      detail: `$${Math.round(liq).toLocaleString("en-US")} likidite`
    },
    {
      name: "Mint/Freeze",
      status: onchain?.mintAuthority || onchain?.freezeAuthority ? "FAIL" : "PASS",
      detail: onchain?.mintAuthority || onchain?.freezeAuthority ? "authority acik" : "authority kapali"
    },
    {
      name: "Holder",
      status: Number(onchain?.top1Pct || 0) > 35 || Number(onchain?.top10Pct || 0) > 82 ? "FAIL" : Number(onchain?.top10Pct || 0) > 65 ? "WARN" : "PASS",
      detail: `top1 ${Number(onchain?.top1Pct || 0).toFixed(1)}%, top10 ${Number(onchain?.top10Pct || 0).toFixed(1)}%`
    },
    {
      name: "Rug/LP",
      status: rugcheck?.rugged || rugRisks >= 3 || (lpLockedPct !== null && lpLockedPct < 25) ? "FAIL" : rugRisks || (lpLockedPct !== null && lpLockedPct < 50) ? "WARN" : "PASS",
      detail: rugcheck?.enabled ? `${rugRisks} risk, LP ${lpLockedPct === null ? "-" : lpLockedPct.toFixed(0) + "%"}` : "RugCheck veri yok"
    },
    {
      name: "Jupiter",
      status: !jupiter?.ok ? "WARN" : jupiter.verdict === "RISK" ? "FAIL" : jupiter.verdict === "WATCH" ? "WARN" : "PASS",
      detail: !jupiter?.ok ? "route okunamadi" : `impact ${jupiter.priceImpactPct ?? "-"}%, route ${jupiter.routeCount}`
    },
    {
      name: "Organik Akis",
      status: (paidOrders >= 2 || sells24 > buys24 * 1.5 || (fdv > 0 && liq / fdv < 0.008)) ? "WARN" : (tx5 + tx1h < 6 ? "FAIL" : "PASS"),
      detail: `tx ${tx5}/${tx1h}, paid ${paidOrders}, buy/sell ${buys24}/${sells24}`
    }
  ];
  const failed = gates.filter((gate) => gate.status === "FAIL").length;
  const warn = gates.filter((gate) => gate.status === "WARN").length;
  const passed = gates.filter((gate) => gate.status === "PASS").length;
  const gateScore = clamp(passed * 16 + warn * 7 - failed * 22 + Number(scores?.overall || 0) * 0.18);
  const grade = failed >= 2 ? "RISK" : failed === 1 || warn >= 3 ? "WATCH" : gateScore >= 82 ? "A" : gateScore >= 64 ? "B" : "WATCH";
  return {
    grade,
    score: Number(gateScore.toFixed(1)),
    passed,
    warn,
    failed,
    gates,
    verdict: failed ? `${failed} kapi kaldi` : warn ? `${warn} kapi sari` : "6 kapi temiz",
    action:
      failed >= 2 ? "Islem yok; once kalan kapilar temizlenmeli" :
      failed === 1 ? "Sadece izleme/scout; ana lot yok" :
      warn >= 3 ? "Teyit bekle; acele girme" :
      "Risk kapilari makul; yine de paper/scout disina cikma"
  };
}

function copyCrowdingForToken(mint, recentEvents = []) {
  const rows = (recentEvents || []).filter((event) => event.mint === mint);
  const buyers = new Set(rows.filter((event) => event.type === "BUY").map((event) => event.wallet).filter(Boolean));
  const sellers = new Set(rows.filter((event) => event.type === "SELL").map((event) => event.wallet).filter(Boolean));
  const openSignals = rows.filter((event) => event.type === "BUY").length - rows.filter((event) => event.type === "SELL").length;
  const pressure = clamp(buyers.size * 18 + openSignals * 6 - sellers.size * 16);
  const label =
    sellers.size >= buyers.size && sellers.size > 0 ? "CIKIS BASKISI" :
    buyers.size >= 3 ? "KALABALIK COPY" :
    buyers.size >= 1 ? "ERKEN TAKIP" :
    "BIZDE IZ YOK";
  return {
    score: Number(pressure.toFixed(1)),
    label,
    buyers: buyers.size,
    sellers: sellers.size,
    events: rows.length,
    action:
      label === "CIKIS BASKISI" ? "Cuzdanlar cikiyorsa biz de cikis senaryosu arariz" :
      label === "KALABALIK COPY" ? "Firsat olabilir ama gec kalma/slippage riski artar" :
      label === "ERKEN TAKIP" ? "Tek cuzdan teyidi; ikinci kaynak bekle" :
      "Bizim takip listesinde henuz hareket yok"
  };
}

function ammCrashSimulation({ pair, onchain }) {
  const liquidityUsd = Number(pair?.liquidity?.usd || 0);
  const priceUsd = Number(pair?.priceUsd || 0);
  const supply = Number(onchain?.supply || 0);
  const holders = Array.isArray(onchain?.holders) ? onchain.holders : [];
  const poolUsdSide = liquidityUsd / 2;
  const poolTokenApprox = priceUsd > 0 ? poolUsdSide / priceUsd : 0;
  const y = poolUsdSide;
  const topHolderSellPct = 0.5;
  const top3Pct = holders.slice(0, 3).reduce((sum, item) => sum + Number(item.pct || 0), 0);
  const top10Pct = Number(onchain?.top10Pct || 0);
  const simulatedPct = Math.max(top3Pct, Math.min(top10Pct, top3Pct + (top10Pct - top3Pct) * 0.55));
  const deltaTokens = supply > 0 ? supply * (simulatedPct / 100) * topHolderSellPct : 0;
  const poolTokens = Math.max(0, poolTokenApprox);
  const deltaY = poolTokens > 0 && y > 0 ? (y * deltaTokens) / (poolTokens + deltaTokens) : 0;
  const drainPct = y > 0 ? (deltaY / y) * 100 : 0;
  const newPrice = poolTokens + deltaTokens > 0 ? (y - deltaY) / (poolTokens + deltaTokens) : 0;
  const priceImpactPct = priceUsd > 0 && newPrice > 0 ? Math.max(0, (1 - newPrice / priceUsd) * 100) : null;
  const crashIndex = clamp(drainPct * 0.65 + (priceImpactPct || 0) * 0.25 + Math.max(0, 5000 - liquidityUsd) / 140);
  const verdict =
    drainPct >= 70 || crashIndex >= 82 ? "CRASH_RISK" :
    drainPct >= 45 || crashIndex >= 62 ? "FRAGILE" :
    drainPct >= 25 || crashIndex >= 42 ? "WATCH" :
    "OK";
  return {
    verdict,
    crashIndex: Number(crashIndex.toFixed(1)),
    liquidityUsd,
    simulatedHolderPct: Number(simulatedPct.toFixed(2)),
    assumedSellPct: topHolderSellPct * 100,
    estimatedSolSideUsd: Number(y.toFixed(2)),
    estimatedDrainUsd: Number(deltaY.toFixed(2)),
    drainPct: Number(drainPct.toFixed(1)),
    priceImpactPct: priceImpactPct === null ? null : Number(priceImpactPct.toFixed(1)),
    action:
      verdict === "CRASH_RISK" ? "Top holder satisinda havuz cokebilir; islem yok" :
      verdict === "FRAGILE" ? "Likidite kirilgan; sadece izleme/scout" :
      verdict === "WATCH" ? "Havuz orta kirilgan; lot kucuk kalmali" :
      "AMM sok simulasyonu makul"
  };
}

function ultraOnchainLayer(config = {}, { pair = null, onchain = null, ammShock = null } = {}) {
  const enabled = config.enableUltraOnchainLayer !== false;
  const geyserConfigured = Boolean(config.geyserGrpcEndpoint);
  const geyserTokenConfigured = Boolean(config.geyserAuthToken);
  const crashGatePct = Number(config.ultraCrashGatePct || 70);
  const crashFail = ammShock && Number(ammShock.drainPct || 0) >= crashGatePct;
  return {
    enabled,
    score: Number(clamp(
      55 +
      (ammShock ? (ammShock.verdict === "OK" ? 16 : ammShock.verdict === "WATCH" ? 4 : -20) : -4) +
      (config.enableGenesisTrace ? 8 : 0) +
      (config.enableBytecodeGuard ? 6 : 0) +
      (config.enableGeyserJitoLayer && geyserConfigured ? 10 : config.enableGeyserJitoLayer ? -4 : 0) -
      (crashFail ? 26 : 0)
    ).toFixed(1)),
    verdict: !enabled ? "KAPALI" : crashFail ? "KILIT" : geyserConfigured ? "ULTRA_AKTIF" : "AKTIF",
    gates: [
      {
        name: "AMM Crash Tolerance",
        status: !ammShock ? "WARN" : crashFail ? "FAIL" : ammShock.verdict === "OK" ? "PASS" : "WARN",
        detail: ammShock ? `drain ${ammShock.drainPct}% / impact ${ammShock.priceImpactPct ?? "-"}%` : "veri yok"
      },
      {
        name: "Genesis Trace",
        status: config.enableGenesisTrace ? "PASS" : "WARN",
        detail: config.enableGenesisTrace ? "ilk alici/fonlama agaci sistemde" : "kapali; kontrol panelinden acilabilir"
      },
      {
        name: "Jito/Geyser Feed",
        status: config.enableGeyserJitoLayer && geyserConfigured ? "PASS" : config.enableGeyserJitoLayer ? "WARN" : "WARN",
        detail: geyserConfigured ? `gRPC endpoint tanimli${geyserTokenConfigured ? " + token var" : ""}` : "endpoint yok; HTTP/RPC fallback"
      },
      {
        name: "Bytecode Guard",
        status: config.enableBytecodeGuard ? "PASS" : "WARN",
        detail: config.enableBytecodeGuard ? "Solana uyarlamali program/authority guard aktif" : "kapali; SPL/Token-2022 guard onerilir"
      }
    ],
    action:
      !enabled ? "Ultra katman kapali" :
      crashFail ? "AMM soku kirmizi; token alma" :
      geyserConfigured ? "Ultra veri hatti ana karar motoruna bagli" :
      "Ultra katman aktif; ozel feed yoksa public RPC fallback kullanilir",
    notes: [
    {
      name: "Bytecode / opcode analizi",
      status: config.enableBytecodeGuard ? "aktif" : "hazir",
      note: "Memecoinlerin cogu ozel sozlesme degil SPL mint kullanir. Bu yuzden EVM tipi opcode farki yerine mint/freeze authority, Token-2022 extension, pool programi ve creator davranisi izlenmeli."
    },
    {
      name: "AMM likidite soku",
      status: "aktif",
      note: "Top holder satis senaryosu x*y=k mantigiyla yaklasik simule edilir; havuzun yuzde kaci bosalabilir gosterilir."
    },
    {
      name: "Genesis trace",
      status: config.enableGenesisTrace ? "aktif" : "hazir",
      note: "Ilk alicilarin fonlama ebeveyni ve zaman korelasyonu icin Helius/Birdeye + RPC gecmis tarama gerekir; key geldiginde cüzdan agaci cikarilir."
    },
    {
      name: "Jito/Geyser",
      status: config.enableGeyserJitoLayer ? (geyserConfigured ? "aktif" : "endpoint bekliyor") : "hazir",
      note: `Yellowstone gRPC/Jito sinyali ana Ultra katmana bagli. Saglayici: ${config.geyserProvider || "secilmedi"}. Endpoint girilirse ana karar motorunda hiz teyidi olarak kullanilir.`
    }
  ]};
}

function walletClassifier(row = {}) {
  const wr = row.winRate === null || row.winRate === undefined ? null : Number(row.winRate);
  const pnl = Number(row.pnlSol || row.realizedSol || 0);
  const maxX = Number(row.maxX || 1);
  const early = Number(row.earlyHits || 0);
  const hits = Number(row.hits || row.closed || 0);
  const noise = Number(row.noiseRatio || 0);
  const open = Number(row.openLotCount || 0);
  const riskFlags = row.riskFlags || [];
  const fake = fakeSmartWalletFilter(row);
  let label = "WATCH";
  if (hits < 3 && early < 2) label = "YENI";
  if (early >= 4 && maxX >= 4 && pnl > 0) label = "SNIPER";
  if (pnl >= 8 && hits >= 5 && (wr === null || wr >= 55)) label = "SMART";
  if (maxX >= 12 && early >= 2 && open <= 4) label = "INSIDER-BENZERI";
  if ((wr !== null && wr < 38) || pnl < -2 || noise > 0.55 || riskFlags.length >= 3 || fake.grade === "FAKE") label = "DEGEN/RISK";
  if (hits >= 8 && open === 0 && pnl <= 0 && early <= 1) label = "DEAD";
  const score = clamp(
    34 +
    Math.min(18, early * 4) +
    Math.min(18, Math.log2(Math.max(1, maxX)) * 5) +
    Math.min(22, Math.max(-12, pnl * 2.2)) +
    (wr === null ? 0 : Math.max(-15, Math.min(16, (wr - 50) * 0.55))) -
    Math.min(22, noise * 22) -
    Math.min(18, riskFlags.length * 5) -
    Math.min(28, fake.penalty || 0)
  );
  return {
    label,
    score: Number(score.toFixed(1)),
    action:
      label === "SMART" || label === "SNIPER" ? "Alert/copy adayi; kucuk paper lotla test" :
      label === "INSIDER-BENZERI" ? "Tek basina agir girme; transfer/cikis cuzdanini da takip et" :
      label === "DEGEN/RISK" || label === "DEAD" ? "Copy kapali; sadece veri" :
      "Izle; ikinci sinyal bekle",
    reasons: [
      `${early} erken giris`,
      `${hits} hit`,
      `WR ${wr === null ? "-" : wr.toFixed(0) + "%"}`,
      `PnL ${pnl.toFixed(2)} SOL`,
      `max ${maxX.toFixed(1)}x`,
      `risk ${riskFlags.length}`,
      `fake ${fake.grade}`
    ],
    fakeSmart: fake
  };
}

function fakeSmartWalletFilter(row = {}) {
  const best = Array.isArray(row.best) ? row.best : [];
  const pnl = Math.max(0, Number(row.pnlSol || 0));
  const maxX = Number(row.maxX || 1);
  const early = Number(row.earlyHits || 0);
  const hits = Number(row.hits || row.closed || 0);
  const noise = Number(row.noiseRatio || 0);
  const flags = [];
  let passed = 0;
  let penalty = 0;

  const bestPnl = Math.max(0, ...best.map((trade) => Number(trade.pnlSol || trade.profitSol || trade.realizedSol || 0)).filter(Number.isFinite));
  const oneHitShare = pnl > 0 && bestPnl > 0 ? bestPnl / pnl : (hits <= 2 && maxX >= 8 ? 0.8 : 0);
  if (oneHitShare > 0.7 || (hits <= 2 && maxX >= 8)) {
    flags.push("ONE_HIT_WONDER");
    penalty += 18;
  } else {
    passed += 1;
  }

  if (early >= Math.max(2, Math.ceil(hits * 0.25))) passed += 1;
  else {
    flags.push("FOLLOWER_TIMING");
    penalty += 10;
  }

  if (noise > 0.55 || (row.riskFlags || []).some((flag) => /cluster|bundle|same fund|koord/i.test(String(flag)))) {
    flags.push("CLUSTER_OR_NOISE");
    penalty += 12;
  } else {
    passed += 1;
  }

  const grade = passed >= 3 ? "SMART_TEST_OK" : passed === 2 ? "WATCH" : passed === 1 ? "DEGEN" : "FAKE";
  return {
    grade,
    passed,
    penalty,
    oneHitShare: Number(oneHitShare.toFixed(2)),
    flags,
    action:
      grade === "SMART_TEST_OK" ? "tek vurus degil; yine de paper test" :
      grade === "WATCH" ? "alert modu; copy icin ek ornek bekle" :
      "copy kapali; sansli/koordine olma riski"
  };
}

function walletSixGate(row = {}) {
  const cls = walletClassifier(row);
  const wr = row.winRate === null || row.winRate === undefined ? null : Number(row.winRate);
  const pnl = Number(row.pnlSol || 0);
  const loss = Math.abs(Math.min(0, Number(row.biggestLossSol || 0)));
  const early = Number(row.earlyHits || 0);
  const hits = Number(row.hits || row.closed || 0);
  const noise = Number(row.noiseRatio || 0);
  const riskFlags = row.riskFlags || [];
  const fake = fakeSmartWalletFilter(row);
  const gates = [
    { name: "Basari", status: wr === null ? "WARN" : wr >= 55 ? "PASS" : wr >= 42 ? "WARN" : "FAIL", detail: `WR ${wr === null ? "-" : wr.toFixed(1) + "%"}` },
    { name: "Pozitif PnL", status: pnl > 1 ? "PASS" : pnl >= 0 ? "WARN" : "FAIL", detail: `${pnl.toFixed(2)} SOL` },
    { name: "Erken Yakalayis", status: early >= 3 ? "PASS" : early >= 1 ? "WARN" : "FAIL", detail: `${early} erken giris` },
    { name: "Ornek Sayisi", status: hits >= 8 ? "PASS" : hits >= 3 ? "WARN" : "FAIL", detail: `${hits} hit/kapanis` },
    { name: "Zarar Kontrolu", status: loss <= 1.2 ? "PASS" : loss <= 3 ? "WARN" : "FAIL", detail: `max zarar ${loss.toFixed(2)} SOL` },
    { name: "Gurultu", status: noise <= 0.35 && riskFlags.length <= 1 && fake.grade !== "FAKE" ? "PASS" : noise <= 0.6 && riskFlags.length <= 3 && fake.grade !== "FAKE" ? "WARN" : "FAIL", detail: `noise ${noise}, risk ${riskFlags.length}, fake ${fake.grade}` }
  ];
  const failed = gates.filter((gate) => gate.status === "FAIL").length;
  const warn = gates.filter((gate) => gate.status === "WARN").length;
  return {
    grade: failed >= 2 ? "RISK" : failed === 1 || warn >= 3 ? "WATCH" : cls.score >= 76 ? "A" : "B",
    classifier: cls,
    gates,
    passed: gates.filter((gate) => gate.status === "PASS").length,
    warn,
    failed,
    action:
      failed >= 2 ? "Copy kapali; bu cuzdan para yakabilir" :
      failed === 1 ? "Alert kalsin; copy icin erken" :
      "Kucuk paper lotla test edilebilir"
  };
}

function scoreResearchSignal(value, goodAt = 70, badAt = 35, inverse = false) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 50;
  const raw = inverse
    ? 100 - ((n - badAt) / Math.max(1, goodAt - badAt)) * 100
    : ((n - badAt) / Math.max(1, goodAt - badAt)) * 100;
  return clamp(raw);
}

function holderBundleProxy(onchain = {}) {
  const holders = onchain.holders || [];
  const top3 = holders.slice(0, 3).reduce((sum, item) => sum + Number(item.pct || 0), 0);
  const top5 = holders.slice(0, 5).reduce((sum, item) => sum + Number(item.pct || 0), 0);
  const top10 = Number(onchain.top10Pct || 0);
  let similarBuckets = 0;
  for (let i = 0; i < holders.length; i += 1) {
    for (let j = i + 1; j < holders.length; j += 1) {
      const a = Number(holders[i].pct || 0);
      const b = Number(holders[j].pct || 0);
      if (a > 1 && b > 1 && Math.abs(a - b) <= Math.max(0.25, Math.min(a, b) * 0.08)) similarBuckets += 1;
    }
  }
  const topValues = holders.slice(0, 10).map((item) => Number(item.pct || 0)).filter((value) => value > 0);
  const max = Math.max(0, ...topValues);
  const min = Math.min(...topValues.filter((value) => value > 0));
  const similarTopSpread = max > 0 && Number.isFinite(min) ? (max - min) / max : 1;
  const hardBundleScore =
    (top3 > 15 ? 40 : top3 > 10 ? 24 : 0) +
    (top10 > 40 ? 25 : top10 > 28 ? 14 : 0) +
    (similarTopSpread < 0.05 && topValues.length >= 4 ? 35 : similarTopSpread < 0.12 && topValues.length >= 4 ? 18 : 0) +
    Math.min(20, similarBuckets * 3);
  const risk = clamp(top3 * 1.2 + top5 * 0.35 + top10 * 0.18 + Math.min(28, similarBuckets * 3) + hardBundleScore * 0.35);
  return {
    score: Number((100 - risk).toFixed(1)),
    bundleScore: Number(clamp(hardBundleScore).toFixed(1)),
    top3Pct: Number(top3.toFixed(1)),
    top5Pct: Number(top5.toFixed(1)),
    top10Pct: Number(top10.toFixed(1)),
    similarBuckets,
    similarTopSpread: Number(similarTopSpread.toFixed(3)),
    verdict: hardBundleScore >= 80 ? "BUNDLE_KESIN" : hardBundleScore >= 60 || risk >= 62 ? "RISK" : risk >= 42 ? "WATCH" : "OK",
    note: hardBundleScore >= 80
      ? "Bundle kesin/siddetli suphe: top holder dagilimi manipule olabilir"
      : hardBundleScore >= 60
        ? "Bundle suphe: top holder dagilimi koordineli olabilir"
        : risk >= 62
      ? "Top holder yogunlugu/bundle proxy yuksek"
      : risk >= 42
        ? "Holder dagilimi orta riskli"
        : "Holder dagilimi hizli kontrolde makul"
  };
}

function buildResearchSignals({ pair, side, onchain, github, reddit, socialLinks, rugcheck, pumpfun, gecko, recentEvents }) {
  const ageMin = minutesSince(pair?.pairCreatedAt);
  const tx5 = Number(pair?.txns?.m5?.buys || 0) + Number(pair?.txns?.m5?.sells || 0);
  const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys24 = Number(pair?.txns?.h24?.buys || 0);
  const sells24 = Number(pair?.txns?.h24?.sells || 0);
  const volume24 = Number(pair?.volume?.h24 || 0);
  const liquidityUsd = Number(pair?.liquidity?.usd || 0);
  const fdv = Number(pair?.fdv || pair?.marketCap || 0);
  const volumeLiquidity = liquidityUsd > 0 ? volume24 / liquidityUsd : 0;
  const buyRatio = buys24 + sells24 > 0 ? buys24 / (buys24 + sells24) : 0.5;
  const matchingEvents = (recentEvents || []).filter((event) => event.mint === pair?.baseToken?.address);
  const uniqueBuyers = new Set(matchingEvents.filter((event) => event.type === "BUY").map((event) => event.wallet).filter(Boolean)).size;
  const uniqueSellers = new Set(matchingEvents.filter((event) => event.type === "SELL").map((event) => event.wallet).filter(Boolean)).size;
  const bundle = holderBundleProxy(onchain);
  const creatorTokens = Array.isArray(rugcheck?.creatorTokens) ? rugcheck.creatorTokens.length : 0;
  const rugRiskCount = Array.isArray(rugcheck?.risks) ? rugcheck.risks.length : 0;
  const boostTotal = Number(side?.boostTotalAmount || side?.boostAmount || 0);
  const paidOrders = (side?.orders || []).filter((order) => ["approved", "processing"].includes(String(order.status || "").toLowerCase())).length;
  const pumpAgeMin = pumpfun?.createdAt ? minutesSince(new Date(pumpfun.createdAt).getTime()) : null;

  const signals = [
    {
      name: "Launch Momentum",
      score: clamp(
        logScore(tx1h + tx5 * 3, 2, 350) * 0.35 +
        scoreResearchSignal(Number(pair?.priceChange?.h1 || 0), 45, -12) * 0.25 +
        scoreResearchSignal(volumeLiquidity, 8, 0.5) * 0.2 +
        (ageMin !== null && ageMin < 10 ? 12 : ageMin !== null && ageMin < 180 ? 18 : 8)
      ),
      signal: `tx5 ${tx5}, tx1s ${tx1h}, vol/liq ${volumeLiquidity.toFixed(1)}x`,
      danger: volumeLiquidity > 45 ? "hacim sisirme olabilir" : "momentum normal aralikta",
      source: "Pump tracker mantigi: zaman serisi, buy/sell, hacim ve yas"
    },
    {
      name: "Holder Bundle Proxy",
      score: bundle.score,
      signal: `top3 ${bundle.top3Pct}%, top5 ${bundle.top5Pct}%, benzer bucket ${bundle.similarBuckets}`,
      danger: bundle.note,
      source: "Rug/bundle tarayici mantigi: holder concentration + benzer dagilim"
    },
    {
      name: "Creator / Repeat Risk",
      score: clamp(100 - creatorTokens * 8 - rugRiskCount * 11 - (rugcheck?.rugged ? 45 : 0) - (pumpfun?.isBanned ? 35 : 0)),
      signal: `creator token ${creatorTokens || 0}, RugCheck risk ${rugRiskCount}`,
      danger: creatorTokens >= 6 ? "creator cok token cikarmis" : "creator gecmisi hizli kontrolde agir risk vermedi",
      source: "RugCheck/dev-history mantigi"
    },
    {
      name: "Smart Convergence",
      score: clamp(uniqueBuyers * 24 + Math.max(0, uniqueBuyers - uniqueSellers) * 12 + (matchingEvents.length ? 25 : 0)),
      signal: `${uniqueBuyers} takipli buyer, ${uniqueSellers} seller, ${matchingEvents.length} olay`,
      danger: uniqueSellers >= uniqueBuyers && uniqueSellers > 0 ? "takipli satis baskisi var" : "takipli alici baskisi daha iyi",
      source: "Bizim paper-event/cuzdan kumelenmesi"
    },
    {
      name: "Social / Dev Transparency",
      score: clamp(
        (socialLinks || []).length * 12 +
        Math.min(24, Number(reddit?.count || 0) * 5 + Number(reddit?.totalComments || 0) * 0.4) +
        Math.min(24, Number(github?.total || 0) * 3 + Number(github?.mintMentions || 0) * 8) +
        (pumpfun?.website ? 8 : 0) +
        (pumpfun?.twitter ? 8 : 0)
      ),
      signal: `${(socialLinks || []).length} sosyal link, reddit ${reddit?.count || 0}, github ${github?.total || 0}`,
      danger: (socialLinks || []).length === 0 && !github?.total ? "sosyal/dev iz zayif" : "iz var ama alaka manuel dogrulanmali",
      source: "GitHub repo scanner + sosyal varlik kontrolu"
    },
    {
      name: "Manipulation / Hype Guard",
      score: clamp(
        100 -
        paidOrders * 12 -
        Math.min(24, boostTotal / 25) -
        (buyRatio > 0.82 || buyRatio < 0.22 ? 14 : 0) -
        (fdv > 0 && liquidityUsd / fdv < 0.008 ? 18 : 0) -
        (volumeLiquidity > 35 ? 18 : 0)
      ),
      signal: `paid ${paidOrders}, boost ${boostTotal}, buyRatio ${(buyRatio * 100).toFixed(0)}%`,
      danger: paidOrders || boostTotal > 150 || volumeLiquidity > 35 ? "hype/manipulasyon filtresi dikkat" : "hype baskisi makul",
      source: "DexScreener order/boost + market microstructure"
    },
    {
      name: "Pump Curve / Graduation",
      score: clamp(
        (pumpfun?.enabled ? 30 : 0) +
        (pumpfun?.complete ? 24 : 8) +
        (gecko?.launchpad?.completed ? 16 : 0) +
        (pumpAgeMin !== null && pumpAgeMin < 45 ? 15 : 6) +
        Math.min(15, Number(pumpfun?.replyCount || 0) * 0.35)
      ),
      signal: pumpfun?.enabled ? `${pumpfun.complete ? "graduated" : "bonding"}, reply ${pumpfun.replyCount ?? "-"}` : "pump kaydi yok",
      danger: pumpfun?.nsfw || pumpfun?.isBanned ? "pump.fun bayragi riskli" : "launchpad izi normal",
      source: "Pump.fun tracker mantigi: curve/age/reply/graduation"
    }
  ].map((item) => ({
    ...item,
    score: Number(clamp(item.score).toFixed(1)),
    grade: item.score >= 78 ? "A" : item.score >= 60 ? "B" : item.score >= 42 ? "WATCH" : "RISK"
  }));

  const alphaScore = clamp(signals.reduce((sum, item) => sum + item.score, 0) / Math.max(1, signals.length));
  const killSwitches = signals.filter((item) => item.grade === "RISK").map((item) => item.name);
  return {
    alphaScore: Number(alphaScore.toFixed(1)),
    grade: alphaScore >= 78 && killSwitches.length === 0 ? "A" : alphaScore >= 64 && killSwitches.length <= 1 ? "B" : alphaScore >= 48 ? "WATCH" : "RISK",
    action: alphaScore >= 78 && killSwitches.length === 0
      ? "Scout + ikinci onay takip; risk kapilari temizse lot buyut"
      : alphaScore >= 64
        ? "Izle/scout; en zayif modulu duzeltmeden ana lot yok"
        : "Sadece radar; sinyal biriktir",
    killSwitches,
    signals,
    playbook: [
      "Yeni tokenlerde ilk 45 dakika icin curve, buy/sell, unique buyer ve top holder degisimi izlenmeli.",
      "Top holder yogunlugu ve benzer yuzdeler bundle/koordine alim proxy olarak cezalandirildi.",
      "Tek kaynakli hype yerine sosyal + cüzdan + market mikro-yapi birlesimi araniyor.",
      "Paid boost/order tek basina iyi sinyal degil; aktivite ve holder guveniyle birlikte anlamli."
    ]
  };
}

async function apiOracleToken(query = "") {
  const config = await readJson("config.json", {});
  const resolved = await resolveDexToken(query);
  if (!resolved.pair) {
    return {
      ok: false,
      query,
      error: "Token bulunamadi. Mint, DexScreener pair linki veya daha net sembol gir.",
      sources: oracleSourceNotes()
    };
  }

  const pair = resolved.pair;
  const mint = tokenAddressFromPair(pair, resolved.normalized.value);
  const symbol = pair.baseToken?.symbol || mint.slice(0, 6);
  const name = pair.baseToken?.name || symbol;
  const socialLinks = socialLinksFromPair(pair);
  const [side, llama, onchain, github, reddit, rugcheck, pumpfun, gecko, recentEvents, jupiter, birdeye] = await Promise.all([
    dexSideData(mint),
    defiLlamaOracleData(mint),
    tokenOnchainRisk(config, mint),
    githubTokenSignal(symbol, name, mint),
    redditTokenSignal(symbol, name, mint),
    rugCheckOracleData(mint),
    pumpFunOracleData(mint),
    geckoTerminalOracleData(mint),
    readEvents(1200),
    jupiterQuoteCheck(mint),
    config.enableBirdeyeFirstBuyers ? birdeyeTokenTrades(config, mint, 50) : Promise.resolve({ enabled: Boolean(birdeyeKey(config)), ok: false, error: "Birdeye ilk alici modulu kapali", trades: [] })
  ]);
  const scores = scoreOracle({ pair, side, llama, onchain, github, reddit, socialLinks, rugcheck, pumpfun, gecko });
  const research = buildResearchSignals({ pair, side, onchain, github, reddit, socialLinks, rugcheck, pumpfun, gecko, recentEvents });
  const lifecycle = tokenLifecycle(pair, scores, scores.riskFlags || []);
  const riskGate = sixGateTokenRisk({ pair, onchain, rugcheck, side, jupiter, scores });
  const copyCrowding = copyCrowdingForToken(mint, recentEvents);
  const ammShock = ammCrashSimulation({ pair, onchain });
  const ultraLayer = ultraOnchainLayer(config, { pair, onchain, ammShock });
  const xSearch = `https://x.com/search?q=${encodeURIComponent(`${symbol} ${mint} solana`)}&src=typed_query&f=live`;

  return {
    ok: true,
    query,
    resolvedBy: resolved.source,
    token: {
      mint,
      symbol,
      name,
      chainId: pair.chainId,
      dexId: pair.dexId,
      pairAddress: pair.pairAddress,
      url: pair.url,
      imageUrl: pair.info?.imageUrl || null,
      pairAgeMinutes: minutesSince(pair.pairCreatedAt)
    },
    market: {
      priceUsd: Number(pair.priceUsd || 0) || null,
      priceNative: Number(pair.priceNative || 0) || null,
      liquidityUsd: pair.liquidity?.usd ?? null,
      fdv: pair.fdv ?? null,
      marketCap: pair.marketCap ?? null,
      volume: pair.volume || {},
      txns: pair.txns || {},
      priceChange: pair.priceChange || {}
    },
    onchain,
    dex: side,
    rugcheck,
    pumpfun,
    gecko,
    defiLlama: llama,
    social: {
      links: socialLinks,
      xSearch
    },
    github,
    reddit,
    scores,
    research,
    lifecycle,
    riskGate,
    jupiter,
    birdeye,
    copyCrowding,
    ammShock,
    ultraLayer,
    ultraNotes: ultraLayer.notes,
    sources: oracleSourceNotes()
  };
}

async function readOracleWatchlist() {
  const data = await readJsonAnyEncoding("oracle-watchlist.json", { tokens: [] });
  const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
  const seen = new Set();
  return tokens
    .filter((item) => item?.query || item?.mint)
    .map((item) => ({
      query: String(item.query || item.mint || "").trim(),
      mint: item.mint || null,
      symbol: item.symbol || null,
      note: item.note || "",
      addedAt: item.addedAt || null,
      url: item.url || null
    }))
    .filter((item) => {
      const key = item.mint || item.query.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function writeOracleWatchlist(tokens) {
  await writeJson("oracle-watchlist.json", { updatedAt: new Date().toISOString(), tokens });
}

async function updateOracleWatchlist(body = {}) {
  const action = body.action || "add";
  const current = await readOracleWatchlist();
  if (action === "remove") {
    const key = String(body.mint || body.query || "").trim().toLowerCase();
    const tokens = current.filter((item) => String(item.mint || item.query).toLowerCase() !== key);
    await writeOracleWatchlist(tokens);
    oracleDiscoveryCache = { at: 0, value: null };
    return { ok: true, tokens };
  }

  const query = String(body.query || body.mint || "").trim();
  if (!query) throw new Error("token query required");
  const resolved = await resolveDexToken(query).catch(() => ({ pair: null, normalized: { value: query } }));
  const pair = resolved.pair || null;
  const mint = pair ? tokenAddressFromPair(pair, resolved.normalized?.value) : (looksSolanaAddress(query) ? query : null);
  const token = {
    query,
    mint,
    symbol: pair?.baseToken?.symbol || body.symbol || null,
    note: String(body.note || "").slice(0, 180),
    addedAt: new Date().toISOString(),
    url: pair?.url || null
  };
  const tokens = [
    token,
    ...current.filter((item) => String(item.mint || item.query).toLowerCase() !== String(token.mint || token.query).toLowerCase())
  ].slice(0, 80);
  await writeOracleWatchlist(tokens);
  oracleDiscoveryCache = { at: 0, value: null };
  return { ok: true, token, tokens };
}

function scoreDiscoveryPair(pair, seed) {
  const liquidityUsd = Number(pair?.liquidity?.usd || 0);
  const volume24 = Number(pair?.volume?.h24 || 0);
  const fdv = Number(pair?.fdv || pair?.marketCap || 0);
  const tx5 = Number(pair?.txns?.m5?.buys || 0) + Number(pair?.txns?.m5?.sells || 0);
  const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys24 = Number(pair?.txns?.h24?.buys || 0);
  const sells24 = Number(pair?.txns?.h24?.sells || 0);
  const ageMin = minutesSince(pair?.pairCreatedAt);
  const links = socialLinksFromPair(pair);
  const sources = [...(seed?.sources || [])];
  const sourceScore = clamp(
    sources.includes("manuel") * 28 +
    sources.includes("son sinyal") * 24 +
    sources.includes("profil") * 14 +
    sources.includes("boost") * 16 +
    sources.includes("top boost") * 18 +
    sources.includes("cto") * 18 +
    sources.includes("ad") * 6
  );
  const liquidityScore = logScore(liquidityUsd, 700, 90000);
  const activityScore = clamp(logScore(volume24, 2000, 700000) * 0.58 + logScore(tx1h + tx5 * 3, 3, 320) * 0.42);
  const momentumScore = clamp(
    50 +
    Number(pair?.priceChange?.m5 || 0) * 1.25 +
    Number(pair?.priceChange?.h1 || 0) * 0.78 +
    Number(pair?.priceChange?.h6 || 0) * 0.26 +
    Number(pair?.priceChange?.h24 || 0) * 0.1,
    0,
    100
  );
  const buyPressureScore = clamp(50 + ((buys24 - sells24) / Math.max(1, buys24 + sells24)) * 55);
  const socialScore = clamp(links.length * 12 + (links.some((link) => /twitter|x\.com|t\.me|telegram/i.test(link.url)) ? 18 : 0));
  const ageScore = ageMin === null ? 42 : ageMin < 5 ? 20 : ageMin < 30 ? 58 : ageMin < 720 ? 76 : ageMin < 4320 ? 58 : 34;
  const riskFlags = [];
  if (liquidityUsd < 1800) riskFlags.push("likidite dusuk");
  if (fdv > 0 && liquidityUsd / fdv < 0.008) riskFlags.push("liq/fdv zayif");
  if (tx5 < 2 && tx1h < 8) riskFlags.push("aktivite zayif");
  if (sells24 > buys24 * 1.5 && sells24 > 35) riskFlags.push("satis baskisi");
  if (ageMin !== null && ageMin < 5) riskFlags.push("asiri yeni");
  if (sources.includes("ad") && !sources.includes("son sinyal") && !sources.includes("manuel")) riskFlags.push("reklam kaynakli");
  const riskPenalty = Math.min(36, riskFlags.length * 8 + (liquidityUsd < 1000 ? 8 : 0));
  const score = clamp(
    sourceScore * 0.17 +
    liquidityScore * 0.17 +
    activityScore * 0.22 +
    momentumScore * 0.17 +
    buyPressureScore * 0.11 +
    socialScore * 0.08 +
    ageScore * 0.08 -
    riskPenalty
  );
  const lane =
    score >= 75 && sources.includes("son sinyal") ? "Smart sinyal + momentum" :
    score >= 72 && (sources.includes("boost") || sources.includes("top boost")) ? "Boost breakout" :
    sources.includes("cto") && score >= 58 ? "CTO canlanma" :
    Number(pair?.priceChange?.h1 || 0) > 35 && tx5 >= 10 ? "Hizli momentum" :
    socialLinksFromPair(pair).length >= 3 ? "Sosyal altyapi" :
    "Radar";
  const scoutPlan =
    score >= 78 && riskFlags.length === 0 ? "20-40 TL scout, ikinci onayda buyut" :
    score >= 62 && riskFlags.length <= 1 ? "sadece izleme/scout; wallet onayi bekle" :
    score >= 48 ? "alarm kur, acele alma" :
    "alma; sadece veri topla";
  const verdict =
    score >= 78 ? "A" :
    score >= 62 ? "B" :
    score >= 48 ? "WATCH" :
    "RISK";
  const action =
    verdict === "A" ? "Derin analiz + scout aday" :
    verdict === "B" ? "Izle, ikinci onayda scout" :
    verdict === "WATCH" ? "Radar; acele yok" :
    "Gurultu/riskli";
  return {
    score: Number(score.toFixed(1)),
    verdict,
    action,
    lane,
    scoutPlan,
    riskFlags,
    modules: {
      source: Number(sourceScore.toFixed(1)),
      liquidity: Number(liquidityScore.toFixed(1)),
      activity: Number(activityScore.toFixed(1)),
      momentum: Number(momentumScore.toFixed(1)),
      buyPressure: Number(buyPressureScore.toFixed(1)),
      social: Number(socialScore.toFixed(1)),
      age: Number(ageScore.toFixed(1)),
      riskPenalty: Number(riskPenalty.toFixed(1))
    }
  };
}

async function fetchDexPairsForMints(mints) {
  const pairs = [];
  for (let index = 0; index < mints.length; index += 30) {
    const chunk = mints.slice(index, index + 30);
    const data = await fetchJsonLoose(`https://api.dexscreener.com/tokens/v1/solana/${chunk.map(encodeURIComponent).join(",")}`, []);
    if (Array.isArray(data)) pairs.push(...data);
  }
  const found = new Set(pairs.map((pair) => pair?.baseToken?.address).filter(Boolean));
  const missing = mints.filter((mint) => mint && !found.has(mint)).slice(0, 20);
  for (const mint of missing) {
    const data = await fetchJsonLoose(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, { pairs: [] });
    if (Array.isArray(data?.pairs)) pairs.push(...data.pairs.filter((pair) => pair?.chainId === "solana"));
  }
  return pairs;
}

async function apiOracleDiscover(force = false) {
  if (!force && oracleDiscoveryCache.value && Date.now() - oracleDiscoveryCache.at < 60 * 1000) {
    return oracleDiscoveryCache.value;
  }

  const watchlist = await readOracleWatchlist();
  const events = await readEvents(220);
  const [profiles, boostsLatest, boostsTop, ctos, ads] = await Promise.all([
    fetchJsonLoose("https://api.dexscreener.com/token-profiles/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/token-boosts/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/token-boosts/top/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/community-takeovers/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/ads/latest/v1", [])
  ]);

  const seeds = new Map();
  const addSeed = (mint, source, meta = {}) => {
    if (!looksSolanaAddress(mint)) return;
    const previous = seeds.get(mint) || { mint, sources: new Set(), notes: [], lastSeenAt: null, meta: {} };
    previous.sources.add(source);
    if (meta.note) previous.notes.push(meta.note);
    if (meta.lastSeenAt && (!previous.lastSeenAt || new Date(meta.lastSeenAt) > new Date(previous.lastSeenAt))) previous.lastSeenAt = meta.lastSeenAt;
    previous.meta = { ...previous.meta, ...meta };
    seeds.set(mint, previous);
  };

  for (const item of watchlist) addSeed(item.mint || item.query, "manuel", { note: item.note, lastSeenAt: item.addedAt, query: item.query });
  for (const event of events) {
    if (event?.mint && event.type === "BUY") addSeed(event.mint, "son sinyal", { note: `${event.wallet || "-"} ${event.symbol || ""}`, lastSeenAt: event.time, url: event.url });
  }
  for (const item of Array.isArray(profiles) ? profiles : []) if (item?.chainId === "solana") addSeed(item.tokenAddress, "profil", { note: item.description, url: item.url });
  for (const item of Array.isArray(boostsLatest) ? boostsLatest : []) if (item?.chainId === "solana") addSeed(item.tokenAddress, "boost", { note: `boost ${item.amount || 0}`, url: item.url });
  for (const item of Array.isArray(boostsTop) ? boostsTop : []) if (item?.chainId === "solana") addSeed(item.tokenAddress, "top boost", { note: `top boost ${item.totalAmount || 0}`, url: item.url });
  for (const item of Array.isArray(ctos) ? ctos : []) if (item?.chainId === "solana") addSeed(item.tokenAddress, "cto", { note: "community takeover", url: item.url });
  for (const item of Array.isArray(ads) ? ads : []) if (item?.chainId === "solana") addSeed(item.tokenAddress, "ad", { note: item.type || "ad", url: item.url });

  const seedValues = [...seeds.values()]
    .map((seed) => ({ ...seed, sources: [...seed.sources], notes: [...new Set(seed.notes)].filter(Boolean).slice(0, 3) }))
    .sort((a, b) =>
      (b.sources.includes("manuel") ? 1 : 0) - (a.sources.includes("manuel") ? 1 : 0) ||
      (b.sources.includes("son sinyal") ? 1 : 0) - (a.sources.includes("son sinyal") ? 1 : 0) ||
      b.sources.length - a.sources.length
    )
    .slice(0, 70);

  const pairs = await fetchDexPairsForMints(seedValues.map((seed) => seed.mint));
  const bestByMint = new Map();
  for (const pair of pairs) {
    const mint = pair?.baseToken?.address;
    if (!mint || !seeds.has(mint)) continue;
    const previous = bestByMint.get(mint);
    if (!previous || Number(pair.liquidity?.usd || 0) > Number(previous.liquidity?.usd || 0)) bestByMint.set(mint, pair);
  }

  const previous = await readJsonAnyEncoding("oracle-discovery-result.json", { rows: [] });
  const previousByMint = new Map((previous?.rows || []).map((row) => [row.mint, row]));

  const rows = seedValues
    .map((seed) => {
      const pair = bestByMint.get(seed.mint);
      if (!pair) return null;
      const score = scoreDiscoveryPair(pair, seed);
      const previousRow = previousByMint.get(seed.mint) || null;
      const volume24 = pair.volume?.h24 ?? null;
      const liquidityUsd = pair.liquidity?.usd ?? null;
      const scoreDelta = previousRow ? Number((score.score - Number(previousRow.score || 0)).toFixed(1)) : null;
      const volumeDeltaPct = previousRow?.volume24 ? Number((((Number(volume24 || 0) / Number(previousRow.volume24 || 1)) - 1) * 100).toFixed(1)) : null;
      const liquidityDeltaPct = previousRow?.liquidityUsd ? Number((((Number(liquidityUsd || 0) / Number(previousRow.liquidityUsd || 1)) - 1) * 100).toFixed(1)) : null;
      return {
        mint: seed.mint,
        symbol: pair.baseToken?.symbol || seed.mint.slice(0, 6),
        name: pair.baseToken?.name || pair.baseToken?.symbol || "-",
        url: pair.url || seed.meta?.url || null,
        pairAddress: pair.pairAddress,
        sources: seed.sources,
        notes: seed.notes,
        lastSeenAt: seed.lastSeenAt,
        priceUsd: Number(pair.priceUsd || 0) || null,
        liquidityUsd,
        fdv: pair.fdv ?? pair.marketCap ?? null,
        volume24,
        volume24hUsd: volume24,
        marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
        tx5: Number(pair.txns?.m5?.buys || 0) + Number(pair.txns?.m5?.sells || 0),
        tx1h: Number(pair.txns?.h1?.buys || 0) + Number(pair.txns?.h1?.sells || 0),
        buys24: pair.txns?.h24?.buys || 0,
        sells24: pair.txns?.h24?.sells || 0,
        change5m: pair.priceChange?.m5 ?? null,
        change1h: pair.priceChange?.h1 ?? null,
        change24h: pair.priceChange?.h24 ?? null,
        ageMinutes: minutesSince(pair.pairCreatedAt),
        socialLinks: socialLinksFromPair(pair).length,
        scoreDelta,
        volumeDeltaPct,
        liquidityDeltaPct,
        ...score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || Number(b.volume24 || 0) - Number(a.volume24 || 0))
    .slice(0, 45);

  const result = {
    ok: true,
    now: new Date().toISOString(),
    watchlist,
    counts: {
      seeds: seeds.size,
      scored: rows.length,
      manual: watchlist.length,
      signals: events.filter((event) => event?.type === "BUY" && event?.mint).length
    },
    rows,
    sources: oracleSourceNotes()
  };
  await writeJson("oracle-discovery-result.json", result).catch(() => {});
  oracleDiscoveryCache = { at: Date.now(), value: result };
  return result;
}

function defaultSocialAccounts() {
  return [
    { username: "aixbt_agent", weight: 3, label: "AI alpha" },
    { username: "lookonchain", weight: 3, label: "onchain" },
    { username: "zachxbt", weight: 3, label: "risk/onchain" },
    { username: "OnchainLens", weight: 2, label: "onchain" },
    { username: "solana", weight: 2, label: "ecosystem" },
    { username: "JupiterExchange", weight: 2, label: "dex" },
    { username: "pumpdotfun", weight: 2, label: "launchpad" },
    { username: "gmgnai", weight: 2, label: "trading" }
  ];
}

function socialRadarConfig(config) {
  const accounts = Array.isArray(config.socialRadar?.accounts) && config.socialRadar.accounts.length
    ? config.socialRadar.accounts
    : defaultSocialAccounts();
  return {
    accounts: accounts.map((account) => ({
      username: String(account.username || "").replace(/^@/, "").trim(),
      weight: Number(account.weight || 1),
      label: account.label || ""
    })).filter((account) => account.username),
    redditSubreddits: config.socialRadar?.redditSubreddits || ["solana", "memecoins", "memecoinmoonshots", "CryptoMoonShots"],
    postsPerAccount: Number(config.socialRadar?.postsPerAccount || 5)
  };
}

function extractTokenMentions(text = "") {
  const mentions = [];
  const add = (type, value, raw = value) => {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    const key = `${type}:${normalized}`;
    if (mentions.some((item) => `${item.type}:${item.value}` === key)) return;
    mentions.push({ type, value: normalized, raw });
  };
  const body = String(text || "");
  for (const match of body.matchAll(/dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi)) add("dex-url", match[1], match[0]);
  for (const match of body.matchAll(/pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/gi)) add("mint", match[1], match[0]);
  for (const match of body.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)) add("mint", match[0]);
  for (const match of body.matchAll(/\$([A-Za-z][A-Za-z0-9_]{1,12})\b/g)) add("symbol", match[1].toUpperCase(), match[0]);
  return mentions.slice(0, 12);
}

function extractSocialEvents(text = "") {
  const body = String(text || "");
  const lower = body.toLowerCase();
  const eventRules = [
    { key: "politics", label: "Politik olay", re: /\b(trump|biden|election|president|senate|congress|tariff|war|putin|zelensky|iran|israel|gaza|ukraine)\b/i },
    { key: "celebrity", label: "Ünlü/viral kişi", re: /\b(elon|musk|tate|kanye|drake|ronaldo|messi|mrbeast|vitalik|cz|saylor)\b/i },
    { key: "ai", label: "AI anlatısı", re: /\b(ai|agent|openai|gpt|claude|llm|robot|neural|agi)\b/i },
    { key: "solana", label: "Solana ekosistem", re: /\b(solana|jupiter|pumpfun|pump\.fun|raydium|meteora|bonk|wif|launchpad)\b/i },
    { key: "scandal", label: "Skandal/risk olayı", re: /\b(hack|exploit|rug|scam|lawsuit|arrest|ban|leak|crash|rekt)\b/i },
    { key: "meme", label: "Meme/hype", re: /\b(meme|viral|trend|trending|mascot|cat|dog|frog|pepe|wojak|npc|send|moon)\b/i }
  ];
  const found = eventRules.filter((rule) => rule.re.test(lower));
  if (!found.length) return [];
  const hashtags = [...body.matchAll(/#([A-Za-z0-9_]{2,32})/g)].map((match) => match[1]).slice(0, 5);
  const symbols = [...body.matchAll(/\$([A-Za-z][A-Za-z0-9_]{1,12})\b/g)].map((match) => match[1].toUpperCase()).slice(0, 5);
  const words = [...body.matchAll(/\b[A-Z][A-Za-z0-9]{2,18}\b/g)]
    .map((match) => match[0])
    .filter((word) => !/^(The|This|That|Solana|Bitcoin|Crypto|Token|Breaking)$/i.test(word))
    .slice(0, 8);
  return found.map((rule) => ({
    key: rule.key,
    label: rule.label,
    hashtags,
    symbols,
    keywords: [...new Set([...hashtags, ...symbols, ...words])].slice(0, 10)
  }));
}

function scoreSocialEvent(group) {
  const posts = group.posts || [];
  const sourceWeight = posts.reduce((sum, post) => sum + Number(post.accountWeight || 1), 0);
  const uniqueAccounts = new Set(posts.map((post) => `${post.source}:${post.account}`)).size;
  const engagement = posts.reduce((sum, post) => {
    const m = post.metrics || {};
    return sum + Number(m.like_count || 0) + Number(m.retweet_count || 0) * 2 + Number(m.reply_count || 0) * 1.3 + Number(m.quote_count || 0) * 1.6;
  }, 0);
  const newest = posts
    .map((post) => post.createdAt ? new Date(post.createdAt).getTime() : 0)
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
  const ageMin = newest ? (Date.now() - newest) / 60000 : null;
  const freshness = ageMin === null ? 18 : ageMin <= 20 ? 34 : ageMin <= 90 ? 24 : ageMin <= 360 ? 14 : 6;
  const hasToken = group.tokenMentions > 0;
  const keywordCount = group.keywords.size;
  const score = clamp(
    Math.min(28, sourceWeight * 7) +
    Math.min(20, uniqueAccounts * 8) +
    Math.min(18, Math.log10(1 + engagement) * 8) +
    freshness +
    Math.min(12, keywordCount * 2) +
    (hasToken ? 14 : 0)
  );
  return {
    score: Number(score.toFixed(1)),
    grade: score >= 78 ? "A" : score >= 62 ? "B" : score >= 45 ? "WATCH" : "RISK",
    action:
      hasToken && score >= 72 ? "CA/sembol var; token analizine gönder" :
      score >= 68 ? "tokenleşme bekle; sembol/CA alarmı kur" :
      score >= 52 ? "sosyal radar izle" :
      "zayıf olay",
    sourceWeight: Number(sourceWeight.toFixed(1)),
    uniqueAccounts,
    engagement: Number(engagement.toFixed(1)),
    ageMinutes: ageMin,
    hasToken
  };
}

async function fetchXJson(config, url) {
  const token = xBearerToken(config);
  if (!token) return { enabled: false, data: null, error: "X API bearer token yok" };
  const data = await fetchJsonWithHeaders(url, { authorization: `Bearer ${token}` }, null, 12000);
  return { enabled: true, data, error: data ? null : "X API cevap vermedi veya limit" };
}

async function xAccountPosts(config, accounts) {
  if (!xBearerToken(config)) {
    return { enabled: false, posts: [], error: "X API key yok. Otomatik buyuk hesap tarama icin X_BEARER_TOKEN veya config.xBearerToken gerekli." };
  }
  const usernames = accounts.map((account) => account.username).filter(Boolean).slice(0, 100);
  if (!usernames.length) return { enabled: true, posts: [], error: "hesap listesi bos" };
  const usersRes = await fetchXJson(config, `https://api.x.com/2/users/by?usernames=${encodeURIComponent(usernames.join(","))}&user.fields=public_metrics,verified,verified_type`);
  const users = usersRes.data?.data || [];
  const accountByUsername = new Map(accounts.map((account) => [account.username.toLowerCase(), account]));
  const posts = [];
  const errors = [];
  for (const user of users) {
    const account = accountByUsername.get(String(user.username || "").toLowerCase()) || { weight: 1 };
    const url = `https://api.x.com/2/users/${user.id}/tweets?max_results=${Math.max(5, Math.min(20, Number(config.socialRadar?.postsPerAccount || 5)))}&exclude=retweets,replies&tweet.fields=created_at,public_metrics,entities`;
    const tweetsRes = await fetchXJson(config, url);
    if (tweetsRes.error) errors.push(`${user.username}: ${tweetsRes.error}`);
    for (const tweet of tweetsRes.data?.data || []) {
      posts.push({
        source: "x",
        account: user.username,
        accountName: user.name,
        accountWeight: Number(account.weight || 1),
        accountLabel: account.label || "",
        verified: Boolean(user.verified),
        text: tweet.text || "",
        createdAt: tweet.created_at,
        url: `https://x.com/${user.username}/status/${tweet.id}`,
        metrics: tweet.public_metrics || {}
      });
    }
  }
  return { enabled: true, posts, error: errors.join(" | ") || null };
}

async function redditSocialPosts(subreddits) {
  const posts = [];
  for (const sub of subreddits.slice(0, 8)) {
    const data = await fetchJsonLoose(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=20`, { data: { children: [] } }, 9000);
    for (const child of data?.data?.children || []) {
      const post = child.data || {};
      posts.push({
        source: "reddit",
        account: `r/${post.subreddit || sub}`,
        accountName: post.subreddit || sub,
        accountWeight: 0.8,
        accountLabel: "public subreddit",
        text: `${post.title || ""}\n${post.selftext || ""}\n${post.url || ""}`,
        createdAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : post.url,
        metrics: { like_count: post.score || 0, reply_count: post.num_comments || 0 }
      });
    }
  }
  return posts;
}

function scoreSocialMention(group, pair = null) {
  const sourceWeight = group.posts.reduce((sum, post) => sum + Number(post.accountWeight || 1), 0);
  const uniqueAccounts = new Set(group.posts.map((post) => `${post.source}:${post.account}`)).size;
  const newest = group.posts
    .map((post) => post.createdAt ? new Date(post.createdAt).getTime() : 0)
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
  const ageMin = newest ? (Date.now() - newest) / 60000 : null;
  const engagement = group.posts.reduce((sum, post) => {
    const m = post.metrics || {};
    return sum + Number(m.like_count || 0) + Number(m.retweet_count || 0) * 2 + Number(m.reply_count || 0) * 1.3 + Number(m.quote_count || 0) * 1.6;
  }, 0);
  const directCa = group.mentions.some((mention) => mention.type === "mint" || mention.type === "dex-url");
  const emptyHype = group.posts.some((post) => /\b(gm|soon|wagmi|send it|moon)\b/i.test(post.text || "")) && !directCa;
  const pairScore = pair ? scoreDiscoveryPair(pair, { sources: ["buyuk hesap"], notes: [] }).score : 0;
  const freshnessScore = ageMin === null ? 20 : ageMin <= 15 ? 100 : ageMin <= 60 ? 75 : ageMin <= 360 ? 45 : 20;
  const score = clamp(
    Math.min(35, sourceWeight * 9) +
    Math.min(20, uniqueAccounts * 8) +
    Math.min(18, Math.log10(1 + engagement) * 9) +
    freshnessScore * 0.16 +
    (directCa ? 16 : 0) +
    pairScore * 0.25 -
    (emptyHype ? 16 : 0)
  );
  const verdict = score >= 78 ? "A" : score >= 62 ? "B" : score >= 45 ? "WATCH" : "RISK";
  const action =
    verdict === "A" ? "hemen derin analiz + ikinci sosyal/cuzdan onayi" :
    verdict === "B" ? "radara al, fiyat/holder kontrol et" :
    verdict === "WATCH" ? "sadece izle; CA netlesmeden alma" :
    "gurultu veya zayif sosyal sinyal";
  return {
    score: Number(score.toFixed(1)),
    verdict,
    action,
    uniqueAccounts,
    sourceWeight: Number(sourceWeight.toFixed(1)),
    engagement: Number(engagement.toFixed(1)),
    ageMinutes: ageMin,
    directCa,
    emptyHype
  };
}

async function apiSocialRadar(force = false) {
  if (!force && socialRadarCache.value && Date.now() - socialRadarCache.at < 90 * 1000) return socialRadarCache.value;
  const config = await readJson("config.json", {});
  const radar = socialRadarConfig(config);
  const [xPosts, redditPosts] = await Promise.all([
    xAccountPosts(config, radar.accounts),
    redditSocialPosts(radar.redditSubreddits).catch(() => [])
  ]);
  const allPosts = [...(xPosts.posts || []), ...redditPosts];
  const groups = new Map();
  const eventGroups = new Map();
  for (const post of allPosts) {
    const mentions = extractTokenMentions(post.text);
    for (const mention of mentions) {
      const key = mention.type === "symbol" ? `symbol:${mention.value}` : `token:${mention.value}`;
      const group = groups.get(key) || { key, primary: mention, mentions: [], posts: [] };
      group.mentions.push(mention);
      group.posts.push(post);
      groups.set(key, group);
    }
    const socialEvents = extractSocialEvents(post.text);
    for (const event of socialEvents) {
      const key = `event:${event.key}:${(event.keywords[0] || event.label).toLowerCase()}`;
      const group = eventGroups.get(key) || {
        key,
        type: event.key,
        label: event.label,
        posts: [],
        keywords: new Set(),
        symbols: new Set(),
        hashtags: new Set(),
        tokenMentions: 0
      };
      group.posts.push(post);
      for (const keyword of event.keywords || []) group.keywords.add(keyword);
      for (const symbol of event.symbols || []) group.symbols.add(symbol);
      for (const tag of event.hashtags || []) group.hashtags.add(tag);
      group.tokenMentions += mentions.length;
      eventGroups.set(key, group);
    }
  }

  const addressMentions = [...groups.values()]
    .filter((group) => group.primary.type !== "symbol")
    .map((group) => group.primary.value)
    .filter(looksSolanaAddress)
    .slice(0, 50);
  const pairRows = await fetchDexPairsForMints(addressMentions);
  const pairByMint = new Map();
  for (const pair of pairRows) {
    const mint = pair?.baseToken?.address;
    if (!mint) continue;
    const prev = pairByMint.get(mint);
    if (!prev || Number(pair.liquidity?.usd || 0) > Number(prev.liquidity?.usd || 0)) pairByMint.set(mint, pair);
  }

  const rows = [...groups.values()].map((group) => {
    const mint = group.primary.type === "symbol" ? null : group.primary.value;
    const pair = mint ? pairByMint.get(mint) : null;
    const score = scoreSocialMention(group, pair);
    return {
      key: group.key,
      mint,
      symbol: pair?.baseToken?.symbol || (group.primary.type === "symbol" ? group.primary.value : mint?.slice(0, 6)),
      name: pair?.baseToken?.name || "-",
      url: pair?.url || null,
      sources: [...new Set(group.posts.map((post) => post.source))],
      accounts: [...new Map(group.posts.map((post) => [`${post.source}:${post.account}`, post])).values()].slice(0, 8).map((post) => ({
        source: post.source,
        account: post.account,
        weight: post.accountWeight,
        label: post.accountLabel,
        url: post.url,
        createdAt: post.createdAt
      })),
      posts: group.posts.slice(0, 5).map((post) => ({
        source: post.source,
        account: post.account,
        text: String(post.text || "").slice(0, 240),
        url: post.url,
        createdAt: post.createdAt
      })),
      liquidityUsd: pair?.liquidity?.usd ?? null,
      volume24: pair?.volume?.h24 ?? null,
      change1h: pair?.priceChange?.h1 ?? null,
      tx5: pair ? Number(pair.txns?.m5?.buys || 0) + Number(pair.txns?.m5?.sells || 0) : null,
      ...score
    };
  }).sort((a, b) => b.score - a.score).slice(0, 35);

  const result = {
    ok: true,
    now: new Date().toISOString(),
    x: {
      enabled: xPosts.enabled,
      error: xPosts.error,
      accounts: radar.accounts.map((account) => ({ username: account.username, weight: account.weight, label: account.label }))
    },
    counts: {
      posts: allPosts.length,
      xPosts: (xPosts.posts || []).length,
      redditPosts: redditPosts.length,
      mentions: rows.length
    },
    rows,
    narratives: [...eventGroups.values()].map((group) => {
      const score = scoreSocialEvent(group);
      const keywords = [...group.keywords].slice(0, 8);
      const symbols = [...group.symbols].slice(0, 5);
      return {
        key: group.key,
        type: group.type,
        label: group.label,
        title: keywords.slice(0, 3).join(" / ") || group.label,
        keywords,
        symbols,
        hashtags: [...group.hashtags].slice(0, 5),
        posts: group.posts.slice(0, 4).map((post) => ({
          source: post.source,
          account: post.account,
          text: String(post.text || "").slice(0, 220),
          url: post.url,
          createdAt: post.createdAt
        })),
        ...score
      };
    }).sort((a, b) => b.score - a.score).slice(0, 20),
    sources: oracleSourceNotes()
  };
  await writeJson("social-radar-result.json", result).catch(() => {});
  socialRadarCache = { at: Date.now(), value: result };
  return result;
}

function trendNarrativeBucket(text = "") {
  const body = String(text || "").toLowerCase();
  const rules = [
    ["AI / agent", /\b(ai|agent|gpt|openai|claude|llm|robot|neural|agi)\b/],
    ["Meme / viral", /\b(meme|viral|trend|send|moon|pepe|wojak|npc|mascot)\b/],
    ["Politik / makro", /\b(trump|biden|election|tariff|war|iran|israel|gaza|ukraine|putin|fed|rate)\b/],
    ["Launchpad / yeni cikan", /\b(pump|launch|fair launch|cto|community takeover|presale|bonding)\b/],
    ["Hayvan / maskot", /\b(cat|dog|frog|goat|shark|monkey|ape|penguin|chicken)\b/],
    ["DeFi / yield", /\b(defi|yield|staking|restaking|lending|dex|swap|lp|vault)\b/],
    ["Gaming / NFT", /\b(game|gaming|nft|metaverse|play|collectible)\b/],
    ["RWA / kurum", /\b(rwa|real world|treasury|bond|stock|institution|fund)\b/],
    ["Risk / hack", /\b(hack|exploit|rug|scam|drain|lawsuit|arrest|ban|leak)\b/],
    ["Solana ekosistem", /\b(solana|jupiter|raydium|meteora|bonk|wif|pump\.fun)\b/]
  ];
  return rules.filter(([, re]) => re.test(body)).map(([name]) => name);
}

function chainDisplayName(chainId = "") {
  const key = String(chainId || "").toLowerCase();
  const names = {
    solana: "Solana",
    ethereum: "Ethereum",
    base: "Base",
    bsc: "BNB Chain",
    arbitrum: "Arbitrum",
    polygon: "Polygon",
    avalanche: "Avalanche",
    sui: "Sui",
    ton: "TON",
    blast: "Blast",
    optimism: "Optimism"
  };
  return names[key] || chainId || "-";
}

function addTrendScore(map, key, patch = {}) {
  if (!key) return;
  const row = map.get(key) || {
    key,
    name: patch.name || key,
    score: 0,
    count: 0,
    sources: new Set(),
    notes: [],
    examples: [],
    liquidityUsd: 0,
    volume24: 0,
    tvlUsd: 0,
    change1d: null,
    change7d: null
  };
  row.score += Number(patch.score || 0);
  row.count += Number(patch.count || 1);
  row.name = patch.name || row.name;
  row.liquidityUsd += Number(patch.liquidityUsd || 0);
  row.volume24 += Number(patch.volume24 || 0);
  row.tvlUsd = Math.max(Number(row.tvlUsd || 0), Number(patch.tvlUsd || 0));
  if (patch.change1d !== null && patch.change1d !== undefined) row.change1d = Number(patch.change1d);
  if (patch.change7d !== null && patch.change7d !== undefined) row.change7d = Number(patch.change7d);
  for (const source of patch.sources || []) row.sources.add(source);
  for (const note of patch.notes || []) if (note && row.notes.length < 6) row.notes.push(String(note).slice(0, 90));
  for (const example of patch.examples || []) if (example && row.examples.length < 6) row.examples.push(example);
  map.set(key, row);
}

function finalizeTrendRows(map, limit = 12) {
  return [...map.values()]
    .map((row) => {
      const score = clamp(row.score + Math.min(16, Math.log10(1 + row.volume24) * 3) + Math.min(10, row.count * 1.6));
      return {
        ...row,
        score: Number(score.toFixed(1)),
        heat: score >= 82 ? "atesli" : score >= 68 ? "yukseliyor" : score >= 54 ? "izle" : "zayif",
        grade: score >= 82 ? "A+" : score >= 68 ? "A" : score >= 54 ? "B" : score >= 40 ? "WATCH" : "RISK",
        sources: [...row.sources],
        notes: [...new Set(row.notes)].slice(0, 5),
        examples: row.examples.slice(0, 5)
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function apiTrendMap(force = false) {
  if (!force && trendMapCache.value && Date.now() - trendMapCache.at < 90 * 1000) return trendMapCache.value;
  const [profiles, boostsLatest, boostsTop, ctos, ads, chains, social, discover] = await Promise.all([
    fetchJsonLoose("https://api.dexscreener.com/token-profiles/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/token-boosts/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/token-boosts/top/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/community-takeovers/latest/v1", []),
    fetchJsonLoose("https://api.dexscreener.com/ads/latest/v1", []),
    fetchJsonLoose("https://api.llama.fi/chains", []),
    apiSocialRadar(false).catch(() => ({ rows: [], narratives: [], counts: {} })),
    apiOracleDiscover(false).catch(() => ({ rows: [], counts: {} }))
  ]);

  const chainMap = new Map();
  const narrativeMap = new Map();
  const sourceRows = [
    ...(Array.isArray(profiles) ? profiles : []).map((item) => ({ ...item, trendSource: "profile", trendWeight: 7 })),
    ...(Array.isArray(boostsLatest) ? boostsLatest : []).map((item) => ({ ...item, trendSource: "boost", trendWeight: 13 + Math.min(18, Number(item.amount || 0) / 10) })),
    ...(Array.isArray(boostsTop) ? boostsTop : []).map((item) => ({ ...item, trendSource: "top boost", trendWeight: 16 + Math.min(22, Number(item.totalAmount || 0) / 25) })),
    ...(Array.isArray(ctos) ? ctos : []).map((item) => ({ ...item, trendSource: "cto", trendWeight: 14 })),
    ...(Array.isArray(ads) ? ads : []).map((item) => ({ ...item, trendSource: "ad", trendWeight: 9 }))
  ];

  for (const item of sourceRows) {
    const chain = String(item.chainId || "").toLowerCase();
    const text = [item.description, item.header, item.url, item.type, item.tokenAddress].filter(Boolean).join(" ");
    addTrendScore(chainMap, chain, {
      name: chainDisplayName(chain),
      score: Number(item.trendWeight || 0),
      sources: [item.trendSource],
      notes: [item.description || item.type || item.trendSource],
      examples: item.url ? [{ label: item.tokenAddress?.slice(0, 6) || item.trendSource, url: item.url }] : []
    });
    for (const bucket of trendNarrativeBucket(text)) {
      addTrendScore(narrativeMap, bucket, {
        name: bucket,
        score: Number(item.trendWeight || 0),
        sources: [`DexScreener ${item.trendSource}`],
        notes: [item.description || item.type || chainDisplayName(chain)],
        examples: item.url ? [{ label: `${chainDisplayName(chain)} ${item.tokenAddress?.slice(0, 6) || ""}`.trim(), url: item.url }] : []
      });
    }
  }

  for (const row of discover.rows || []) {
    addTrendScore(chainMap, "solana", {
      name: "Solana",
      score: Math.max(4, Number(row.score || 0) / 9),
      sources: row.sources || ["Solana token avi"],
      notes: [`${row.symbol || "-"} ${row.lane || ""}`.trim()],
      examples: row.url ? [{ label: row.symbol || row.mint?.slice(0, 6), url: row.url }] : [],
      liquidityUsd: row.liquidityUsd,
      volume24: row.volume24
    });
    const text = [row.symbol, row.name, row.notes?.join(" "), row.sources?.join(" ")].join(" ");
    for (const bucket of trendNarrativeBucket(text)) {
      addTrendScore(narrativeMap, bucket, {
        name: bucket,
        score: Math.max(6, Number(row.score || 0) / 8),
        sources: ["Solana token avi"],
        notes: [`${row.symbol || "-"} skor ${Number(row.score || 0).toFixed(0)}`],
        examples: row.url ? [{ label: row.symbol || row.mint?.slice(0, 6), url: row.url }] : [],
        liquidityUsd: row.liquidityUsd,
        volume24: row.volume24
      });
    }
  }

  for (const event of social.narratives || []) {
    const score = Number(event.score || 0);
    const buckets = trendNarrativeBucket([event.title, event.label, (event.keywords || []).join(" "), (event.symbols || []).join(" ")].join(" "));
    for (const bucket of buckets.length ? buckets : [event.label || "Sosyal olay"]) {
      addTrendScore(narrativeMap, bucket, {
        name: bucket,
        score: Math.max(8, score / 3),
        sources: ["X/Reddit sosyal radar"],
        notes: [`${event.title || event.label} / ${event.action || "izle"}`],
        examples: (event.posts || []).slice(0, 2).map((post) => ({ label: post.account || post.source, url: post.url }))
      });
    }
  }

  for (const chain of Array.isArray(chains) ? chains : []) {
    const key = String(chain.name || chain.gecko_id || chain.tokenSymbol || "").toLowerCase();
    const chainId =
      /solana/.test(key) ? "solana" :
      /base/.test(key) ? "base" :
      /ethereum/.test(key) ? "ethereum" :
      /bsc|binance/.test(key) ? "bsc" :
      /arbitrum/.test(key) ? "arbitrum" :
      /polygon/.test(key) ? "polygon" :
      /avalanche/.test(key) ? "avalanche" :
      /sui/.test(key) ? "sui" :
      /ton/.test(key) ? "ton" :
      null;
    if (!chainId) continue;
    const change1d = chain.change_1d ?? chain.change1d ?? (chain.tvlPrevDay ? ((Number(chain.tvl || 0) / Math.max(1, Number(chain.tvlPrevDay || chain.tvl || 1))) - 1) * 100 : null);
    const change7d = chain.change_7d ?? chain.change7d ?? (chain.tvlPrevWeek ? ((Number(chain.tvl || 0) / Math.max(1, Number(chain.tvlPrevWeek || chain.tvl || 1))) - 1) * 100 : null);
    addTrendScore(chainMap, chainId, {
      name: chainDisplayName(chainId),
      score: Math.min(18, Math.log10(1 + Number(chain.tvl || 0))) + Math.max(0, Number(change1d || 0)) * 1.8 + Math.max(0, Number(change7d || 0)) * 0.8,
      sources: ["DeFiLlama chain TVL"],
      notes: [`TVL $${fmtNumberShort(chain.tvl || 0)}${change1d !== null ? ` / 1g ${Number(change1d).toFixed(1)}%` : ""}`],
      tvlUsd: chain.tvl,
      change1d,
      change7d
    });
  }

  const chainsOut = finalizeTrendRows(chainMap, 10);
  const narrativesOut = finalizeTrendRows(narrativeMap, 12);
  const topChain = chainsOut[0] || null;
  const topNarrative = narrativesOut[0] || null;
  const migration = chainsOut.slice(0, 5).map((row, index) => ({
    rank: index + 1,
    chain: row.name,
    heat: row.heat,
    score: row.score,
    reason: row.notes[0] || `${row.sources.join(", ")} sicakligi`
  }));
  const result = {
    ok: true,
    now: new Date().toISOString(),
    chains: chainsOut,
    narratives: narrativesOut,
    migration,
    verdict: topChain && topNarrative
      ? `Ruzgar ${topChain.name} tarafinda, anlatida ${topNarrative.name} one cikiyor.`
      : "Trend haritasi veri bekliyor.",
    counts: {
      dexRows: sourceRows.length,
      socialNarratives: social.narratives?.length || 0,
      solanaDiscoveries: discover.rows?.length || 0,
      chainsSeen: Array.isArray(chains) ? chains.length : 0
    },
    sources: [
      "DexScreener profiles/boosts/top boosts/CTO/ads",
      "DeFiLlama chain TVL",
      "X/Reddit sosyal anlatilar",
      "Solana token avi ve paper sinyal hafizasi"
    ]
  };
  trendMapCache = { at: Date.now(), value: result };
  await writeJson("trend-map-result.json", result).catch(() => {});
  return result;
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function explainBlocker(reason = "") {
  const text = String(reason || "");
  if (/watched/i.test(text)) return "Cuzdan alert modunda; copy acik degil.";
  if (/needs \d+ wallet confirm/i.test(text)) return "Coklu cuzdan onayi bekleniyor; tek iyi sinyal bile alima donmuyor.";
  if (/auto demoted|wallet penalty|global loss brake|daily guard/i.test(text)) return "Performans freni aktif; zarar gordugu icin sistem kendini kitliyor.";
  if (/no open paper position/i.test(text)) return "Satis geldi ama bizde acik pozisyon yok; sinyal gec kalmis veya sadece izleme modunda.";
  if (/price pending|no price|exit price/i.test(text)) return "Fiyat bulunamadi veya gec geldi; no-price kapisi firsati bekletiyor.";
  if (/liquidity|volume|tx low|pair too/i.test(text)) return "Likidite/hacim/yas kalite kapisi gecilemedi.";
  if (/top holder|freeze|mint authority|RugCheck|LP/i.test(text)) return "Token guvenlik kapisi risk gordu.";
  if (/mcap/i.test(text)) return "Market cap limiti veya fiyatlama filtresi takildi.";
  if (/slot full|max open|cooldown|already open/i.test(text)) return "Portfoy slotu, cooldown veya tekrar pozisyon kapisi kapatti.";
  if (/sell pressure/i.test(text)) return "Satis baskisi veto etti.";
  return "Diger/karma engel; detay logdan incelenmeli.";
}

function opportunityFromDiscovery(row) {
  const blockerRisk = (row.riskFlags || []).length * 5;
  const score = clamp(Number(row.score || 0) + (row.sources || []).length * 3 + Number(row.scoreDelta || 0) * 0.8 - blockerRisk);
  return {
    key: `discover:${row.mint}`,
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    url: row.url,
    score: Number(score.toFixed(1)),
    grade: score >= 82 ? "A+" : score >= 72 ? "A" : score >= 60 ? "B" : score >= 45 ? "WATCH" : "RISK",
    lane: row.lane || "Otomatik av",
    source: "Otomatik Token Avi",
    why: [
      `skor ${Number(row.score || 0).toFixed(1)}`,
      `kaynak ${(row.sources || []).join(", ") || "-"}`,
      row.change1h !== null && row.change1h !== undefined ? `1s ${Number(row.change1h).toFixed(1)}%` : null,
      row.tx5 !== null && row.tx5 !== undefined ? `5dk tx ${row.tx5}` : null,
      row.liquidityUsd ? `liq $${Math.round(row.liquidityUsd).toLocaleString("en-US")}` : null
    ].filter(Boolean),
    risk: row.riskFlags || [],
    plan: row.scoutPlan || row.action || "Derin analiz + izleme",
    liquidityUsd: row.liquidityUsd,
    volume24: row.volume24,
    ageMinutes: row.ageMinutes,
    change1h: row.change1h
  };
}

function opportunityFromSocial(row) {
  const hasCa = Boolean(row.mint);
  const score = clamp(Number(row.score || 0) + (hasCa ? 8 : -18) + Number(row.uniqueAccounts || 0) * 2);
  return {
    key: `social:${row.key}`,
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    url: row.url,
    score: Number(score.toFixed(1)),
    grade: score >= 82 ? "A+" : score >= 72 ? "A" : score >= 60 ? "B" : score >= 45 ? "WATCH" : "RISK",
    lane: hasCa ? "Sosyal + CA yakalandi" : "Sosyal sembol; CA bekle",
    source: "Buyuk Hesap Radar",
    why: [
      `sosyal skor ${Number(row.score || 0).toFixed(1)}`,
      `${row.uniqueAccounts || 0} hesap`,
      `etki ${Number(row.engagement || 0).toFixed(0)}`,
      hasCa ? "CA/link var" : "sadece sembol"
    ],
    risk: hasCa ? [] : ["CA netlesmeden alim yok"],
    plan: row.action || "Sosyal teyit bekle",
    liquidityUsd: row.liquidityUsd,
    volume24: row.volume24,
    ageMinutes: row.ageMinutes,
    change1h: row.change1h
  };
}

function opportunityFromSignal(row) {
  const score = clamp(Number(row.score || 0) + Number(row.copyBuyers || 0) * 9 - Number(row.uniqueSellers || 0) * 5);
  return {
    key: `signal:${row.mint}`,
    mint: row.mint,
    symbol: row.symbol,
    name: row.symbol,
    url: row.url,
    score: Number(score.toFixed(1)),
    grade: score >= 82 ? "A+" : score >= 72 ? "A" : score >= 60 ? "B" : score >= 45 ? "WATCH" : "RISK",
    lane: "Canli cuzdan sinyal kumelenmesi",
    source: "Paper Event Radar",
    why: [
      `${row.uniqueBuyers || 0} buyer`,
      `${row.copyBuyers || 0} copy buyer`,
      `${row.uniqueSellers || 0} seller`,
      (row.skippedReasons || [])[0] ? `engel: ${(row.skippedReasons || [])[0]}` : null
    ].filter(Boolean),
    risk: row.skippedReasons || [],
    plan: row.score >= 70 ? "Kapi engelini incele; scout aday olabilir" : "Daha fazla onay bekle",
    liquidityUsd: null,
    volume24: null,
    ageMinutes: null,
    change1h: null
  };
}

async function apiOracleOpportunity(force = false) {
  const [stateData, discover, social] = await Promise.all([
    cachedApiState(0),
    apiOracleDiscover(force),
    apiSocialRadar(force).catch((error) => ({ ok: false, rows: [], error: error?.message || String(error), counts: {} }))
  ]);
  const events = stateData.events || [];
  const recentSkips = events.filter((event) => event.paper?.skipped);
  const blockerRows = countBy(recentSkips, (event) => event.paper?.skipped)
    .slice(0, 12)
    .map((row) => ({
      ...row,
      explain: explainBlocker(row.name),
      severity:
        /auto demoted|global loss|daily guard/i.test(row.name) ? "sert fren" :
        /needs \d+ wallet confirm|watched|price pending|no price/i.test(row.name) ? "firsat kacirabilir" :
        /top holder|freeze|mint authority|liquidity|volume/i.test(row.name) ? "koruyucu filtre" :
        "bilgi"
    }));

  const opportunities = [
    ...(discover.rows || []).map(opportunityFromDiscovery),
    ...(social.rows || []).map(opportunityFromSocial),
    ...(stateData.signalRadar || []).map(opportunityFromSignal)
  ];
  const best = new Map();
  for (const item of opportunities) {
    if (!item.mint && !item.symbol) continue;
    const key = item.mint || `symbol:${item.symbol}`;
    const prev = best.get(key);
    if (!prev || item.score > prev.score) best.set(key, item);
    else {
      prev.why = [...new Set([...(prev.why || []), ...(item.why || [])])].slice(0, 8);
      prev.source = [...new Set(String(prev.source).split(" + ").concat(item.source))].join(" + ");
    }
  }
  const rows = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 35);

  const config = stateData.config || {};
  const activeCopyWallets = (config.wallets || []).filter((wallet) => wallet.mode === "copy" && wallet.enabled !== false);
  const alertWallets = (config.wallets || []).filter((wallet) => wallet.mode === "alert" && wallet.enabled !== false);
  const walletDoctor = (stateData.walletStats || []).slice(0, 20).map((wallet) => {
    const wr = wallet.paperSells ? (Number(wallet.wins || 0) / Number(wallet.paperSells || 1)) * 100 : null;
    const issue =
      wallet.mode !== "copy" ? "alert mod: sinyal alima donmez" :
      wallet.autoDemoted?.blockedUntil ? `auto demote: ${wallet.autoDemoted.reason}` :
      wallet.cooldownLeftSec > 0 ? `cooldown ${wallet.cooldownLeftSec}s` :
      wallet.openPositions >= (config.maxOpenPerWallet || 99) ? "wallet slot dolu" :
      wallet.paperSells >= 3 && wr !== null && wr < 35 ? `dusuk WR ${wr.toFixed(0)}%` :
      "aktif";
    const action =
      wallet.mode !== "copy" && Number(wallet.score || 0) >= 75 ? "copy test icin aday ama once 20-40 TL scout" :
      /auto demote|dusuk WR/i.test(issue) ? "pasif/alert kalsin, degistirilecek aday ara" :
      issue === "aktif" ? "izlemeye devam" :
      "engel bitince tekrar degerlendir";
    return {
      name: wallet.name,
      address: wallet.address,
      mode: wallet.mode,
      score: wallet.score,
      paperBuys: wallet.paperBuys,
      paperSells: wallet.paperSells,
      realizedTry: wallet.realizedTry,
      winRate: wr,
      lastSignalAt: wallet.lastSignalAt,
      issue,
      action
    };
  });

  const tuning = [
    {
      name: "Coklu onay kapisi",
      current: config.requireMultiWalletConfirm ? `${config.confirmMinWallets || 2} cuzdan / ${config.confirmWindowMin || 12} dk` : "kapali",
      impact: blockerRows.find((row) => /needs \d+ wallet confirm/i.test(row.name))?.count || 0,
      suggestion: config.requireMultiWalletConfirm ? "Scout modda tek A/A+ sinyal icin 20-40 TL izin ver; ana lot yine 2. onayda." : "Zaten gevsek."
    },
    {
      name: "Cuzdan modlari",
      current: `${activeCopyWallets.length} copy / ${alertWallets.length} alert`,
      impact: blockerRows.find((row) => /watched/i.test(row.name))?.count || 0,
      suggestion: "Alert cüzdanlar sinyal uretir ama almaz; en iyi 1-2 tanesine mini scout copy ver."
    },
    {
      name: "No price/fiyat gecikmesi",
      current: `${stateData.riskGuards?.pendingPriceSignals || 0} bekleyen`,
      impact: blockerRows.filter((row) => /price pending|no price/i.test(row.name)).reduce((sum, row) => sum + row.count, 0),
      suggestion: "Fiyat yoksa alima zorlama; ama panelde aday sicakligini tut ve fiyat gelince tekrar puanla."
    },
    {
      name: "Risk freni",
      current: config.globalLossBrake ? "aktif" : "kapali",
      impact: blockerRows.filter((row) => /auto demoted|global loss|daily guard/i.test(row.name)).reduce((sum, row) => sum + row.count, 0),
      suggestion: "Fren iyi; ama iyi cüzdan avini ayri modda surdur, copy listesi kendi kendini yenilesin."
    }
  ];

  return {
    ok: true,
    now: new Date().toISOString(),
    rows,
    blockers: blockerRows,
    walletDoctor,
    tuning,
    sourceHealth: [
      { name: "DexScreener profiles/boosts/ads/CTO", status: discover.ok ? "aktif" : "hata", found: discover.counts?.seeds || 0 },
      { name: "Buyuk Hesap Radar", status: social.ok ? "aktif" : "hata", found: social.counts?.mentions || 0 },
      { name: "Paper Event Radar", status: "aktif", found: (stateData.signalRadar || []).length },
      { name: "RugCheck/Gecko/Pump.fun", status: "token analizde aktif", found: "derin analizde" },
      { name: "X API", status: social.x?.enabled ? "aktif" : "key yok", found: social.counts?.xPosts || 0 }
    ],
    counts: {
      opportunities: rows.length,
      blockers: recentSkips.length,
      copyWallets: activeCopyWallets.length,
      alertWallets: alertWallets.length,
      openPositions: stateData.mtm?.positions?.length || 0
    }
  };
}

function oracleSourceNotes() {
  return [
    { name: "DexScreener", status: "public", use: "fiyat, likidite, hacim, tx, paid order, boost, sosyal link", link: "https://docs.dexscreener.com/api/reference" },
    { name: "RugCheck", status: "public / rate-limit olabilir", use: "risk listesi, LP lock, creator, holder, insider graph, rugged bayragi", link: "https://api.rugcheck.xyz" },
    { name: "GitHub solana-rugchecker fikirleri", status: "arastirma referansi", use: "metadata, top holder, liquidity ve rug score mantigi laboratuvar modullerine tasindi", link: "https://github.com/degenfrends/solana-rugchecker" },
    { name: "GitHub pump.fun tracker fikirleri", status: "arastirma referansi", use: "bonding curve, buy/sell pressure, unique buyer, top3 concentration ve bot/whale mantigi", link: "https://github.com/boluwatifee4/pump.fun-Token-tracker" },
    { name: "MemeTrans arastirmasi", status: "akademik referans", use: "context, trading activity, holder concentration, time-series ve bundle-level risk sinyalleri", link: "https://arxiv.org/abs/2602.13480" },
    { name: "Pump.fun", status: "public endpoint", use: "creator, graduation, ATH mcap, reply/live, launchpad sosyal linkleri", link: "https://pump.fun" },
    { name: "GeckoTerminal", status: "public", use: "rezerv, FDV, launchpad completion ve top pool dogrulama", link: "https://www.geckoterminal.com/dex-api" },
    { name: "Solana RPC", status: "public/config", use: "supply, largest holders, mint/freeze authority", link: "https://solana.com/docs/rpc" },
    { name: "DeFiLlama", status: "public", use: "token price varsa ve Solana genel TVL/stablecoin arka planı", link: "https://docs.llama.fi/coin-prices-api" },
    { name: "GitHub", status: "public rate-limit", use: "repo/kontrat/topluluk geliştirme izi; isim benzerliği olabilir", link: "https://docs.github.com/en/rest/search/search" },
    { name: "Reddit", status: "public JSON", use: "son sosyal tartışma izleri; spam ve alakasız sonuç olabilir", link: "https://www.reddit.com/dev/api/" },
    { name: "X/Twitter", status: "opsiyonel API", use: "X bearer token varsa buyuk hesap postlarini otomatik tarar; key yoksa sahte veri uretmez", link: "https://docs.x.com/x-api" }
  ];
}

async function runFreeAlphaScan() {
  if (freeAlphaScanInFlight) {
    const current = await readJsonAnyEncoding("free-alpha-radar-result.json", { wallets: [], clusters: [], hunter: {} });
    const status = await readJsonAnyEncoding("free-alpha-radar-status.json", {});
    return {
      ok: true,
      running: true,
      message: "Tarama zaten çalışıyor; mevcut son sonuç gösteriliyor.",
      wallets: (current?.wallets || []).slice(0, 10),
      clusters: (current?.clusters || []).slice(0, 10),
      hunter: current?.hunter || {},
      status
    };
  }
  const startedAt = new Date().toISOString();
  const env = {
    ...process.env,
    ALPHA_MAX_TOKENS: process.env.ALPHA_MAX_TOKENS || "16",
    ALPHA_SIGS_PER_PAIR: process.env.ALPHA_SIGS_PER_PAIR || "38",
    ALPHA_TX_SAMPLE_PER_WALLET: process.env.ALPHA_TX_SAMPLE_PER_WALLET || "70",
    ALPHA_MAX_PROFILED_WALLETS: process.env.ALPHA_MAX_PROFILED_WALLETS || "20"
  };
  freeAlphaScanInFlight = execFileAsync(process.execPath, ["free-alpha-radar.mjs"], {
    env,
    timeout: 420000,
    maxBuffer: 1024 * 1024 * 4
  });
  try {
    const { stdout, stderr } = await freeAlphaScanInFlight;
    const result = await readJsonAnyEncoding("free-alpha-radar-result.json", { wallets: [], clusters: [], hunter: {} });
    const status = await readJsonAnyEncoding("free-alpha-radar-status.json", {});
    return {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: stdout.slice(-3000),
      stderr: stderr.slice(-3000),
      wallets: (result?.wallets || []).slice(0, 10),
      clusters: (result?.clusters || []).slice(0, 10),
      hunter: result?.hunter || {},
      status
    };
  } finally {
    freeAlphaScanInFlight = null;
  }
}

async function maybeAutoFreeAlphaScan(reason = "auto") {
  if (freeAlphaScanInFlight) return;
  const minAgeMs = 8 * 60 * 1000;
  try {
    const stat = await fs.stat("free-alpha-radar-result.json");
    if (Date.now() - stat.mtimeMs < minAgeMs) return;
  } catch {}
  runFreeAlphaScan()
    .then((result) => {
      console.log(`[free-alpha:${reason}] wallets=${result.wallets?.length || 0} clusters=${result.clusters?.length || 0}`);
    })
    .catch((error) => {
      console.error(`[free-alpha:${reason}]`, error?.message || String(error));
    });
}

function walletHunterRules() {
  return [
    { name: "Smart wallet", rule: "Pozitif PnL/WR yeterli degil; anlamli buyuklukte lot, max buy, ortalama buy ve zarar kontrolu birlikte aranir.", source: "GMGN/Photon mantigi + money-flow conviction", weight: "alphaScore + convictionScore" },
    { name: "Sniper", rule: "Ilk dakikalarda alir ama buyuk para izi yoksa kucuk sniper sayilir, smart/insider listesine cikamaz.", source: "First buyers / top 70 buyers yaklasimi", weight: "sniperScore - dustPenalty" },
    { name: "Insider-benzeri", rule: "Erken giris + yuksek carpan + buyuk/anormal alis buyuklugu gerekir; kimlik iddiasi degil davranis etiketidir.", source: "GMGN Insider/Sniper/First 70 Buyers + conviction", weight: "insiderScore + convictionScore" },
    { name: "Convergence", rule: "Ayni tokende 2+ kaliteli erken alici varsa token cluster skoru yukselir.", source: "Wallet convergence alerts", weight: "clusterScore" },
    { name: "Anti-bot fren", rule: "Cok fazla acik lot, az kapanis, buyuk zarar, her tokene atlama ve eski aktivite cezalandirilir.", source: "Copy-trading survivorship/noise filtresi", weight: "riskFlags" }
  ];
}

function hunterWalletAddress(row = {}) {
  return row.wallet || row.address || "";
}

function normalizeHunterWallet(row = {}, categories = []) {
  const alpha = Number(row.alphaScore || row.score || 0);
  const insider = Number(row.insiderScore || 0);
  const sniper = Number(row.sniperScore || 0);
  const conviction = Number(row.convictionScore || 0);
  const repeatability = Number(row.repeatabilityScore || 0);
  const survival = Number(row.survivalScore || 0);
  const copySafety = Number(row.copySafetyScore || 0);
  const proof = Number(row.proofScore || 0);
  const maxX = Number(row.maxX || 1);
  const pnl = Number(row.pnlSol || 0);
  const wr = row.winRate === null || row.winRate === undefined ? null : Number(row.winRate);
  const closed = Number(row.closed || 0);
  const riskFlags = row.riskFlags || [];
  const samplePenalty = closed < 3 ? 12 : closed < 6 ? 6 : 0;
  const lossPenalty = Math.max(0, Math.abs(Math.min(0, Number(row.biggestLossSol || 0))) - 0.5) * 8;
  const riskPenalty = Math.min(30, riskFlags.length * 7 + lossPenalty + samplePenalty);
  const dustPenalty = row.dustSniper ? 18 : 0;
  const total = clamp(
    alpha * 0.24 +
    insider * 0.14 +
    sniper * 0.1 +
    conviction * 0.16 +
    repeatability * 0.12 +
    survival * 0.1 +
    copySafety * 0.1 +
    proof * 0.08 +
    Math.min(10, Math.log2(Math.max(1, maxX)) * 4) +
    Math.min(8, Math.max(0, pnl) * 1.6) -
    riskPenalty -
    dustPenalty
  );
  const grade = total >= 82 ? "A+" : total >= 70 ? "A" : total >= 56 ? "B" : total >= 42 ? "WATCH" : "RISK";
  const mode =
    grade === "A+" && pnl > 0 && riskFlags.length <= 1 ? "copy-mini" :
    grade === "A" && riskFlags.length <= 2 ? "alert-scout" :
    grade === "B" ? "alert" :
    "watch-only";
  return {
    wallet: hunterWalletAddress(row),
    categories: [...new Set([...(categories || []), ...(row.archetypes || [])])],
    totalScore: Number(total.toFixed(1)),
    grade,
    mode,
    alphaScore: Number(alpha.toFixed(1)),
    insiderScore: Number(insider.toFixed(1)),
    sniperScore: Number(sniper.toFixed(1)),
    convictionScore: Number(conviction.toFixed(1)),
    repeatabilityScore: Number(repeatability.toFixed(1)),
    survivalScore: Number(survival.toFixed(1)),
    copySafetyScore: Number(copySafety.toFixed(1)),
    proofScore: Number(proof.toFixed(1)),
    profile: row.profile || "-",
    action: row.action || (mode === "copy-mini" ? "mini copy test + siki risk" : mode === "alert-scout" ? "alert; tek A+ sinyalde scout" : "sadece izle"),
    lotTry: mode === "copy-mini" ? Math.max(40, Number(row.lotTry || 70)) : mode === "alert-scout" ? Math.max(25, Number(row.lotTry || 45)) : 0,
    hits: Number(row.hits || 0),
    earlyHits: Number(row.earlyHits || 0),
    earliestSec: row.earliestSec ?? null,
    avgEarlySec: row.avgEarlySec ?? null,
    winRate: wr,
    closed,
    pnlSol: Number(pnl.toFixed(4)),
    maxX: Number(maxX.toFixed(2)),
    spentSol: Number(row.spentSol || 0),
    totalBuySol: Number(row.totalBuySol || 0),
    maxBuySol: Number(row.maxBuySol || 0),
    maxEarlyBuySol: Number(row.maxEarlyBuySol || 0),
    avgBuySol: Number(row.avgBuySol || 0),
    medianBuySol: Number(row.medianBuySol || 0),
    avgEarlyBuySol: Number(row.avgEarlyBuySol || 0),
    dustSniper: Boolean(row.dustSniper),
    funding: row.funding || null,
    tokens: row.tokens || [],
    riskFlags,
    reasons: row.reasons || [
      `${row.hits || 0} token`,
      `${row.earlyHits || 0} erken giris`,
      `WR ${wr === null ? "-" : wr.toFixed(0) + "%"}`,
      `PnL ${pnl.toFixed(2)} SOL`,
      `max ${maxX.toFixed(1)}x`
      ,
      `proof ${proof.toFixed(0)}`,
      `copySafety ${copySafety.toFixed(0)}`
    ]
  };
}

function buildHunterRows(freeAlpha = {}) {
  const map = new Map();
  const add = (row, category) => {
    const wallet = hunterWalletAddress(row);
    if (!wallet) return;
    const prev = map.get(wallet);
    const merged = normalizeHunterWallet(row, prev ? [...prev.categories, category] : [category]);
    if (prev) {
      merged.tokens = [...new Set([...(prev.tokens || []), ...(merged.tokens || [])])].slice(0, 10);
      merged.riskFlags = [...new Set([...(prev.riskFlags || []), ...(merged.riskFlags || [])])].slice(0, 8);
      merged.categories = [...new Set([...(prev.categories || []), ...(merged.categories || [])])];
    }
    map.set(wallet, !prev || merged.totalScore >= prev.totalScore ? merged : { ...prev, categories: merged.categories, tokens: merged.tokens, riskFlags: merged.riskFlags });
  };
  for (const row of freeAlpha?.wallets || []) add(row, "ranked");
  for (const row of freeAlpha?.hunter?.smartWallets || []) add(row, "smart");
  for (const row of freeAlpha?.hunter?.sniperWallets || []) add(row, "sniper");
  for (const row of freeAlpha?.hunter?.insiderLikeWallets || []) add(row, "insider-benzeri");
  for (const row of freeAlpha?.hunter?.suggestedWatchlist || []) add(row, "onerilen");
  return [...map.values()]
    .map((row) => ({
      ...row,
      classifier: walletClassifier(row),
      walletGate: walletSixGate(row)
    }))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 40);
}

async function enrichHunterRowsWithCielo(config, rows = []) {
  if (!config.enableCieloPnl || !cieloKey(config)) return rows;
  const enriched = [];
  for (const row of rows.slice(0, 12)) {
    const cielo = await cieloWalletPnl(config, row.wallet).catch((error) => ({
      enabled: true,
      ok: false,
      error: error?.message || String(error)
    }));
    if (cielo.ok) {
      const winRate = cielo.winRate ?? row.winRate;
      const closed = Math.max(Number(row.closed || 0), Number(cielo.closed || 0));
      const pnlSolApprox = Number(row.pnlSol || 0) || Number(cielo.realizedUsd || 0) / 180;
      const bonus = Math.min(24, Math.max(0, Number(cielo.realizedUsd || 0)) / 250 + (winRate ? Math.max(0, winRate - 50) * 0.28 : 0));
      const totalScore = clamp(Number(row.totalScore || 0) + bonus);
      enriched.push({
        ...row,
        totalScore: Number(totalScore.toFixed(1)),
        grade: totalScore >= 82 ? "A+" : totalScore >= 70 ? "A" : totalScore >= 56 ? "B" : totalScore >= 42 ? "WATCH" : row.grade,
        winRate,
        closed,
        pnlSol: Number(pnlSolApprox.toFixed(4)),
        cielo,
        profile: row.profile === "BEKLE" && closed ? "CIELO_DOGRULU" : row.profile,
        reasons: [
          `Cielo WR ${winRate === null || winRate === undefined ? "-" : Number(winRate).toFixed(0) + "%"}`,
          `Cielo PnL $${Number(cielo.realizedUsd || 0).toFixed(0)}`,
          `Cielo token ${cielo.tokenCount || 0}`,
          ...(row.reasons || [])
        ].slice(0, 8)
      });
    } else {
      enriched.push({
        ...row,
        cielo,
        reasons: [`Cielo: ${cielo.error || "veri yok"}`, ...(row.reasons || [])].slice(0, 8)
      });
    }
  }
  return [
    ...enriched,
    ...rows.slice(12)
  ].sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0));
}

async function apiWalletHunter(force = false) {
  const config = await readJson("config.json", {});
  const current = await readJsonAnyEncoding("free-alpha-radar-result.json", { wallets: [], clusters: [], hunter: {} });
  const scanStatus = await readJsonAnyEncoding("free-alpha-radar-status.json", {});
  const createdAt = current?.createdAt || null;
  const ageMin = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 60000 : Infinity;
  const stale = !createdAt || ageMin > 45;
  if ((force || stale) && !freeAlphaScanInFlight) {
    runFreeAlphaScan()
      .then((result) => console.log(`[wallet-hunter] wallets=${result.wallets?.length || 0} clusters=${result.clusters?.length || 0}`))
      .catch((error) => console.error("[wallet-hunter]", error?.message || String(error)));
  }
  const rows = await enrichHunterRowsWithCielo(config, buildHunterRows(current));
  const clusters = (current?.clusters || []).slice(0, 25).map((cluster) => ({
    symbol: cluster.symbol,
    mint: cluster.mint,
    url: cluster.url,
    clusterScore: cluster.clusterScore,
    smartCount: cluster.smartCount,
    strongCount: cluster.strongCount,
    riskyCount: cluster.riskyCount,
    action: cluster.action,
    buyers: (cluster.buyers || []).slice(0, 5)
  }));
  return {
    ok: true,
    running: Boolean(freeAlphaScanInFlight),
    stale,
    lastScanAt: createdAt,
    scanStatus,
    ageMinutes: Number.isFinite(ageMin) ? Number(ageMin.toFixed(1)) : null,
    rows,
    wallets: rows,
    clusters,
    rules: walletHunterRules(),
    counts: {
      wallets: rows.length,
      clusters: clusters.length,
      smart: current?.hunter?.smartWallets?.length || 0,
      sniper: current?.hunter?.sniperWallets?.length || 0,
      insider: current?.hunter?.insiderLikeWallets?.length || 0
    },
    sourceNotes: [
      "Token evreni DexScreener profile/boost/top boost/CTO/ads + trend search + bizim paper event hafizasindan baslar.",
      "Pair imzalarindan erken alicilar cikarilir; tekrar eden ilk alicilar ve anlamli SOL harcayanlar aday olur.",
      "Aday cuzdanlarda daha genis tx ornegiyle PnL/WR/maxX/noise/buy-size yaklasik hesaplanir.",
      "Cielo aktifse ilk adaylar Cielo PnL/WR ile ikinci kez dogrulanir.",
      "GMGN'deki Smart/Sniper/Insider mantigi birebir etiket iddiasi degil; zincir-ustu davranis skoru olarak uygulanir."
    ]
  };
}

let autoWalletHunterTimer = null;

function startAutoWalletHunterLoop() {
  if (autoWalletHunterTimer) return;
  const tick = () => {
    maybeAutoFreeAlphaScan("timer").catch((error) => {
      console.error("[free-alpha:timer]", error?.message || String(error));
    });
  };
  setTimeout(tick, 15000).unref();
  autoWalletHunterTimer = setInterval(tick, 12 * 60 * 1000);
  autoWalletHunterTimer.unref();
}

function edgeGrade(score) {
  return score >= 86 ? "A+" : score >= 74 ? "A" : score >= 62 ? "B" : score >= 48 ? "WATCH" : "RISK";
}

function edgeMode(score, hardRisk = false) {
  if (hardRisk) return "engel";
  if (score >= 86) return "scout-copy";
  if (score >= 74) return "alert-scout";
  if (score >= 62) return "watch-hot";
  if (score >= 48) return "watch";
  return "ignore";
}

function compactReason(items = []) {
  return items.filter(Boolean).slice(0, 6);
}

function alphaGrade(score) {
  return score >= 88 ? "A+" : score >= 76 ? "A" : score >= 64 ? "B" : score >= 52 ? "WATCH" : "RISK";
}

function alphaDecision(score, kill = false) {
  if (kill) return "ALMA";
  if (score >= 88) return "SCOUT";
  if (score >= 76) return "RADAR SICAK";
  if (score >= 64) return "TEYIT BEKLE";
  return "SADECE IZLE";
}

function alphaVoteRows(item = {}, context = {}) {
  const votes = [];
  const social = context.socialByMint?.get(item.mint) || null;
  const premium = context.premiumByMint?.get(item.mint) || null;
  const signal = context.signalByMint?.get(item.mint) || null;
  const trendMap = context.trendMap || {};
  const trendChain = (trendMap.chains || []).find((row) => String(row.key || row.name || "").toLowerCase().includes("solana")) || null;
  const itemText = [item.symbol, item.name, item.lane, item.source, ...(item.why || []), ...(item.sources || [])].join(" ").toLowerCase();
  const trendNarrative = (trendMap.narratives || []).find((row) => {
    const name = String(row.name || row.key || "").toLowerCase();
    if (!name) return false;
    if (/solana/.test(name) && /sol|jupiter|raydium|meteora|pump|bonk|wif/i.test(itemText)) return true;
    if (/ai|agent/.test(name) && /\b(ai|agent|gpt|bot)\b/i.test(itemText)) return true;
    if (/meme|viral/.test(name) && /\b(meme|viral|pepe|dog|cat|frog|moon)\b/i.test(itemText)) return true;
    if (/launchpad|yeni/.test(name) && /\b(pump|launch|cto|boost|profile)\b/i.test(itemText)) return true;
    if (/politik|makro/.test(name) && /\b(trump|war|tariff|election|fed)\b/i.test(itemText)) return true;
    return itemText.includes(name.split(" ")[0]);
  }) || null;
  const riskText = [...(item.risk || []), ...(item.risks || [])].join(" ").toLowerCase();
  const liq = Number(item.liquidityUsd || 0);
  const vol = Number(item.volume24 || 0);
  const score = Number(item.score || 0);

  votes.push({
    name: "Cüzdan/cluster",
    ok: Boolean(signal && Number(signal.copyBuyers || 0) >= 2),
    weight: signal ? Math.min(22, 8 + Number(signal.copyBuyers || 0) * 7) : 0,
    note: signal ? `${signal.copyBuyers || 0} copy buyer, ${signal.uniqueBuyers || 0} buyer` : "canli cüzdan teyidi yok"
  });
  votes.push({
    name: "Sosyal katalizör",
    ok: Boolean(social && Number(social.score || 0) >= 58),
    weight: social ? Math.min(18, Number(social.score || 0) / 5) : 0,
    note: social ? `${social.uniqueAccounts || 0} hesap, skor ${Number(social.score || 0).toFixed(1)}` : "büyük hesap izi yok"
  });
  votes.push({
    name: "Premium akış",
    ok: Boolean(premium && Number(premium.buyers || 0) >= 2),
    weight: premium ? Math.min(24, 10 + Number(premium.buyers || 0) * 6 + Number(premium.amountUsd || 0) / 10000) : 0,
    note: premium ? `${premium.buyers || 0} smart alıcı, ${fmtNumberShort(premium.amountUsd || 0)} USD` : (context.nansenOk ? "premium teyit yok" : "Nansen kredi/erişim yok")
  });
  votes.push({
    name: "Market sağlığı",
    ok: score >= 68 || (liq >= 8000 && vol >= 30000),
    weight: Math.min(20, Math.max(0, score / 6) + (liq >= 8000 ? 4 : 0) + (vol >= 30000 ? 4 : 0)),
    note: `skor ${score.toFixed(1)}, liq ${fmtNumberShort(liq)}, hacim ${fmtNumberShort(vol)}`
  });
  votes.push({
    name: "Risk freni",
    ok: !/rug|freeze|mint|holder|daily guard|global loss|auto demote/i.test(riskText),
    weight: /rug|freeze|mint|holder/i.test(riskText) ? -28 : /daily guard|global loss|auto demote/i.test(riskText) ? -14 : 10,
    note: riskText ? riskText.slice(0, 120) : "sert risk yok"
  });
  votes.splice(3, 0, {
    name: "Trend kaymasi",
    ok: Boolean(trendChain && Number(trendChain.score || 0) >= 62 && (score >= 68 || trendNarrative)),
    weight:
      (trendChain ? Math.min(13, Number(trendChain.score || 0) / 8) : 0) +
      (trendNarrative ? Math.min(9, Number(trendNarrative.score || 0) / 10) : 0),
    note:
      trendChain ?
        `${trendChain.name || "Solana"} ${Number(trendChain.score || 0).toFixed(0)} / anlati ${trendNarrative?.name || "eslesme yok"}` :
        "zincir trendi teyidi yok"
  });
  return votes;
}

function fmtNumberShort(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return number.toFixed(number < 10 ? 2 : 0);
}

async function apiAlphaCouncil(force = false) {
  const [stateData, opportunity, hunter, social, nansen, trendMap] = await Promise.all([
    cachedApiState(0),
    apiOracleOpportunity(force),
    apiWalletHunter(force),
    apiSocialRadar(false).catch(() => ({ rows: [], counts: {}, x: {} })),
    apiNansenSmart(force).catch((error) => ({ ok: false, enabled: true, error: error?.message || String(error), wallets: [], tokens: [], counts: {} })),
    apiTrendMap(force).catch((error) => ({ ok: false, error: error?.message || String(error), chains: [], narratives: [], counts: {} }))
  ]);

  const socialByMint = new Map((social.rows || []).filter((row) => row.mint).map((row) => [row.mint, row]));
  const premiumByMint = new Map((nansen.tokens || []).map((row) => [row.mint, row]));
  const signalByMint = new Map((stateData.signalRadar || []).filter((row) => row.mint).map((row) => [row.mint, row]));
  const context = { socialByMint, premiumByMint, signalByMint, trendMap, nansenOk: Boolean(nansen.ok) };

  const candidateMap = new Map();
  for (const row of opportunity.rows || []) {
    if (!row.mint) continue;
    candidateMap.set(row.mint, { ...row, sourceSet: new Set(String(row.source || "").split(" + ").filter(Boolean)) });
  }
  for (const row of nansen.tokens || []) {
    const prev = candidateMap.get(row.mint) || { mint: row.mint, symbol: row.symbol, score: 0, risk: [], why: [], sourceSet: new Set() };
    prev.symbol ||= row.symbol;
    prev.url ||= row.url;
    prev.score = Math.max(Number(prev.score || 0), Number(row.score || 0));
    prev.sourceSet.add("Nansen Smart Money");
    candidateMap.set(row.mint, prev);
  }

  const tokenDecisions = [...candidateMap.values()].map((item) => {
    const votes = alphaVoteRows(item, context);
    const voteScore = votes.reduce((sum, vote) => sum + Number(vote.weight || 0), 0);
    const sourceBonus = Math.min(12, (item.sourceSet?.size || 0) * 4);
    const finalScore = clamp(Number(item.score || 0) * 0.48 + voteScore + sourceBonus, 0, 100);
    const kill = votes.some((vote) => vote.name === "Risk freni" && vote.weight <= -28);
    return {
      mint: item.mint,
      symbol: item.symbol || item.mint?.slice(0, 6),
      url: item.url || `https://dexscreener.com/solana/${item.mint}`,
      score: Number(finalScore.toFixed(1)),
      grade: alphaGrade(finalScore),
      decision: alphaDecision(finalScore, kill),
      sources: [...(item.sourceSet || new Set())],
      votes,
      missing: votes.filter((vote) => !vote.ok).map((vote) => vote.name),
      action:
        kill ? "sert risk temizlenmeden girme" :
        finalScore >= 88 ? "paper scout; gerçek emir için manuel onay şart" :
        finalScore >= 76 ? "radarda sıcak tut; 2. cüzdan/premium teyidi bekle" :
        "izle; tek kaynakla işlem yok"
    };
  }).sort((a, b) => b.score - a.score).slice(0, 30);

  const walletLeague = (stateData.walletStats || []).map((wallet) => {
    const pnl = Number(wallet.realizedTry || 0);
    const sells = Number(wallet.paperSells || 0);
    const wr = wallet.winRate === null || wallet.winRate === undefined ? null : Number(wallet.winRate);
    const score = clamp(
      45 +
      Math.min(24, Math.max(-24, pnl / 20)) +
      (wr === null ? -8 : Math.max(-18, Math.min(18, (wr - 45) * 0.6))) +
      Math.min(10, sells * 1.2) -
      (wallet.mode === "copy" ? 0 : 6)
    );
    return {
      name: wallet.name,
      address: wallet.address,
      mode: wallet.mode,
      lot: wallet.tradeTry || 0,
      score: Number(score.toFixed(1)),
      grade: alphaGrade(score),
      realizedTry: pnl,
      winRate: wr,
      sells,
      action:
        score >= 76 && wallet.mode !== "copy" ? "mini paper copy adayi" :
        score < 52 && wallet.mode === "copy" ? "copy kapat" :
        score < 60 ? "alert kalsin" :
        "izle",
      reason: [
        `PnL ${pnl.toFixed(0)} TL`,
        `WR ${wr === null ? "-" : wr.toFixed(0) + "%"}`,
        `${sells} kapanış`,
        wallet.mode
      ]
    };
  }).sort((a, b) => b.score - a.score);

  const playbook = [
    {
      name: "GMGN tarzı izleme",
      status: "tasarlandı",
      idea: "smartmoney / KOL / takip edilen cüzdan ayrımı, cluster ve trade-aging skoru",
      panel: "Alpha Council + Edge Matrix"
    },
    {
      name: "Çoklu teyit kapısı",
      status: "aktif",
      idea: "tek cüzdan copy değil; cüzdan + sosyal + market + risk + premium oyu",
      panel: "Alpha Council oyları"
    },
    {
      name: "Copy League",
      status: "aktif",
      idea: "her takip edilen cüzdanı PnL, win-rate, kapanış sayısı ve moduna göre terfi/frenle",
      panel: "Cüzdan Ligi"
    },
    {
      name: "Premium sağlık kontrolü",
      status: nansen.ok ? "aktif" : "kredi/erişim bekliyor",
      idea: "Nansen Smart Money akışı çalışırsa token/cüzdan oyuna katılır; hata saklanmaz",
      panel: "Nansen Premium + kaynak sağlığı"
    },
    {
      name: "Trend rotation gate",
      status: trendMap.ok ? "aktif" : "veri bekliyor",
      idea: "token skoru trend kaymasi ile ayni yone bakmiyorsa scout yerine radar olur",
      panel: "Trend Kayma Haritasi + Alpha Council oylari"
    },
    {
      name: "Reddit/X dersleri",
      status: "aktif kural",
      idea: "public paylaşılan cüzdanı kör kopyalama; exit-liquidity riskini cezalandır",
      panel: "Risk freni + eksik teyit"
    }
  ];

  return {
    ok: true,
    now: new Date().toISOString(),
    tokenDecisions,
    walletLeague: walletLeague.slice(0, 25),
    playbook,
    sourceHealth: {
      nansenOk: Boolean(nansen.ok),
      nansenError: nansen.error || null,
      socialMentions: social.counts?.mentions || 0,
      walletCandidates: hunter.counts?.wallets || 0,
      opportunityRows: opportunity.rows?.length || 0,
      trendOk: Boolean(trendMap.ok),
      trendTopChain: trendMap.chains?.[0]?.name || null,
      trendTopNarrative: trendMap.narratives?.[0]?.name || null
    },
    sources: [
      { name: "GMGN Agent Skills", url: "https://github.com/GMGNAI/gmgn-skills", use: "smartmoney/KOL/follow-wallet, holder analytics, sniper/bundler/fresh-wallet fikirleri" },
      { name: "GMGN Track Skill", url: "https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-track/SKILL.md", use: "cluster sinyali, trade-aging, smartmoney vs KOL ayrımı" },
      { name: "Insider Monitor", url: "https://github.com/AccursedGalaxy/Insider-Monitor", use: "cüzdan bakiye değişimi, significant-change alarm mantığı" },
      { name: "Reddit copy-trade deneyimleri", url: "https://www.reddit.com/r/solana/comments/1ca2jk3/copy_trading_solana_wallets_consistently/", use: "public paylaşılan cüzdanların exit-liquidity riski ve top-performer arama fikri" }
    ]
  };
}

function premiumFeatureBlueprint({ stateData = {}, opportunity = {}, hunter = {}, social = {}, nansen = {}, edgeRows = [] } = {}) {
  const activeCopy = (stateData.config?.wallets || []).filter((wallet) => wallet.mode === "copy").length;
  const hardRisks = edgeRows.filter((row) => row.grade === "RISK").length;
  const blockers = opportunity.blockers || [];
  const hunterRows = hunter.rows || [];
  const socialMentions = social.counts?.mentions || 0;
  const nansenReady = Boolean(nansen.ok);
  const dailyBlocked = blockers.some((row) => /daily|drawdown|loss/i.test(`${row.name || ""} ${row.explain || ""}`));
  const dupSignals = Math.max(0, (stateData.events || []).length - new Set((stateData.events || []).map(eventDedupKey).filter(Boolean)).size);
  const template = [
    ["Smart/KOL/Follow ayrimi", "GMGN Track Smart Money", "smart money trade, KOL sosyal etki ve manuel follow cüzdanlarini ayri puanla", activeCopy > 0 ? "aktif" : "copy yok"],
    ["First buyers / ilk 70 izleme", "GMGN Insider/Snipers/First 70 Buyers", "token ilk alicilarindan tekrar eden erken cüzdanlari avla", (hunter.counts?.sniper || 0) ? "aktif" : "veri bekliyor"],
    ["Buyuk para conviction", "GMGN + MevX buy-size mantigi", "dusuk SOL ile gelen sniper yerine anlamli SOL harcayan cüzdanlari ust siraya al", hunterRows.some((row) => Number(row.maxBuySol || 0) >= 1) ? "aktif" : "zayif"],
    ["Copy distortion freni", "Stratium copy-trading risk yazilari", "popular cüzdan ve dusuk likidite kombinasyonunda kopyayi azalt", blockers.length ? "aktif" : "izlemede"],
    ["Manipulatif bot cezasi", "Resisting Manipulative Bots paper", "her tokene atlayan, az kapanisli, buyuk zarari olan cüzdanlari cezalandir", hardRisks ? "aktif" : "temiz"],
    ["Holder / top10 yogunluk", "Rugcheck / Solana Tracker / DeFade", "top holder, insider holder ve supply yogunlasmasini alim frenine bagla", "tasarlandi"],
    ["Mint/freeze authority kapisi", "Solana rug scanner rehberleri", "mint/freeze yetkisi acik tokenlarda scout bile kisitla", "aktif kapi"],
    ["Bundle / sniper concentration", "DeFade + MemeTrans arastirma", "ilk blok bundle ve ayni kaynak fonlamasini risk olarak isaretle", "tasarlandi"],
    ["Dev wallet / creator hafizasi", "DeFade dev tracker + SolRPDS", "dev sattigi, ayni devin once rug yaptigi tokenleri kara listeye yakin tut", "tasarlandi"],
    ["Liquidity exit-slippage", "RugSol / RugScan AI", "lotu likiditeye gore ayarla, cikista tahmini slippage ekle", "aktif"],
    ["Sosyal katalizor oncesi alim", "X trend + GMGN smart money", "buyuk hesap paylasmadan once alan cüzdanlari ayrica etiketle", socialMentions ? "sinyal var" : "veri bekliyor"],
    ["Narrative tokenizasyon", "X/Reddit memecoin trendleri", "politik/AI/unlu/olay anlatilarindan dogan sembolleri CA kesinlesmeden izle", (social.narratives || []).length ? "aktif" : "sessiz"],
    ["Survivor filtresi", "Reddit copy-trade deneyimleri", "ilk dakika hype yerine 24-48 saat hayatta kalan tokenlere farkli lane ac", "tasarlandi"],
    ["Premium akisi saglik etiketi", "Nansen/GMGN premium akislari", "premium API yoksa karar puanindan ceza kes; hatayi saklama", nansenReady ? "aktif" : "kredi yok"],
    ["Ghost PnL / duplicate guard", "Canli sistem gozlemi", "ayni signature tekrarini ve kapanmis pozisyon PnL hayaletini engelle", dupSignals ? "onarildi" : "aktif"]
  ];
  return template.map(([name, source, signal, status], index) => ({
    id: index + 1,
    name,
    source,
    signal,
    status,
    score: Math.max(35, Math.min(98, 58 + (status === "aktif" || status === "onarildi" ? 22 : 0) + (status === "tasarlandi" ? 8 : 0) - (dailyBlocked ? 8 : 0))),
    action:
      status === "aktif" || status === "onarildi" ? "panelde calisiyor / karar puanina giriyor" :
      status === "tasarlandi" ? "sabah turunda otomatik metrik olarak derinlestir" :
      "veri geldiginde puana kat"
  }));
}

function alienMetricLab({ stateData = {}, opportunity = {}, hunter = {}, social = {}, nansen = {}, edgeRows = [], council = {} } = {}) {
  const positions = stateData.state?.positions || stateData.positions || [];
  const events = stateData.events || [];
  const copyWallets = (stateData.config?.wallets || []).filter((wallet) => wallet.mode === "copy");
  const alertWallets = (stateData.config?.wallets || []).filter((wallet) => wallet.mode === "alert");
  const blockers = opportunity.blockers || [];
  const hunterRows = hunter.rows || [];
  const tokenRows = council.tokenDecisions || [];
  const topToken = tokenRows[0] || null;
  const topVotes = topToken?.votes || [];
  const okVoteCount = topVotes.filter((vote) => vote.ok).length;
  const duplicateSignals = Math.max(0, events.length - new Set(events.map(eventDedupKey).filter(Boolean)).size);
  const recentSkips = events.filter((event) => event.paper?.skipped).length;
  const socialNarratives = social.narratives || [];
  const strongWallets = hunterRows.filter((row) => Number(row.totalScore || 0) >= 70 && !(row.riskFlags || []).length);
  const whaleLikeWallets = hunterRows.filter((row) => Number(Math.max(row.maxBuySol || 0, row.maxEarlyBuySol || 0)) >= 1);
  const lowEvidenceTokens = tokenRows.filter((row) => (row.missing || []).length >= 3).length;
  const premiumOk = Boolean(nansen.ok);
  const premiumHits = Number(nansen.counts?.trades || 0) + Number(nansen.tokens?.length || 0) + Number(nansen.wallets?.length || 0);
  const liveClusterRows = edgeRows.filter((row) => row.kind === "cluster" || row.kind === "wallet").length;
  const riskRows = edgeRows.filter((row) => row.grade === "RISK" || row.mode === "engel").length;
  const mtmPositions = stateData.mtm?.positions || [];
  const exitPressure = mtmPositions.filter((position) => position.walletStillHolding === false || Number(position.unrealizedPct || 0) < -18).length;
  const openMoonshots = mtmPositions.filter((position) => position.moonshot).length;

  const voteDensity = topVotes.length ? okVoteCount / topVotes.length : 0;
  const walletQuality = hunterRows.length ? strongWallets.length / hunterRows.length : 0;
  const whaleDensity = hunterRows.length ? whaleLikeWallets.length / hunterRows.length : 0;
  const narrativeDensity = socialNarratives.length ? socialNarratives.filter((row) => Number(row.score || 0) >= 60).length / socialNarratives.length : 0;
  const noiseRatio = events.length ? Math.min(1, (duplicateSignals + recentSkips * 0.35) / events.length) : 0;
  const riskRatio = edgeRows.length ? riskRows / edgeRows.length : 0;
  const premiumCoverage = premiumOk ? Math.min(1, premiumHits / 12) : 0;

  const metrics = [
    {
      name: "Alpha Confluence",
      value: clamp(35 + voteDensity * 45 + Math.min(20, tokenRows.length * 1.8) - riskRatio * 18),
      label: "cuzdan + sosyal + market + risk oy birligi",
      source: "GMGN smart money + Alpha Council oy modeli",
      action: voteDensity >= 0.8 ? "tek tokeni derin incele" : "eksik oylar tamamlanmadan bekle"
    },
    {
      name: "Whale Shadow",
      value: clamp(25 + whaleDensity * 55 + Math.min(20, whaleLikeWallets.length * 6)),
      label: "buyuk SOL ile giren aday cuzdan yogunlugu",
      source: "GMGN/MevX buy-size conviction mantigi",
      action: whaleLikeWallets.length ? "buyuk para adaylarini ayri izle" : "dust sniperlari yukari tasima"
    },
    {
      name: "Insider Lag",
      value: clamp(72 - lowEvidenceTokens * 5 + strongWallets.length * 4 + premiumCoverage * 18),
      label: "sinyal gec mi, erken mi yakalaniyor",
      source: "First buyers / insider-benzeri davranis",
      action: lowEvidenceTokens > 3 ? "gec kalmis adaylari sadece radar yap" : "erken clusterlari scout aday yap"
    },
    {
      name: "Narrative Ignition",
      value: clamp(28 + narrativeDensity * 48 + Math.min(24, social.counts?.mentions || 0)),
      label: "sosyal olay tokenlesme sicakligi",
      source: "X/Reddit narrative radar",
      action: narrativeDensity > 0.5 ? "CA cikmadan watchlist ac" : "sosyal tek basina alima donmesin"
    },
    {
      name: "Rug Gravity",
      value: clamp(100 - riskRatio * 70 - blockers.filter((row) => /holder|freeze|mint|rug|LP/i.test(row.name || "")).length * 8),
      label: "rug, holder, mint/freeze ve likidite agirligi",
      source: "RugCheck / Solana Tracker risk checkleri",
      action: riskRatio > 0.25 ? "riskli tokenlarda emir yok" : "risk kapisi temiz gorunuyor"
    },
    {
      name: "Copy Crowding",
      value: clamp(72 - copyWallets.length * 3 - alertWallets.length * 0.8 - liveClusterRows * 2 + strongWallets.length * 5),
      label: "kalabalik copy yerine secici alpha",
      source: "copy-trading exit-liquidity riski",
      action: copyWallets.length > 4 ? "copy sayisini azalt, alert agirlik ver" : "copy slotlari kontrollu"
    },
    {
      name: "Execution Drag",
      value: clamp(86 - blockers.filter((row) => /no price|price pending|liquidity|slippage|slot full/i.test(row.name || "")).length * 10 - positions.length * 3),
      label: "fiyat, likidite, slot ve slippage suruklenmesi",
      source: "DEX Screener pair health + paper execution",
      action: "lotu likiditeye ve fiyat guvenine gore daralt"
    },
    {
      name: "Ghost Integrity",
      value: clamp(96 - duplicateSignals * 18 - noiseRatio * 30),
      label: "duplicate signature / hayalet PnL temizligi",
      source: "canli sistem gozlemi",
      action: duplicateSignals ? "tekrarli sinyali yok say" : "defter temiz"
    },
    {
      name: "Premium Parity",
      value: clamp(34 + premiumCoverage * 56 + (premiumOk ? 10 : -12)),
      label: "ucretsiz sistemin premium akislara yakinligi",
      source: "Nansen/GMGN tarz akislari taklit eden kontrol",
      action: premiumOk ? "premium teyidi puana kat" : "premium yoksa skor tavanini dusur"
    },
    {
      name: "Survivor Bias Shield",
      value: clamp(58 + openMoonshots * 3 - exitPressure * 14 + Math.min(20, mtmPositions.length * 3)),
      label: "erken hype yerine yasayan pozisyon kalitesi",
      source: "survivor filtresi + wallet exit takibi",
      action: exitPressure ? "cuzdan ciktiysa pozisyonu zorla tutma" : "kosanlari erken bogma"
    },
    {
      name: "Source Entropy",
      value: clamp(40 + Math.min(45, new Set((edgeRows || []).map((row) => row.kind)).size * 7) + (premiumOk ? 8 : 0) + (social.counts?.mentions ? 7 : 0)),
      label: "tek kaynaga bagimli olmama seviyesi",
      source: "DexScreener + sosyal + cüzdan + premium + risk",
      action: "tek kaynakli sinyali karar degil hipotez say"
    },
    {
      name: "Oracle Confidence",
      value: clamp((topToken?.score || 0) * 0.52 + voteDensity * 28 + walletQuality * 16 + premiumCoverage * 8 - riskRatio * 18 - noiseRatio * 12),
      label: "tum ust metriklerin son guven puani",
      source: "birlesik karar katmani",
      action: "80 ustu paper scout, 65-80 radar, alti bekle"
    }
  ];

  const metricRecipes = {
    "Alpha Confluence": {
      formula: "35 taban + teyit oy yoğunluğu + aday token sayısı - risk oranı",
      factors: [
        `teyit: ${okVoteCount}/${topVotes.length || 0}`,
        `token adayı: ${tokenRows.length}`,
        `risk oranı: ${Math.round(riskRatio * 100)}%`
      ]
    },
    "Whale Shadow": {
      formula: "25 taban + büyük SOL ile giren cüzdan oranı + büyük cüzdan adedi",
      factors: [
        `büyük alım cüzdanı: ${whaleLikeWallets.length}/${hunterRows.length || 0}`,
        `eşik: 1 SOL üstü max buy`,
        `amaç: dust sniperı ayıklamak`
      ]
    },
    "Insider Lag": {
      formula: "72 taban - düşük kanıtlı token cezası + güçlü cüzdan + premium teyit",
      factors: [
        `düşük kanıtlı token: ${lowEvidenceTokens}`,
        `güçlü cüzdan: ${strongWallets.length}`,
        `premium kapsama: ${Math.round(premiumCoverage * 100)}%`
      ]
    },
    "Narrative Ignition": {
      formula: "28 taban + güçlü sosyal anlatı oranı + mention sıcaklığı",
      factors: [
        `sosyal olay: ${socialNarratives.length}`,
        `mention: ${social.counts?.mentions || 0}`,
        `güçlü anlatı oranı: ${Math.round(narrativeDensity * 100)}%`
      ]
    },
    "Rug Gravity": {
      formula: "100 temiz başlangıç - risk satırı cezası - rug/holder/mint/freeze uyarıları",
      factors: [
        `risk satırı: ${riskRows}/${edgeRows.length || 0}`,
        `fren: ${blockers.length}`,
        `yüksekse: rug baskısı düşük`
      ]
    },
    "Copy Crowding": {
      formula: "72 taban - aktif copy kalabalığı - canlı cluster kalabalığı + güçlü cüzdan",
      factors: [
        `copy cüzdan: ${copyWallets.length}`,
        `alert cüzdan: ${alertWallets.length}`,
        `güçlü cüzdan: ${strongWallets.length}`
      ]
    },
    "Execution Drag": {
      formula: "86 taban - no price/likidite/slippage/slot freni - açık pozisyon yükü",
      factors: [
        `açık pozisyon: ${positions.length}`,
        `fiyat/likidite freni: ${blockers.filter((row) => /no price|price pending|liquidity|slippage|slot full/i.test(row.name || "")).length}`,
        `yüksekse: işlem sürtünmesi az`
      ]
    },
    "Ghost Integrity": {
      formula: "96 taban - duplicate signature cezası - skipped/noise oranı",
      factors: [
        `duplicate: ${duplicateSignals}`,
        `skip: ${recentSkips}`,
        `noise: ${Math.round(noiseRatio * 100)}%`
      ]
    },
    "Premium Parity": {
      formula: "34 taban + premium kapsama + API aktif bonusu / API yok cezası",
      factors: [
        `premium API: ${premiumOk ? "aktif" : "yok"}`,
        `premium hit: ${premiumHits}`,
        `kapsama: ${Math.round(premiumCoverage * 100)}%`
      ]
    },
    "Survivor Bias Shield": {
      formula: "58 taban + moonshot/açık pozisyon kalitesi - exit pressure",
      factors: [
        `moonshot açık: ${openMoonshots}`,
        `MTM pozisyon: ${mtmPositions.length}`,
        `exit pressure: ${exitPressure}`
      ]
    },
    "Source Entropy": {
      formula: "40 taban + farklı kaynak türü + premium/sosyal katkı",
      factors: [
        `kaynak türü: ${new Set((edgeRows || []).map((row) => row.kind)).size}`,
        `premium: ${premiumOk ? "var" : "yok"}`,
        `sosyal: ${social.counts?.mentions ? "var" : "zayıf"}`
      ]
    },
    "Oracle Confidence": {
      formula: "top token skoru + teyit yoğunluğu + cüzdan kalitesi + premium - risk - noise",
      factors: [
        `top token: ${Number(topToken?.score || 0).toFixed(1)}`,
        `cüzdan kalite: ${Math.round(walletQuality * 100)}%`,
        `risk/noise: ${Math.round(riskRatio * 100)}% / ${Math.round(noiseRatio * 100)}%`
      ]
    }
  };

  return metrics.map((metric) => {
    const value = Number(metric.value.toFixed(1));
    const recipe = metricRecipes[metric.name] || {};
    return {
      ...metric,
      formula: recipe.formula || "",
      factors: recipe.factors || [],
      value,
      grade: value >= 82 ? "A+" : value >= 70 ? "A" : value >= 58 ? "B" : value >= 45 ? "WATCH" : "RISK",
      heat: value >= 82 ? "ust duzey" : value >= 70 ? "guclu" : value >= 58 ? "orta" : value >= 45 ? "zayif" : "risk"
    };
  });
}

async function apiSuperAlpha(force = false) {
  const [stateData, opportunity, hunter, social, nansen, trendMap] = await Promise.all([
    cachedApiState(0),
    apiOracleOpportunity(force),
    apiWalletHunter(force),
    apiSocialRadar(false).catch(() => ({ rows: [], counts: {}, x: {} })),
    apiNansenSmart(force).catch((error) => ({ ok: false, enabled: true, error: error?.message || String(error), wallets: [], tokens: [] })),
    apiTrendMap(force).catch((error) => ({ ok: false, error: error?.message || String(error), chains: [], narratives: [], migration: [], counts: {} }))
  ]);

  const rows = [];
  const addRow = (row) => {
    if (!row?.title) return;
    rows.push({ id: `${row.kind || "edge"}:${row.key || row.title}:${rows.length}`, ...row });
  };

  for (const wallet of hunter.rows || []) {
    const hardRisk = (wallet.riskFlags || []).some((risk) => /buyuk zarar|her seye|az kapanis|kar\/zarar/i.test(risk));
    const score = clamp(
      Number(wallet.totalScore || 0) * 0.34 +
      Number(wallet.convictionScore || 0) * 0.28 +
      Number(wallet.alphaScore || 0) * 0.16 +
      Number(wallet.insiderScore || 0) * 0.12 +
      Number(wallet.sniperScore || 0) * 0.06 +
      Math.min(8, Math.max(0, Number(wallet.pnlSol || 0)) * 2) -
      (hardRisk ? 22 : 0) -
      (wallet.dustSniper ? 18 : 0)
    );
    addRow({
      kind: "wallet",
      key: wallet.wallet,
      title: `Cuzdan: ${wallet.wallet.slice(0, 6)}...${wallet.wallet.slice(-4)}`,
      grade: edgeGrade(score),
      mode: edgeMode(score, hardRisk),
      score: Number(score.toFixed(1)),
      action: score >= 86 && !hardRisk ? "paper scout-copy + siki risk izle" : score >= 74 && !hardRisk ? "alert-scout; tek sinyalde mini dene" : "izle; kanit biriktir",
      reasons: compactReason([
        `conviction ${wallet.convictionScore}`,
        `max buy ${Number(Math.max(wallet.maxBuySol || 0, wallet.maxEarlyBuySol || 0)).toFixed(2)} SOL`,
        `avg buy ${Number(wallet.avgBuySol || 0).toFixed(2)} SOL`,
        `PnL ${Number(wallet.pnlSol || 0).toFixed(2)} SOL`,
        `WR ${wallet.winRate === null || wallet.winRate === undefined ? "-" : Number(wallet.winRate).toFixed(0) + "%"}`,
        `etiket ${(wallet.categories || []).slice(0, 4).join(", ")}`
      ]),
      risks: wallet.riskFlags || [],
      address: wallet.wallet,
      url: `https://gmgn.ai/sol/address/${wallet.wallet}`
    });
  }

  for (const token of opportunity.rows || []) {
    const hardRisk = (token.risk || []).some((risk) => /holder|freeze|mint|rug|lp|liquidity|CA net/i.test(risk));
    const score = clamp(Number(token.score || 0) * 0.78 + (token.source || "").split("+").length * 4 - (hardRisk ? 18 : 0));
    addRow({
      kind: "token",
      key: token.mint || token.symbol,
      title: `Token: ${token.symbol || token.mint?.slice(0, 6) || "-"}`,
      grade: edgeGrade(score),
      mode: edgeMode(score, hardRisk),
      score: Number(score.toFixed(1)),
      action: score >= 82 && !hardRisk ? "derin analiz + scout aday" : score >= 68 ? "radarda sicak tut; cuzdan onayi bekle" : "sadece takip",
      reasons: compactReason([token.lane, token.source, ...(token.why || [])]),
      risks: token.risk || [],
      mint: token.mint,
      url: token.url
    });
  }

  for (const cluster of hunter.clusters || []) {
    const score = clamp(Number(cluster.clusterScore || 0) + Number(cluster.strongCount || 0) * 8 + Number(cluster.smartCount || 0) * 5 - Number(cluster.riskyCount || 0) * 10);
    addRow({
      kind: "cluster",
      key: cluster.mint,
      title: `Cluster: ${cluster.symbol || cluster.mint?.slice(0, 6)}`,
      grade: edgeGrade(score),
      mode: edgeMode(score, Number(cluster.riskyCount || 0) >= 2),
      score: Number(score.toFixed(1)),
      action: cluster.action || "cluster izle",
      reasons: compactReason([
        `cluster ${cluster.clusterScore}`,
        `smart ${cluster.smartCount}`,
        `pir ${cluster.strongCount}`,
        `risk ${cluster.riskyCount}`,
        ...(cluster.buyers || []).slice(0, 2).map((buyer) => `${String(buyer.wallet || "").slice(0, 6)} A${buyer.alphaScore || 0} I${buyer.insiderScore || 0}`)
      ]),
      risks: Number(cluster.riskyCount || 0) ? [`${cluster.riskyCount} riskli alici`] : [],
      mint: cluster.mint,
      url: cluster.url
    });
  }

  for (const wallet of nansen.wallets || []) {
    const score = clamp(Number(wallet.score || 0) + Math.min(8, Number(wallet.amountUsd || 0) / 10000));
    addRow({
      kind: "premium-wallet",
      key: wallet.address,
      title: `Nansen Smart: ${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
      grade: edgeGrade(score),
      mode: score >= 86 ? "scout-copy" : score >= 74 ? "alert-scout" : "watch",
      score: Number(score.toFixed(1)),
      action: score >= 86 ? "once alert ekle; 2. sinyalde mini paper copy" : "premium izleme listesine al; tek islemle atlama",
      reasons: compactReason([
        `Nansen smart-money trade`,
        `alim ${wallet.buyCount}`,
        `token ${wallet.uniqueTokens}`,
        `hacim $${Number(wallet.amountUsd || 0).toFixed(0)}`,
        `etiket ${(wallet.labels || []).slice(0, 3).join(", ")}`,
        `ornek ${(wallet.sampleTokens || []).join(", ")}`
      ]),
      risks: Number(wallet.buyCount || 0) < 2 ? ["tek trade; copy icin tekrar bekle"] : [],
      address: wallet.address,
      url: wallet.url
    });
  }

  for (const token of nansen.tokens || []) {
    const multiBuyer = Number(token.buyers || 0) >= 2;
    const score = clamp(Number(token.score || 0) + (multiBuyer ? 8 : 0));
    addRow({
      kind: "premium-token",
      key: token.mint,
      title: `Nansen Token: ${token.symbol || token.mint.slice(0, 6)}`,
      grade: edgeGrade(score),
      mode: multiBuyer ? edgeMode(score, false) : "watch",
      score: Number(score.toFixed(1)),
      action: multiBuyer ? "tokenu derin analiz et; cüzdan teyidiyle scout" : "tek smart alici; ikinci alici bekle",
      reasons: compactReason([
        `smart alici ${token.buyers}`,
        `alim ${token.buyCount}`,
        `hacim $${Number(token.amountUsd || 0).toFixed(0)}`,
        `max trade $${Number(token.maxTradeUsd || 0).toFixed(0)}`,
        `etiket ${(token.labels || []).slice(0, 3).join(", ")}`
      ]),
      risks: multiBuyer ? [] : ["tek smart kaynak; fake pump olabilir"],
      mint: token.mint,
      url: token.url
    });
  }

  const walletStats = stateData.walletStats || [];
  const badWallets = walletStats
    .filter((wallet) => Number(wallet.realizedTry || 0) < -40 || (wallet.paperSells >= 3 && wallet.winRate !== null && Number(wallet.winRate) < 35))
    .slice(0, 8);
  for (const wallet of badWallets) {
    const realized = Number(wallet.realizedTry || 0);
    const wr = wallet.winRate === null ? null : Number(wallet.winRate);
    const isRealLoser = realized < -40;
    const riskScore = isRealLoser
      ? Math.min(84, 58 + Math.abs(realized) / 6)
      : Math.min(68, 48 + Math.max(0, 35 - Number(wr || 0)) * 0.6);
    addRow({
      kind: "negative-wallet",
      key: wallet.name,
      title: `${isRealLoser ? "Negatif alpha" : "Form riski"}: ${wallet.name}`,
      grade: "RISK",
      mode: "kisitla",
      score: Number(riskScore.toFixed(1)),
      action: "copy azalt / alert yap / yeni adayla degistir",
      reasons: compactReason([
        `realized ${realized.toFixed(0)} TL`,
        `WR ${wr === null ? "-" : wr.toFixed(0) + "%"}`,
        `paper ${wallet.paperBuys || 0}/${wallet.paperSells || 0}`,
        wallet.autoDemoted?.reason
      ]),
      risks: [isRealLoser ? "sistemin parasini yiyen kaynak" : "dusuk win-rate; kâr tek/az islemden gelmis olabilir"],
      address: wallet.address
    });
  }

  const blockers = opportunity.blockers || [];
  const topBlocker = blockers[0] || null;
  if (topBlocker && Number(topBlocker.count || 0) >= 8) {
    addRow({
      kind: "rule-friction",
      key: topBlocker.name,
      title: `Kural surtunmesi: ${topBlocker.name}`,
      grade: "WATCH",
      mode: "ayar-incele",
      score: Math.min(76, 40 + Number(topBlocker.count || 0)),
      action: "firsat kaciriyor mu? geri test et; gerekirse scout istisnasi ekle",
      reasons: [topBlocker.explain, `${topBlocker.count} kez oldu`, topBlocker.severity],
      risks: ["kurali gevsetmek zarar da getirebilir"]
    });
  }

  const recovery = (stateData.recoveryTrades || []).slice(0, 8);
  const missed = recovery.filter((item) => Number(item.missedTry || 0) > 20);
  if (missed.length) {
    addRow({
      kind: "learning",
      key: "missed-runner",
      title: "Ozel hafiza: erken satilan runnerlar",
      grade: "B",
      mode: "strateji-ogren",
      score: Math.min(82, 48 + missed.length * 7 + Math.max(...missed.map((item) => Number(item.missedTry || 0))) / 20),
      action: "runner/TP kurallarini bu orneklere gore tekrar agirliklandir",
      reasons: missed.slice(0, 5).map((item) => `${item.symbol} kacirdi ${Number(item.missedTry || 0).toFixed(0)} TL`),
      risks: ["fazla tutmak rug/geri verme riskini artirir"]
    });
  }

  const sortedRows = rows
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 50);

  const metrics = {
    edgeRows: sortedRows.length,
    scoutReady: sortedRows.filter((row) => ["scout-copy", "alert-scout"].includes(row.mode)).length,
    hardRisks: sortedRows.filter((row) => row.grade === "RISK").length,
    socialMentions: social.counts?.mentions || 0,
    walletCandidates: hunter.counts?.wallets || 0,
    tokenOpportunities: opportunity.counts?.opportunities || 0,
    negativeWallets: badWallets.length,
    premiumWallets: nansen.wallets?.length || 0,
    premiumTokens: nansen.tokens?.length || 0,
    premiumTrades: nansen.counts?.trades || 0
  };

  const doctrine = [
    "Herkesin gordugu tek kaynak edge degil; edge, kaynaklari gecikmesiz ve eleme odakli birlestirmekte.",
    "Buyuk para conviction yoksa smart/insider etiketi verilmez.",
    "Bizim ozel hafiza: zarar ettiren cuzdan, kacan runner ve en cok firsat kaciran kural cezalandirilir.",
    "Scout-copy sadece paper modda; gercek emir icin ayri guvenlik ve manuel onay gerekir."
  ];

  return {
    ok: true,
    now: new Date().toISOString(),
    rows: sortedRows,
    metrics,
    alienMetrics: alienMetricLab({ stateData, opportunity, hunter, social, nansen, edgeRows: sortedRows }),
    trendMap,
    premiumFeatures: premiumFeatureBlueprint({ stateData, opportunity, hunter, social, nansen, edgeRows: sortedRows }),
    doctrine,
    sourceHealth: {
      xEnabled: Boolean(social.x?.enabled),
      socialMentions: social.counts?.mentions || 0,
      nansenEnabled: Boolean(nansen.enabled),
      nansenOk: Boolean(nansen.ok),
      nansenError: nansen.error || null,
      premiumTrades: nansen.counts?.trades || 0,
      hunterRunning: hunter.running,
      hunterLastScanAt: hunter.lastScanAt,
      opportunityRows: opportunity.rows?.length || 0,
      blockers: blockers.length
    }
  };
}

async function getTokenPriceTry(mint, tryPerSol) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!response.ok) return null;
    const json = await response.json();
    const pair = (json.pairs || [])
      .filter((item) => item.chainId === "solana" && Number(item.priceUsd) > 0)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    if (!pair) return null;
    return {
      symbol: pair.baseToken?.symbol || mint.slice(0, 6),
      priceTry: Number(pair.priceUsd) * tryPerSol,
      url: pair.url
    };
  } catch {
    return null;
  }
}

async function apiWalletDetail(query = "") {
  const key = String(query || "").trim();
  if (!key) return { ok: false, error: "wallet required" };
  const [config, state, events] = await Promise.all([
    readJson("config.json", {}),
    readJson("paper-state.json", {}),
    readEvents(1200)
  ]);
  const wallet = (config.wallets || []).find((item) =>
    item.name === key ||
    item.address === key ||
    (item.relatedAddresses || []).includes(key) ||
    (item.signerAddresses || []).includes(key)
  );
  const address = wallet?.address || key;
  const names = new Set([wallet?.name, address, ...(wallet?.relatedAddresses || []), ...(wallet?.signerAddresses || [])].filter(Boolean));
  const walletEvents = events
    .filter((event) => names.has(event.wallet) || names.has(event.walletAddress) || names.has(event.ownerAddress))
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  const paperSells = walletEvents.filter((event) => event.paper?.pnlTry !== undefined);
  const wins = paperSells.filter((event) => Number(event.paper.pnlTry || 0) > 0).length;
  const realizedTry = paperSells.reduce((sum, event) => sum + Number(event.paper.pnlTry || 0), 0);
  const buys = walletEvents.filter((event) => event.type === "BUY" || event.paper?.position).length;
  const sells = walletEvents.filter((event) => event.type === "SELL" || event.paper?.pnlTry !== undefined).length;
  const relatedFromEvents = new Set();
  for (const event of walletEvents) {
    if (event.ownerAddress && event.ownerAddress !== address) relatedFromEvents.add(event.ownerAddress);
    if (event.transferTarget) relatedFromEvents.add(event.transferTarget);
  }
  const openPositions = (state.positions || []).filter((position) =>
    position.wallet === wallet?.name ||
    position.walletAddress === address ||
    position.ownerAddress === address ||
    names.has(position.wallet)
  );
  let balance = null;
  let cielo = { enabled: Boolean(cieloKey(config)), ok: false, error: config.enableCieloPnl ? null : "Cielo PnL modulu kapali" };
  if (wallet?.address) {
    try {
      const lamports = await solanaRpc(config, "getBalance", [wallet.address], 8000);
      balance = { sol: Number(lamports?.value || 0) / 1e9, try: (Number(lamports?.value || 0) / 1e9) * Number(config.tryPerSol || 0) };
    } catch {
      balance = null;
    }
    if (config.enableCieloPnl) {
      cielo = await cieloWalletPnl(config, wallet.address).catch((error) => ({ enabled: Boolean(cieloKey(config)), ok: false, error: error?.message || String(error) }));
    }
  }
  return {
    ok: true,
    wallet: {
      name: wallet?.name || key,
      address,
      mode: wallet?.mode || "-",
      tradeTry: wallet?.tradeTry || 0,
      score: wallet?.score ?? null,
      class: wallet?.class || "-",
      note: wallet?.note || "",
      gmgn: gmgnWalletUrl(address),
      solscan: solscanWalletUrl(address),
      cielo: cieloWalletUrl(address),
      nansen: nansenSearchUrl(address)
    },
    stats: {
      buys,
      sells,
      paperSells: paperSells.length,
      winRate: paperSells.length ? Number(((wins / paperSells.length) * 100).toFixed(1)) : null,
      realizedTry: Number(realizedTry.toFixed(2)),
      openPositions: openPositions.length,
      lastSignalAt: walletEvents[0]?.time || null
    },
    balance,
    cielo,
    related: [
      ...(wallet?.relatedAddresses || []).map((item) => ({ address: item, type: "config related", gmgn: gmgnWalletUrl(item) })),
      ...(wallet?.signerAddresses || []).map((item) => ({ address: item, type: "signer", gmgn: gmgnWalletUrl(item) })),
      ...[...relatedFromEvents].filter((item) => looksSolanaAddress(item)).map((item) => ({ address: item, type: "event owner/transfer", gmgn: gmgnWalletUrl(item) }))
    ].slice(0, 20),
    openPositions: openPositions.slice(0, 20).map((position) => ({
      id: position.id,
      symbol: position.symbol,
      mint: position.mint,
      investedTry: position.investedTry,
      openedAt: position.openedAt,
      buyReason: position.buyReason,
      walletStillHolding: position.walletStillHolding,
      url: position.url
    })),
    trades: walletEvents.slice(0, 80).map((event) => ({
      time: event.time,
      type: event.type || event.kind || "-",
      symbol: event.symbol || event.mint?.slice(0, 6),
      mint: event.mint,
      ownerAddress: event.ownerAddress,
      tokenDelta: event.tokenDelta,
      solDelta: event.solDelta,
      stableDelta: event.stableDelta,
      priceUsd: event.priceUsd,
      url: event.url,
      paper: event.paper ? {
        skipped: event.paper.skipped,
        pnlTry: event.paper.pnlTry,
        position: event.paper.position ? {
          investedTry: event.paper.position.investedTry,
          buyReason: event.paper.position.buyReason
        } : null
      } : null
    }))
  };
}

function positionPotential(position, currentTry) {
  const ageMin = Math.max(0, (Date.now() - new Date(position.openedAt).getTime()) / 60000);
  const entryTry = position.entryTry || currentTry;
  const gainPct = entryTry ? ((currentTry - entryTry) / entryTry) * 100 : 0;
  const highTry = Math.max(position.highestTry || entryTry, currentTry);
  const pullbackPct = highTry ? ((currentTry - highTry) / highTry) * 100 : 0;
  const walletScore = Number(position.walletScore || 50);
  const mcap = Number(position.tokenMeta?.marketCap || 0);
  const volume = Number(position.tokenMeta?.volume24h || 0);
  const liquidity = Number(position.tokenMeta?.liquidityUsd || 0);

  let score = 45;
  score += Math.min(18, Math.max(-22, gainPct / 3));
  score += position.moonshot ? 8 : 0;
  score += Math.min(14, Math.max(-8, (walletScore - 55) / 2));
  score += mcap > 0 && mcap <= 1000000 ? 8 : mcap <= 5000000 ? 4 : -4;
  score += volume >= 50000 ? 6 : volume >= 10000 ? 3 : -3;
  score += liquidity >= 15000 ? 5 : liquidity > 0 && liquidity < 3000 ? -8 : 0;
  score += ageMin < 15 ? 4 : ageMin > 240 && gainPct < 20 ? -10 : 0;
  score += pullbackPct < -45 ? -14 : pullbackPct < -25 ? -7 : 0;
  if (position.tp1Done) score += 8;
  if (position.walletStillHolding === false) score -= 22;
  if (position.walletStillHolding === true) score += 10;
  if (gainPct < -35) score -= 18;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label =
    score >= 75 ? "Yuksek potansiyel" :
    score >= 58 ? "Takipte tut" :
    score >= 42 ? "Kararsiz" :
    "Zayif sermaye";
  const action =
    position.walletStillHolding === false && score < 58 ? "cuzdan cikti, kapatmayi dusun" :
    score >= 75 ? "runner tut" :
    score >= 58 ? "bekle" :
    score >= 42 ? "kucultmeyi dusun" :
    "yeni sinyale yer acabilir";
  const reasons = [
    `gain ${gainPct.toFixed(1)}%`,
    `pullback ${pullbackPct.toFixed(1)}%`,
    `age ${Math.round(ageMin)}dk`,
    position.moonshot ? "moonshot" : "core",
    `wallet ${walletScore}`,
    position.walletStillHolding === true ? "cuzdan tutuyor" : position.walletStillHolding === false ? "cuzdan cikti" : "holding bilinmiyor"
  ];
  return { score, label, action, reasons: reasons.join(" | ") };
}

async function markToMarket(state, config) {
  const positions = [];
  let openValueTry = 0;
  let openCostTry = 0;

  for (const position of state?.positions || []) {
    const price = await getTokenPriceTry(position.mint, config.tryPerSol || 4350);
    const currentTry = price?.priceTry ?? position.entryTry;
    const sellCostPct = position.sellCostPct ?? ((config.sellSlippagePct ?? config.feeHaircutPct ?? 2) + (config.platformFeePct ?? 0));
    const priorityFeeTry = position.priorityFeeTry || config.priorityFeeTry || 0;
    const grossValueTry = position.amount * currentTry;
    const valueTry = Math.max(0, grossValueTry * (1 - sellCostPct / 100) - priorityFeeTry);
    const unrealizedTry = valueTry - position.investedTry;
    const potential = positionPotential(position, currentTry);
    openValueTry += valueTry;
    openCostTry += position.investedTry;
    positions.push({
      ...position,
      buyReason: [
        position.buyReason,
        `Potansiyel ${potential.score}/100: ${potential.label}`,
        `Aksiyon: ${potential.action}`,
        potential.reasons
      ].filter(Boolean).join(" · "),
      currentTry,
      grossValueTry,
      valueTry,
      unrealizedTry,
      unrealizedPct: position.investedTry ? (unrealizedTry / position.investedTry) * 100 : 0,
      potential,
      sellCostPct,
      url: price?.url || position.url,
      symbol: price?.symbol || position.symbol
    });
  }

  return {
    positions,
    openValueTry,
    openCostTry,
    unrealizedTry: openValueTry - openCostTry,
    equityTry: (state?.cashTry || 0) + openValueTry
  };
}

async function apiState() {
  const [config, state, events, allEvents, outLog, errLog, bot, scan] = await Promise.all([
    readJson("config.json", {}),
    readJson("paper-state.json", null),
    readEvents(120),
    readEvents(5000),
    readText("bot.out.log", ""),
    readText("bot.err.log", ""),
    getBotStatus(),
    readJson("deep-scan-result.json", null)
  ]);
  const mtm = await markToMarket(state, config);

  const walletStats = {};
  for (const wallet of config.wallets || []) {
    walletStats[wallet.name] = {
      ...wallet,
      discoveredRelated: state?.discoveredRelated?.[wallet.name] || [],
      buys: 0,
      sells: 0,
      paperBuys: 0,
      paperSells: 0,
      skipped: 0,
      realizedTry: 0,
      wins: 0,
      losses: 0,
      openPositions: 0,
      lastSignalAt: null,
      lastSymbol: null
    };
  }
  for (const event of allEvents) {
    if (!event.wallet || !walletStats[event.wallet]) continue;
    if (event.type === "BUY") walletStats[event.wallet].buys += 1;
    if (event.type === "SELL") walletStats[event.wallet].sells += 1;
    if (event.paper?.position) walletStats[event.wallet].paperBuys += 1;
    if (event.paper?.pnlTry !== undefined) {
      walletStats[event.wallet].paperSells += 1;
      walletStats[event.wallet].realizedTry += event.paper.pnlTry;
      if (event.paper.pnlTry > 0) walletStats[event.wallet].wins += 1;
      else walletStats[event.wallet].losses += 1;
    }
    if (event.paper?.skipped) walletStats[event.wallet].skipped += 1;
    if (!walletStats[event.wallet].lastSignalAt || new Date(event.time) > new Date(walletStats[event.wallet].lastSignalAt)) {
      walletStats[event.wallet].lastSignalAt = event.time;
      walletStats[event.wallet].lastSymbol = event.symbol || event.mint?.slice(0, 6);
    }
  }

  for (const position of mtm.positions || []) {
    if (walletStats[position.wallet]) walletStats[position.wallet].openPositions += 1;
  }

  const riskState = state?.risk || {};
  for (const wallet of Object.values(walletStats)) {
    const perf = riskState.walletPerformance?.[wallet.name] || {};
    wallet.guardClosed = perf.closed || 0;
    wallet.guardWins = perf.wins || 0;
    wallet.guardLosses = perf.losses || 0;
    wallet.guardRealizedTry = perf.realizedTry || 0;
    wallet.guardBlockedUntil = perf.blockedUntil || null;
    wallet.guardWinRate = perf.closed ? (perf.wins / perf.closed) * 100 : null;
    wallet.autoDemoted = riskState.autoDemoted?.[wallet.name] || null;
    wallet.cooldownLeftSec = riskState.walletLastBuyAt?.[wallet.name]
      ? Math.max(0, Math.ceil(((config.walletCooldownSec ?? 180) * 1000 - (Date.now() - new Date(riskState.walletLastBuyAt[wallet.name]).getTime())) / 1000))
      : 0;
    wallet.noiseCount = (riskState.walletBuySignals?.[wallet.name] || [])
      .filter((time) => Date.now() - Number(time) < (config.walletSignalWindowSec ?? 60) * 1000)
      .length;
  }

  const adjustedExitKeys = new Set(state?.adjustedExitKeys || []);
  const exitKey = (item) => [
    item.time,
    item.wallet || item.kind || "-",
    item.mint || "",
    Number(item.paper?.pnlTry ?? item.pnlTry ?? 0).toFixed(6)
  ].join("|");
  const closedTradeKey = (item) => [
    item.signature || "",
    item.wallet || "-",
    item.mint || "",
    item.reason || item.paper?.reason || "",
    Number(item.pnlTry ?? item.paper?.pnlTry ?? 0).toFixed(6),
    Number(item.exitPriceTry || 0).toPrecision(12)
  ].join("|");

  const closedTrades = [
    ...(state?.closedTrades || []),
    ...allEvents
      .filter((event) => event.paper?.pnlTry !== undefined || event.kind === "RISK_EXIT")
      .filter((event) => !adjustedExitKeys.has(exitKey(event)))
      .map((event) => ({
      time: event.time,
      signature: event.signature || null,
      wallet: event.wallet || event.kind || "-",
      symbol: event.symbol || event.mint?.slice(0, 6),
      mint: event.mint,
      pnlTry: event.paper?.pnlTry ?? event.pnlTry ?? 0,
      reason: event.paper?.reason || event.reason || "wallet sell",
      url: event.url
      }))
  ]
    .filter((trade) => !adjustedExitKeys.has(exitKey(trade)))
    .filter((trade) => Math.abs(Number(trade.pnlTry || 0)) <= 1000)
    .filter((trade, index, list) => index === list.findIndex((item) => closedTradeKey(item) === closedTradeKey(trade)))
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 80);

  const eventsChrono = [...allEvents].sort((a, b) => new Date(a.time) - new Date(b.time));
  const pricedByMint = new Map();
  for (const event of eventsChrono) {
    if (!event.mint || !event.priceUsd) continue;
    const records = pricedByMint.get(event.mint) || [];
    records.push(event);
    pricedByMint.set(event.mint, records);
  }
  const recoveryTrades = eventsChrono
    .filter((event) => !adjustedExitKeys.has(exitKey(event)))
    .filter((event) => {
      const pnlTry = event.paper?.pnlTry ?? event.pnlTry;
      const proceedsTry = event.paper?.proceedsTry ?? event.proceedsTry;
      return Number(pnlTry) < 0 && event.priceUsd && Number(proceedsTry) > 0;
    })
    .map((event) => {
      const future = (pricedByMint.get(event.mint) || []).filter((item) => new Date(item.time) > new Date(event.time));
      const peak = future.reduce((best, item) => Number(item.priceUsd) > Number(best?.priceUsd || 0) ? item : best, null);
      if (!peak) return null;
      const pnlTry = event.paper?.pnlTry ?? event.pnlTry;
      const proceedsTry = event.paper?.proceedsTry ?? event.proceedsTry;
      const reason = event.paper?.reason || event.reason || "wallet sell";
      const costTry = proceedsTry - pnlTry;
      const priceRatio = Number(peak.priceUsd) / Number(event.priceUsd);
      if (!Number.isFinite(priceRatio) || priceRatio <= 0 || priceRatio > 25) return null;
      const peakValueTry = proceedsTry * priceRatio;
      const peakPnlTry = peakValueTry - costTry;
      const missedTry = peakPnlTry - pnlTry;
      if (Math.abs(missedTry) > 5000) return null;
      return {
        time: event.time,
        wallet: event.wallet,
        symbol: event.symbol || event.mint.slice(0, 6),
        mint: event.mint,
        url: event.url,
        soldPnlTry: pnlTry,
        peakPnlTry,
        missedTry,
        exitPriceUsd: event.priceUsd,
        peakPriceUsd: peak.priceUsd,
        peakAt: peak.time,
        recovered: peakPnlTry > 0,
        reason,
        category: reason.startsWith("wallet sell")
          ? "Cüzdan da sattı"
          : peakPnlTry > 0
            ? "Biz erken çıktık"
            : "Doğru kaçış"
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.missedTry - a.missedTry)
    .slice(0, 50);

  const watchlist = (scan?.ranked || []).slice(0, 20).map((item, index) => ({
    rank: index + 1,
    name: (config.wallets || []).find((wallet) => wallet.address === item.wallet)?.name || `Watch-${String(index + 1).padStart(2, "0")}`,
    wallet: item.wallet,
    tracked: Boolean((config.wallets || []).find((wallet) => wallet.address === item.wallet)),
    hits: item.hits,
    tokens: item.tokens,
    closed: item.closed,
    winRate: item.winRate,
    pnlSol: item.pnlSol,
    biggestLossSol: item.biggestLossSol,
    score: item.score
  }));

  const walletConfigByName = new Map((config.wallets || []).map((wallet) => [wallet.name, wallet]));
  const radarSince = Date.now() - 60 * 60000;
  const signalClusters = new Map();
  for (const event of allEvents) {
    if (!event.mint || !event.time || new Date(event.time).getTime() < radarSince) continue;
    const cluster = signalClusters.get(event.mint) || {
      mint: event.mint,
      symbol: event.symbol || event.mint.slice(0, 6),
      url: event.url,
      buyers: new Set(),
      sellers: new Set(),
      copyBuyers: new Set(),
      buys: 0,
      sells: 0,
      lastAt: event.time,
      lastPriceUsd: event.priceUsd || null,
      skippedReasons: []
    };
    cluster.symbol = event.symbol || cluster.symbol;
    cluster.url = event.url || cluster.url;
    cluster.lastAt = new Date(event.time) > new Date(cluster.lastAt) ? event.time : cluster.lastAt;
    cluster.lastPriceUsd = event.priceUsd || cluster.lastPriceUsd;
    if (event.type === "BUY") {
      cluster.buys += 1;
      if (event.wallet) cluster.buyers.add(event.wallet);
      if (event.wallet && walletConfigByName.get(event.wallet)?.mode === "copy") cluster.copyBuyers.add(event.wallet);
      if (event.paper?.skipped) cluster.skippedReasons.push(event.paper.skipped);
    }
    if (event.type === "SELL") {
      cluster.sells += 1;
      if (event.wallet) cluster.sellers.add(event.wallet);
    }
    signalClusters.set(event.mint, cluster);
  }

  const signalRadar = [...signalClusters.values()]
    .map((cluster) => {
      const uniqueBuyers = cluster.buyers.size;
      const copyBuyers = cluster.copyBuyers.size;
      const uniqueSellers = cluster.sellers.size;
      const sellPressure = uniqueBuyers ? uniqueSellers / uniqueBuyers : uniqueSellers;
      const score =
        uniqueBuyers * 24 +
        copyBuyers * 18 +
        Math.min(24, cluster.buys * 4) -
        uniqueSellers * 12 -
        Math.min(16, Math.max(0, sellPressure - 0.5) * 20) -
        Math.min(12, cluster.skippedReasons.filter((reason) => /liquidity|volume|mcap/i.test(reason)).length * 4);
      const label =
        score >= 75 ? "Sıcak fırsat" :
        score >= 50 ? "Takip güçlü" :
        score >= 30 ? "Bekle/doğrula" :
        "Zayıf";
      return {
        mint: cluster.mint,
        symbol: cluster.symbol,
        url: cluster.url,
        uniqueBuyers,
        copyBuyers,
        uniqueSellers,
        buys: cluster.buys,
        sells: cluster.sells,
        lastAt: cluster.lastAt,
        lastPriceUsd: cluster.lastPriceUsd,
        score: Math.max(0, Math.round(score)),
        label,
        buyers: [...cluster.buyers].slice(0, 8),
        skippedReasons: [...new Set(cluster.skippedReasons)].slice(0, 3)
      };
    })
    .filter((cluster) => cluster.buys > 0)
    .sort((a, b) => b.score - a.score || new Date(b.lastAt) - new Date(a.lastAt))
    .slice(0, 25);

  const configured = new Map((config.wallets || []).map((wallet) => [wallet.address, wallet]));
  const moonshot = (scan?.ranked || [])
    .map((item, index) => {
      const best = item.best || [];
      const worst = item.worst || [];
      const bestRoi = best.reduce((max, trade) => Math.max(max, Number(trade.roiPct || 0)), 0);
      const bestPnl = best.reduce((max, trade) => Math.max(max, Number(trade.pnlSol || 0)), 0);
      const threeX = best.filter((trade) => Number(trade.roiPct || 0) >= 200).length;
      const fiveX = best.filter((trade) => Number(trade.roiPct || 0) >= 400).length;
      const worstLoss = Number(item.biggestLossSol || worst[0]?.pnlSol || 0);
      const trackedWallet = configured.get(item.wallet);
      const moonScore =
        Math.min(40, bestRoi / 25) +
        Math.min(25, Math.max(0, Number(item.pnlSol || 0)) * 4) +
        Math.min(20, threeX * 7 + fiveX * 6) +
        Math.min(10, Number(item.closed || 0) / 3) -
        Math.min(25, Math.abs(Math.min(0, worstLoss)) * 8);
      const riskLotTry =
        moonScore >= 65 ? 150 :
        moonScore >= 45 ? 100 :
        moonScore >= 30 ? 50 : 25;
      return {
        rank: index + 1,
        name: trackedWallet?.name || `Moon-${String(index + 1).padStart(2, "0")}`,
        wallet: item.wallet,
        tracked: Boolean(trackedWallet),
        tokens: item.tokens || [],
        closed: item.closed,
        winRate: item.winRate,
        pnlSol: item.pnlSol,
        biggestLossSol: worstLoss,
        bestRoi,
        bestPnl,
        threeX,
        fiveX,
        moonScore: Number(moonScore.toFixed(1)),
        riskLotTry,
        reason: [
          bestRoi >= 400 ? `${(bestRoi / 100 + 1).toFixed(1)}x üstü yakalamış` : null,
          threeX ? `${threeX} adet 3x+ örnek` : null,
          fiveX ? `${fiveX} adet 5x+ örnek` : null,
          Number(item.pnlSol || 0) > 0 ? `net +${Number(item.pnlSol).toFixed(2)} SOL` : null,
          Math.abs(Math.min(0, worstLoss)) <= 0.25 ? "zarar kontrolü makul" : "zarar riski yüksek"
        ].filter(Boolean).join(" · "),
        best: best.slice(0, 3),
        worst: worst.slice(0, 2)
      };
    })
    .filter((item) => item.bestRoi >= 150 || item.threeX > 0 || item.bestPnl >= 1)
    .sort((a, b) => b.moonScore - a.moonScore)
    .slice(0, 30);

  const walletScoreboard = Object.values(walletStats)
    .map((wallet) => ({
      ...wallet,
      winRate: wallet.paperSells ? (wallet.wins / wallet.paperSells) * 100 : null
    }))
    .sort((a, b) =>
      ((b.name || "").startsWith("Kume") ? 1 : 0) - ((a.name || "").startsWith("Kume") ? 1 : 0) ||
      (b.realizedTry - a.realizedTry) ||
      ((b.score || 0) - (a.score || 0))
    );

  return {
    now: new Date().toISOString(),
    lastEventAt: events[0]?.time || null,
    lastEventSymbol: events[0]?.symbol || null,
    bot,
    config: publicConfig(config),
    state,
    mtm,
    events,
    walletStats: walletScoreboard,
    closedTrades,
    recoveryTrades,
    watchlist,
    signalRadar,
    moonshot,
    riskGuards: {
      maxCoreOpenPositions: config.maxCoreOpenPositions ?? null,
      maxMoonshotOpenPositions: config.maxMoonshotOpenPositions ?? null,
      maxOpenPerWallet: config.maxOpenPerWallet ?? null,
      maxBuyMarketCapUsd: config.maxBuyMarketCapUsd ?? null,
      minLiquidityUsd: config.minLiquidityUsd ?? null,
      minVolume24hUsd: config.minVolume24hUsd ?? null,
      strongLiquidityUsd: config.strongLiquidityUsd ?? null,
      strongVolume24hUsd: config.strongVolume24hUsd ?? null,
      minPairAgeSec: config.minPairAgeSec ?? null,
      maxPairAgeHours: config.maxPairAgeHours ?? null,
      minTxns5m: config.minTxns5m ?? null,
      rejectNoLiquidity: config.rejectNoLiquidity ?? false,
      authorityRiskGate: config.authorityRiskGate ?? false,
      rejectMintAuthority: config.rejectMintAuthority ?? false,
      rejectFreezeAuthority: config.rejectFreezeAuthority ?? false,
      maxTopHolderPct: config.maxTopHolderPct ?? null,
      maxTop10HolderPct: config.maxTop10HolderPct ?? null,
      rejectPaidDexOrders: config.rejectPaidDexOrders ?? false,
      requireMultiWalletConfirm: config.requireMultiWalletConfirm ?? false,
      confirmMinWallets: config.confirmMinWallets ?? null,
      confirmWindowMin: config.confirmWindowMin ?? null,
      singleWalletScoutMode: config.singleWalletScoutMode ?? true,
      singleWalletScoutMinScore: config.singleWalletScoutMinScore ?? null,
      singleWalletScoutTradeTry: config.singleWalletScoutTradeTry ?? null,
      dynamicLotSizing: config.dynamicLotSizing ?? false,
      dynamicMinTradeTry: config.dynamicMinTradeTry ?? null,
      dynamicMaxTradeTry: config.dynamicMaxTradeTry ?? null,
      dynamicMaxMultiplier: config.dynamicMaxMultiplier ?? null,
      sourceSizeGateEnabled: config.sourceSizeGateEnabled ?? false,
      minSourceBuySol: config.minSourceBuySol ?? null,
      maxSourceBuySol: config.maxSourceBuySol ?? null,
      sourceScaleEnabled: config.sourceScaleEnabled ?? false,
      sourceScalePct: config.sourceScalePct ?? null,
      vetoBuyOnSellPressure: config.vetoBuyOnSellPressure ?? false,
      sellPressureWindowMin: config.sellPressureWindowMin ?? null,
      sellPressureMinSellers: config.sellPressureMinSellers ?? null,
      sellPressureVetoRatio: config.sellPressureVetoRatio ?? null,
      exitOnSellPressure: config.exitOnSellPressure ?? false,
      exitSellPressureMinSellers: config.exitSellPressureMinSellers ?? null,
      exitSellPressureRatio: config.exitSellPressureRatio ?? null,
      sellPressureExitFraction: config.sellPressureExitFraction ?? null,
      maxDailyDrawdownTry: config.maxDailyDrawdownTry ?? null,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct ?? null,
      dailyDrawdownCooldownMin: config.dailyDrawdownCooldownMin ?? null,
      dailyGuard: riskState.dailyGuard || null,
      globalLossBrake: config.globalLossBrake ?? false,
      maxConsecutiveLosses: config.maxConsecutiveLosses ?? null,
      globalLossBrakeCooldownMin: config.globalLossBrakeCooldownMin ?? null,
      globalPerformance: riskState.globalPerformance || null,
      tokenLossBlockTry: config.tokenLossBlockTry ?? null,
      tokenLossBlockMin: config.tokenLossBlockMin ?? null,
      tokenBlockCount: Object.values(riskState.tokenBlocklist || {}).filter((item) => item?.blockedUntil && new Date(item.blockedUntil).getTime() > Date.now()).length,
      autoDemoteLosers: config.autoDemoteLosers ?? false,
      autoDemoteMinClosed: config.autoDemoteMinClosed ?? null,
      autoDemoteWinRatePct: config.autoDemoteWinRatePct ?? null,
      autoDemoteRealizedTry: config.autoDemoteRealizedTry ?? null,
      autoDemoteCooldownMin: config.autoDemoteCooldownMin ?? null,
      walletCooldownSec: config.walletCooldownSec ?? null,
      tokenCooldownMin: config.tokenCooldownMin ?? null,
      maxWalletBuySignalsPerMinute: config.maxWalletBuySignalsPerMinute ?? null,
      runnerExitIfWalletSoldBelowPct: config.runnerExitIfWalletSoldBelowPct ?? null,
      noPriceRetryDelaySec: config.noPriceRetryDelaySec ?? null,
      noPriceRetryMaxAgeSec: config.noPriceRetryMaxAgeSec ?? null,
      pendingPriceSignals: state?.pendingPriceSignals?.length || 0,
      coreProfitLockTry: config.coreProfitLockTry ?? null,
      coreProfitLockFraction: config.coreProfitLockFraction ?? null,
      penaltyWinRatePct: config.penaltyWinRatePct ?? null,
      penaltyRealizedTry: config.penaltyRealizedTry ?? null,
      walletPenaltyCooldownMin: config.walletPenaltyCooldownMin ?? null
    },
    ideas: [
      "2 cüzdan onayı: aynı tokenı 15 dk içinde iki izlenen cüzdan alırsa lot büyüsün.",
      "Kâr koruma modu: portföy günlük tepeye göre %10 geri verirse yeni alımlar 30 dk dursun.",
      "Likidite filtresi: düşük likidite + yüksek hacim şişmesi varsa sadece alarm ver.",
      "Cüzdan form grafiği: son 5 kapanışta zarar eden cüzdan otomatik mini lota düşsün.",
      "Cüzdan çıktıysa biz de çıkarız; moonshot runner sadece cüzdan tutarken anlamlı.",
      "Günlük zarar freni: portföy tepeden sert düşerse yeni alımı durdur, sadece çıkışları yönet.",
      "Kalite kapısı: likidite/hacim çok zayıfsa copy sinyalini paperda bile ele."
    ],
    logs: {
      out: outLog.split(/\r?\n/).slice(-80).join("\n"),
      err: errLog.split(/\r?\n/).slice(-40).join("\n")
    }
  };
}

async function cachedApiState(maxAgeMs = 2500) {
  const now = Date.now();
  if (stateCache.value && now - stateCache.at < maxAgeMs) return stateCache.value;
  if (stateCache.promise) return stateCache.promise;
  stateCache.promise = apiState()
    .then((value) => {
      stateCache = { at: Date.now(), value, promise: null };
      return value;
    })
    .catch((error) => {
      stateCache.promise = null;
      throw error;
    });
  return stateCache.promise;
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

async function sendStateEvent(res) {
  res.write(`event: state\n`);
  res.write(`data: ${JSON.stringify(await cachedApiState())}\n\n`);
}

function pageHtml(view = "home") {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Solana Paper Copy Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f14;
      --panel: #121923;
      --panel2: #0f151d;
      --line: #263241;
      --text: #e7edf5;
      --muted: #8fa0b5;
      --good: #35d08c;
      --bad: #ff5e6c;
      --warn: #f2c14e;
      --blue: #6bb7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      background: rgba(11, 15, 20, .96);
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 18px; font-weight: 700; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--panel);
      font-size: 13px;
      white-space: nowrap;
    }
    .nav { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    a.btn {
      color: var(--text);
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 9px 12px;
      text-decoration: none;
      font-size: 13px;
    }
    .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--bad); }
    .dot.on { background: var(--good); box-shadow: 0 0 16px rgba(53,208,140,.55); }
    main { padding: 18px; display: grid; gap: 16px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px; min-height: 90px; }
    .label { color: var(--muted); font-size: 12px; }
    .value { font-size: 26px; font-weight: 800; margin-top: 8px; letter-spacing: 0; }
    .value.good { color: var(--good); }
    .value.bad { color: var(--bad); }
    .grid {
      display: grid;
      grid-template-columns: 1.15fr .85fr;
      gap: 16px;
      align-items: start;
    }
    .grid.three {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .wide { grid-column: 1 / -1; }
    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 14px;
      border-bottom: 1px solid var(--line);
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(38,50,65,.7);
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    tr:last-child td { border-bottom: 0; }
    .tag {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      color: var(--muted);
      background: var(--panel2);
      font-size: 12px;
    }
    .tag.buy { color: var(--good); border-color: rgba(53,208,140,.4); }
    .tag.sell { color: var(--bad); border-color: rgba(255,94,108,.4); }
    .tag.copy { color: var(--blue); }
    .tag.A { color: var(--good); border-color: rgba(53,208,140,.45); }
    .tag.B { color: var(--blue); border-color: rgba(107,183,255,.45); }
    .tag.C, .tag.AG { color: var(--warn); border-color: rgba(242,193,78,.45); }
    .tag.D, .tag.alert { color: var(--bad); border-color: rgba(255,94,108,.45); }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--muted); }
    .small { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .goodText { color: var(--good); }
    .badText { color: var(--bad); }
    .warnText { color: var(--warn); }
    a { color: var(--blue); text-decoration: none; }
    .events { max-height: 620px; overflow: auto; }
    .table-scroll { width: 100%; overflow-x: auto; }
    .table-scroll table { min-width: 640px; }
    .log {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      padding: 12px 14px;
      max-height: 240px;
      overflow: auto;
      background: var(--panel2);
    }
    .empty { padding: 16px; color: var(--muted); }
    .page-section { display: none; }
    body[data-view="home"] .page-section[data-page~="home"],
    body[data-view="wallets"] .page-section[data-page~="wallets"],
    body[data-view="signals"] .page-section[data-page~="signals"],
    body[data-view="positions"] .page-section[data-page~="positions"],
    body[data-view="trades"] .page-section[data-page~="trades"],
    body[data-view="strategy"] .page-section[data-page~="strategy"],
    body[data-view="logs"] .page-section[data-page~="logs"] { display: grid; }
    .nav a.active { border-color: rgba(107,183,255,.65); color: var(--blue); }
    @media (max-width: 900px) {
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid, .grid.three { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
    @media (max-width: 560px) {
      header { padding: 18px 16px; }
      h1 { font-size: 26px; line-height: 1.1; }
      .sub { font-size: 17px; line-height: 1.35; }
      .status-pill { font-size: 18px; padding: 12px 14px; }
      main { padding: 16px; gap: 18px; }
      .metrics { grid-template-columns: 1fr; }
      .metric { min-height: 116px; padding: 22px; }
      .label { font-size: 18px; }
      .value { font-size: 40px; }
      .panel h2 { font-size: 21px; padding: 16px 18px; }
      th, td { padding: 14px 16px; font-size: 16px; }
      th { font-size: 15px; }
      .small, .mono, .tag { font-size: 15px; }
      .log { font-size: 16px; max-height: 360px; }
      .events { max-height: none; }
    }
    @media (max-width: 640px) {
      html { -webkit-text-size-adjust: 100%; scroll-padding-top: 132px; }
      body { overflow-x: hidden; }
      header { padding: 12px; max-height: 48vh; overflow: auto; }
      h1 { font-size: 22px; }
      .sub { font-size: 13px; }
      .nav { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 6px; margin-left: -2px; margin-right: -2px; -webkit-overflow-scrolling: touch; }
      .nav a, a.btn { flex: 0 0 auto; white-space: nowrap; font-size: 13px; padding: 9px 11px; }
      main { padding: 12px; gap: 12px; }
      .metrics { grid-template-columns: 1fr 1fr; gap: 10px; }
      .metric { min-height: 84px; padding: 12px; }
      .label { font-size: 12px; }
      .value { font-size: 24px; overflow-wrap: anywhere; }
      .panel h2 { font-size: 16px; padding: 12px; }
      .table-scroll { border-radius: 8px; -webkit-overflow-scrolling: touch; }
      .table-scroll table { min-width: 560px; }
      th, td { padding: 10px; font-size: 13px; }
      th, .small, .mono, .tag { font-size: 12px; }
      .log { font-size: 12px; max-height: 280px; }
    }
    @media (max-width: 380px) { .metrics { grid-template-columns: 1fr; } }
  </style>
</head>
<body data-view="${view}">
  <header>
    <div>
      <h1>Solana Paper Copy Dashboard</h1>
      <div class="sub">Gerçek emir kapalı. Bu ekran sadece simülasyon ve sinyal takibi yapar.</div>
      <div class="nav">
        <a class="btn ${view === "home" ? "active" : ""}" href="/">Ana Sayfa</a>
        <a class="btn ${view === "wallets" ? "active" : ""}" href="/wallets">Cüzdanlar</a>
        <a class="btn ${view === "signals" ? "active" : ""}" href="/signals">Sinyaller</a>
        <a class="btn ${view === "positions" ? "active" : ""}" href="/positions">Pozisyonlar</a>
        <a class="btn ${view === "trades" ? "active" : ""}" href="/trades">İşlem Geçmişi</a>
        <a class="btn ${view === "strategy" ? "active" : ""}" href="/strategy">Strateji</a>
        <a class="btn" href="/control">Kontrol</a>
        <a class="btn ${view === "logs" ? "active" : ""}" href="/logs">Ayar/Log</a>
        <a class="btn" href="/token-research">Token Arastir</a>
        <a class="btn" href="/wallet-research">Cuzdan Arastir</a>
        <a class="btn" href="/moonshot">Moonshot</a>
        <a class="btn" href="/chat">Sohbet</a>
      </div>
    </div>
    <div class="status-pill"><span id="dot" class="dot"></span><span id="botStatus">Bağlanıyor...</span><span id="pulse" class="mono"></span></div>
  </header>
  <main>
    <section class="metrics page-section" data-page="home positions trades strategy">
      <div class="metric"><div class="label">Nakit Kasa</div><div id="cash" class="value">-</div></div>
      <div class="metric"><div class="label">Portföy Değeri</div><div id="equity" class="value">-</div></div>
      <div class="metric"><div class="label">Açık Brüt Değer</div><div id="grossOpen" class="value">-</div></div>
      <div class="metric"><div class="label">Realized PnL</div><div id="realized" class="value">-</div></div>
      <div class="metric"><div class="label">Unrealized PnL</div><div id="unrealized" class="value">-</div></div>
      <div class="metric"><div class="label">Açık Pozisyon</div><div id="openCount" class="value">-</div></div>
      <div class="metric"><div class="label">API Yenileme</div><div id="updated" class="value" style="font-size:18px">-</div></div>
    </section>

    <section class="grid three page-section" data-page="wallets">
      <div class="panel">
        <h2>Cüzdan Durumları</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Cüzdan</th><th>Sınıf</th><th>Durum</th><th>PnL</th></tr></thead>
          <tbody id="walletScoreboard"></tbody>
        </table>
        </div>
      </div>
      <div class="panel">
        <h2>Takip Listesi</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>İsim</th><th>Win</th><th>PnL</th><th>Durum</th></tr></thead>
          <tbody id="watchlist"></tbody>
        </table>
        </div>
      </div>
      <div class="panel">
        <h2>Strateji Notu</h2>
        <div class="log" id="strategyNote"></div>
      </div>
    </section>

    <section class="grid page-section" data-page="home strategy">
      <div class="panel">
        <h2>Strateji Notu</h2>
        <div class="log" id="strategyNoteHome"></div>
      </div>
      <div class="panel">
        <h2>Risk Kapıları</h2>
        <div class="log" id="riskGuards"></div>
      </div>
      <div class="panel">
        <h2>Yeni Fikirler</h2>
        <div class="log" id="ideas"></div>
      </div>
    </section>

    <section class="grid page-section" data-page="home wallets strategy">
      <div class="panel">
        <h2>Kahin Motoru</h2>
        <div class="log" id="oracleModules"></div>
      </div>
      <div class="panel">
        <h2>Radar Özeti</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Skor</th><th>Alıcı/Satıcı</th><th>Durum</th></tr></thead>
          <tbody id="miniRadar"></tbody>
        </table>
        </div>
      </div>
    </section>

    <section class="grid page-section" data-page="signals">
      <div class="panel">
        <h2>Son Sinyaller</h2>
        <div class="events">
          <div class="table-scroll">
          <table>
            <thead><tr><th>Zaman</th><th>Cüzdan</th><th>Yön</th><th>Token</th><th>Paper</th></tr></thead>
            <tbody id="events"></tbody>
          </table>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Takip Cüzdanları</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>İsim</th><th>Mod</th><th>Sinyal</th><th>Paper</th></tr></thead>
          <tbody id="wallets"></tbody>
        </table>
        </div>
      </div>
    </section>

    <section class="grid page-section" data-page="positions trades">
      <div class="panel">
        <h2>Açık Pozisyonlar</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Cüzdan</th><th>Yatırım</th><th>Neden Alındı?</th></tr></thead>
          <tbody id="positions"></tbody>
        </table>
        </div>
      </div>
      <div class="panel">
        <h2>Alınıp Satılanlar</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Zaman</th><th>Token</th><th>Cüzdan</th><th>Sonuç</th></tr></thead>
          <tbody id="closedTrades"></tbody>
        </table>
        </div>
      </div>
    </section>

    <section class="grid page-section" data-page="logs">
      <div class="panel">
        <h2>Bot Log</h2>
        <div id="log" class="log"></div>
      </div>
      <div class="panel">
        <h2>Bot Ayarları</h2>
        <div id="settings" class="log"></div>
      </div>
    </section>

    <section class="grid page-section" data-page="trades strategy">
      <div class="panel wide">
        <h2>Satmasaydık Ne Olurdu?</h2>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Cüzdan</th><th>Bizim Çıkış</th><th>Sonraki Zirve</th><th>Fark</th></tr></thead>
          <tbody id="recoveryTrades"></tbody>
        </table>
        </div>
      </div>
    </section>
  </main>
  <script>
    const fmtTry = value => Number(value || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' TL';
    const short = value => value ? value.slice(0, 6) + '...' + value.slice(-4) : '-';
    const time = iso => iso ? new Date(iso).toLocaleTimeString('tr-TR') : '-';
    const age = iso => {
      if (!iso) return '-';
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
      if (seconds < 60) return seconds + ' sn önce';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + ' dk önce';
      return Math.floor(minutes / 60) + ' sa önce';
    };

    function paperText(event) {
      if (event.paper?.position) return 'BUY ' + fmtTry(event.paper.position.investedTry);
      if (event.paper?.pnlTry !== undefined) return 'SELL PnL ' + fmtTry(event.paper.pnlTry);
      if (event.paper?.skipped) return event.paper.skipped;
      if (event.reason) return event.reason;
      return '-';
    }

    const pnlClass = value => Number(value || 0) >= 0 ? 'goodText' : 'badText';
    const pctText = value => value === null || value === undefined ? '-' : Number(value).toFixed(1) + '%';
    const solText = value => value === null || value === undefined ? '-' : Number(value).toFixed(3) + ' SOL';

    let refreshCount = 0;
    let lastPayloadAt = 0;

    function render(data) {
      refreshCount += 1;
      lastPayloadAt = Date.now();
      const state = data.state || { cashTry: 0, realizedTry: 0, positions: [] };
      const mtm = data.mtm || { equityTry: state.cashTry || 0, unrealizedTry: 0, positions: [] };
      const running = data.bot?.running;

      document.getElementById('dot').className = 'dot' + (running ? ' on' : '');
      document.getElementById('botStatus').textContent = running ? 'Bot çalışıyor' : 'Bot kapalı';
      document.getElementById('pulse').textContent = 'yenileme #' + refreshCount;
      document.getElementById('cash').textContent = fmtTry(state.cashTry);
      document.getElementById('equity').textContent = fmtTry(mtm.equityTry);
      document.getElementById('grossOpen').textContent = fmtTry((mtm.positions || []).reduce((sum, p) => sum + (p.grossValueTry || 0), 0));
      document.getElementById('realized').textContent = fmtTry(state.realizedTry);
      document.getElementById('realized').className = 'value ' + (state.realizedTry >= 0 ? 'good' : 'bad');
      document.getElementById('unrealized').textContent = fmtTry(mtm.unrealizedTry);
      document.getElementById('unrealized').className = 'value ' + (mtm.unrealizedTry >= 0 ? 'good' : 'bad');
      document.getElementById('openCount').textContent = String(state.positions?.length || 0);
      document.getElementById('updated').textContent = time(data.now) + ' (#' + refreshCount + ') / son sinyal ' + (data.lastEventAt ? age(data.lastEventAt) : '-');

      document.getElementById('strategyNote').textContent =
        'A sınıfı normal lot, B sınıfı küçük lot, AG sınıfı mini lot çalışır. ' +
        'Maksimum açık pozisyon: ' + (data.config?.maxOpenPositions ?? '-') + '.\\n' +
        'Gerçek emir kapalı; burası cüzdan eleme ve risk test ekranı. ' +
        'Cüzdan win rate tek başına yeterli değil: net PnL, en büyük zarar ve tekrar eden başarı birlikte izlenir.';

      document.getElementById('strategyNoteHome').textContent = document.getElementById('strategyNote').textContent;

      const guards = data.riskGuards || {};
      document.getElementById('riskGuards').textContent =
        'Max core pozisyon: ' + (guards.maxCoreOpenPositions ?? '-') + '\\n' +
        'Max moonshot pozisyon: ' + (guards.maxMoonshotOpenPositions ?? '-') + '\\n' +
        'Max alim mcap: $' + Number(guards.maxBuyMarketCapUsd || 0).toLocaleString('en-US') + '\\n' +
        'Min likidite: $' + Number(guards.minLiquidityUsd || 0).toLocaleString('en-US') + ' · min hacim: $' + Number(guards.minVolume24hUsd || 0).toLocaleString('en-US') + '\\n' +
        'Token güvenlik: ' + (guards.authorityRiskGate ? 'authority/holder açık' : 'authority kapalı') + ' · top1 ' + (guards.maxTopHolderPct ?? 0) + '% · top10 ' + (guards.maxTop10HolderPct ?? 0) + '% · paid hype ' + (guards.rejectPaidDexOrders ? 'red' : 'izle') + '\\n' +
        'Pair aktivite: min yaş ' + (guards.minPairAgeSec ?? 0) + ' sn · max yaş ' + (guards.maxPairAgeHours ?? 0) + ' sa · min 5dk tx ' + (guards.minTxns5m ?? 0) + '\\n' +
        '2 cüzdan onayı: ' + (guards.requireMultiWalletConfirm ? 'açık ' + (guards.confirmMinWallets ?? '-') + ' cüzdan / ' + (guards.confirmWindowMin ?? '-') + ' dk' : 'kapalı') + '\\n' +
        'Dinamik lot: ' + (guards.dynamicLotSizing ? 'açık ' + fmtTry(guards.dynamicMinTradeTry ?? 0) + '-' + fmtTry(guards.dynamicMaxTradeTry ?? 0) : 'kapalı') + '\\n' +
        'Kaynak işlem boyutu: ' + (guards.sourceSizeGateEnabled ? 'kapı açık min ' + (guards.minSourceBuySol ?? 0) + ' SOL' : 'kapı kapalı') + ' · ölçek ' + (guards.sourceScaleEnabled ? '%' + Number((guards.sourceScalePct ?? 0) * 100).toFixed(0) : 'kapalı') + '\\n' +
        'Satış baskısı veto/çıkış: ' + (guards.vetoBuyOnSellPressure ? 'veto açık' : 'veto kapalı') + ' · ' + (guards.exitOnSellPressure ? 'çıkış açık' : 'çıkış kapalı') + '\\n' +
        'Günlük zarar freni: ' + fmtTry(guards.maxDailyDrawdownTry ?? 0) + ' veya %' + (guards.maxDailyDrawdownPct ?? 0) + ' · durum ' + (guards.dailyGuard?.blockedUntil ? 'blok ' + time(guards.dailyGuard.blockedUntil) : 'serbest') + '\\n' +
        'Global zarar serisi: ' + (guards.globalPerformance?.blockedUntil ? 'blok ' + time(guards.globalPerformance.blockedUntil) : 'serbest') + ' · seri ' + (guards.globalPerformance?.consecutiveLosses ?? 0) + ' · token blok ' + (guards.tokenBlockCount ?? 0) + '\\n' +
        'Auto cüzdan freni: ' + (guards.autoDemoteLosers ? 'açık WR<%' + (guards.autoDemoteWinRatePct ?? '-') + ' PnL<=' + fmtTry(guards.autoDemoteRealizedTry ?? 0) : 'kapalı') + '\\n' +
        'Core profit lock: +' + fmtTry(guards.coreProfitLockTry ?? 0) + ' olunca %' + Number((guards.coreProfitLockFraction ?? 0) * 100).toFixed(0) + ' sat\\n' +
        'Cuzdan basina acik pozisyon: ' + (guards.maxOpenPerWallet ?? '-') + '\\n' +
        'Cuzdan cooldown: ' + (guards.walletCooldownSec ?? '-') + ' sn\\n' +
        'Token tekrar cooldown: ' + (guards.tokenCooldownMin ?? '-') + ' dk\\n' +
        'Gurultu limiti: ' + (guards.maxWalletBuySignalsPerMinute ?? '-') + ' buy/dk\\n' +
        'No price retry: ' + (guards.pendingPriceSignals ?? 0) + ' bekliyor · ' + (guards.noPriceRetryDelaySec ?? '-') + ' sn aralik · ' + (guards.noPriceRetryMaxAgeSec ?? '-') + ' sn max\\n' +
        'Cuzdan ciktiyse: tam cikis\\n' +
        'Ceza: WR < %' + (guards.penaltyWinRatePct ?? '-') + ' ve PnL <= ' + fmtTry(guards.penaltyRealizedTry ?? 0) + '\\n' +
        'Ceza suresi: ' + (guards.walletPenaltyCooldownMin ?? '-') + ' dk';

      document.getElementById('ideas').textContent = (data.ideas || []).map((idea, index) => (index + 1) + '. ' + idea).join('\\n\\n');

      document.getElementById('oracleModules').textContent = [
        '1. Dinamik lot: ' + (data.config?.dynamicLotSizing ? 'açık' : 'kapalı') + ' · aralık ' + fmtTry(data.config?.dynamicMinTradeTry || 0) + '-' + fmtTry(data.config?.dynamicMaxTradeTry || 0),
        '2. Kaynak işlem boyutu: ' + (data.config?.sourceSizeGateEnabled ? 'açık min ' + (data.config?.minSourceBuySol || 0) + ' SOL' : 'kapalı') + ' · source-scale ' + (data.config?.sourceScaleEnabled ? '%' + Number((data.config?.sourceScalePct || 0) * 100).toFixed(0) : 'kapalı'),
        '3. Çoklu cüzdan onayı: ' + (data.config?.requireMultiWalletConfirm ? 'açık' : 'kapalı') + ' · ' + (data.config?.confirmMinWallets || 0) + ' cüzdan / ' + (data.config?.confirmWindowMin || 0) + ' dk',
        '4. Satış baskısı veto: ' + (data.config?.vetoBuyOnSellPressure ? 'açık' : 'kapalı') + ' · pencere ' + (data.config?.sellPressureWindowMin || 0) + ' dk',
        '5. Satış baskısı çıkış: ' + (data.config?.exitOnSellPressure ? 'açık' : 'kapalı') + ' · oran ' + Number((data.config?.sellPressureExitFraction || 0) * 100).toFixed(0) + '%',
        '6. Authority/holder güvenliği: ' + (data.config?.authorityRiskGate ? 'açık' : 'kapalı') + ' · top1 ' + (data.config?.maxTopHolderPct || 0) + '% · top10 ' + (data.config?.maxTop10HolderPct || 0) + '%',
        '7. Pair yaş/aktivite filtresi: min ' + (data.config?.minPairAgeSec || 0) + ' sn · max ' + (data.config?.maxPairAgeHours || 0) + ' sa · 5dk işlem ' + (data.config?.minTxns5m || 0),
        '8. Global zarar serisi freni: ' + (data.config?.globalLossBrake ? 'açık' : 'kapalı') + ' · seri ' + (data.riskGuards?.globalPerformance?.consecutiveLosses || 0),
        '9. Token hafızası: zarar blok ' + fmtTry(data.config?.tokenLossBlockTry || 0) + ' · aktif blok ' + (data.riskGuards?.tokenBlockCount || 0),
        '10. Paid hype kontrolü: ' + (data.config?.rejectPaidDexOrders ? 'reklamlı/hype token red' : 'izlemede')
      ].join('\\n');

      document.getElementById('miniRadar').innerHTML = (data.signalRadar || []).slice(0, 8).map(row => {
        const cls = row.score >= 75 ? 'goodText' : row.score >= 50 ? 'warnText' : 'badText';
        const token = row.url ? '<a href="' + row.url + '" target="_blank">' + row.symbol + '</a>' : row.symbol;
        return '<tr><td>' + token + '<div class="mono">' + short(row.mint) + '</div></td><td class="' + cls + '">' + row.score + '</td><td>' + row.uniqueBuyers + ' / ' + row.uniqueSellers + '<div class="small">copy ' + row.copyBuyers + '</div></td><td>' + row.label + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Radar bekliyor.</td></tr>';

      document.getElementById('walletScoreboard').innerHTML = (data.walletStats || []).map(wallet => {
        const pnl = wallet.realizedTry || 0;
        const wr = wallet.winRate === null || wallet.winRate === undefined ? '-' : Number(wallet.winRate).toFixed(1) + '%';
        const guardWr = wallet.guardWinRate === null || wallet.guardWinRate === undefined ? '-' : Number(wallet.guardWinRate).toFixed(1) + '%';
        const guardState = wallet.guardBlockedUntil && new Date(wallet.guardBlockedUntil).getTime() > Date.now()
          ? 'cezada ' + time(wallet.guardBlockedUntil)
          : wallet.cooldownLeftSec > 0
            ? 'cooldown ' + wallet.cooldownLeftSec + 's'
            : 'aktif';
        return '<tr><td>' + wallet.name + '<div class="mono">owner ' + short(wallet.address) + '</div>' + (wallet.signerAddresses?.length ? '<div class="mono">signer ' + short(wallet.signerAddresses[0]) + '</div>' : '') + (wallet.discoveredRelated?.length ? '<div class="small">otomatik iliski +' + wallet.discoveredRelated.length + '</div>' : '') + '<div class="small">' + (wallet.note || '') + '</div></td>' +
          '<td><span class="tag ' + (wallet.class || 'B') + '">' + (wallet.class || 'B') + '</span><div class="small">lot ' + fmtTry(wallet.tradeTry || 0) + '</div></td>' +
          '<td>' + wallet.paperBuys + ' alım / ' + wallet.paperSells + ' satış<div class="small">WR ' + wr + ' · açık ' + wallet.openPositions + ' · kaçan ' + wallet.skipped + '</div><div class="small">son: ' + (wallet.lastSymbol || '-') + ' ' + (wallet.lastSignalAt ? age(wallet.lastSignalAt) : '') + '</div></td>' +
          '<td class="' + pnlClass(pnl) + '">' + fmtTry(pnl) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Cüzdan yok.</td></tr>';

      document.getElementById('watchlist').innerHTML = (data.watchlist || []).slice(0, 12).map(item => {
        return '<tr><td>' + item.name + '<div class="mono">' + short(item.wallet) + '</div><div class="small">' + (item.tokens || []).join(', ') + '</div></td>' +
          '<td>' + pctText(item.winRate) + '<div class="small">' + item.closed + ' kapalı</div></td>' +
          '<td class="' + pnlClass(item.pnlSol) + '">' + solText(item.pnlSol) + '<div class="small">max zarar ' + solText(item.biggestLossSol) + '</div></td>' +
          '<td>' + (item.tracked ? '<span class="tag buy">ekli</span>' : '<span class="tag">izle</span>') + '<div class="small">skor ' + item.score + '</div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Tarama listesi yok.</td></tr>';

      document.getElementById('events').innerHTML = (data.events || []).slice(0, 40).map(event => {
        const side = event.type === 'BUY' ? 'buy' : event.type === 'SELL' ? 'sell' : '';
        const symbol = event.url ? '<a href="' + event.url + '" target="_blank">' + (event.symbol || short(event.mint)) + '</a>' : (event.symbol || short(event.mint));
        return '<tr><td>' + time(event.time) + '</td><td>' + (event.wallet || event.kind || '-') + '</td><td><span class="tag ' + side + '">' + (event.type || event.kind || '-') + '</span></td><td>' + symbol + '<div class="mono">' + short(event.mint) + '</div></td><td>' + paperText(event) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">Henüz event yok.</td></tr>';

      document.getElementById('wallets').innerHTML = (data.walletStats || []).map(wallet => {
        return '<tr><td>' + wallet.name + '<div class="mono">owner ' + short(wallet.address) + '</div>' + (wallet.signerAddresses?.length ? '<div class="mono">signer ' + short(wallet.signerAddresses[0]) + '</div>' : '') + '</td><td><span class="tag ' + wallet.mode + '">' + wallet.mode + '</span></td><td>' + wallet.buys + ' buy / ' + wallet.sells + ' sell</td><td>' + wallet.paperBuys + ' buy / ' + wallet.paperSells + ' sell</td></tr>';
      }).join('');

      document.getElementById('positions').innerHTML = (mtm.positions || []).map(position => {
        const token = position.url ? '<a href="' + position.url + '" target="_blank">' + position.symbol + '</a>' : position.symbol;
        return '<tr><td>' + token + '<div class="mono">' + short(position.mint) + '</div><div class="small">açılış ' + age(position.openedAt) + '</div></td><td>' + position.wallet + '<div><span class="tag ' + (position.walletClass || 'B') + '">' + (position.walletClass || 'B') + '</span></div></td><td>' + fmtTry(position.investedTry) + '<div class="mono">brüt ' + fmtTry(position.grossValueTry) + '</div><div class="mono">satış net ' + fmtTry(position.valueTry) + '</div><div class="' + pnlClass(position.unrealizedTry) + '">PnL ' + fmtTry(position.unrealizedTry) + ' (' + Number(position.unrealizedPct || 0).toFixed(1) + '%)</div></td><td>' + (position.buyReason || (position.wallet + ' cüzdanı aldı')) + '<div class="small">entry net ' + Number(position.entryTry).toFixed(6) + ' TL · spot ' + Number(position.spotEntryTry || position.entryTry).toFixed(6) + ' TL</div><div class="small">satış kesinti varsayımı %' + Number(position.sellCostPct || 0).toFixed(1) + '</div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Açık pozisyon yok.</td></tr>';

      document.getElementById('closedTrades').innerHTML = (data.closedTrades || []).slice(0, 35).map(trade => {
        const token = trade.url ? '<a href="' + trade.url + '" target="_blank">' + trade.symbol + '</a>' : trade.symbol;
        return '<tr><td>' + time(trade.time) + '<div class="small">' + age(trade.time) + '</div></td><td>' + token + '<div class="mono">' + short(trade.mint) + '</div></td><td>' + trade.wallet + '</td><td class="' + pnlClass(trade.pnlTry) + '">' + fmtTry(trade.pnlTry) + '<div class="small">' + trade.reason + '</div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Henüz kapanan işlem yok.</td></tr>';

      document.getElementById('recoveryTrades').innerHTML = (data.recoveryTrades || []).slice(0, 25).map(trade => {
        const token = trade.url ? '<a href="' + trade.url + '" target="_blank">' + trade.symbol + '</a>' : trade.symbol;
        return '<tr><td>' + token + '<div class="mono">' + short(trade.mint) + '</div><div class="small">çıkış ' + time(trade.time) + '</div></td><td>' + trade.wallet + '<div class="small">' + trade.reason + '</div><div><span class="tag">' + (trade.category || '-') + '</span></div></td><td class="badText">' + fmtTry(trade.soldPnlTry) + '<div class="small">exit $' + Number(trade.exitPriceUsd).toPrecision(4) + '</div></td><td class="' + pnlClass(trade.peakPnlTry) + '">' + fmtTry(trade.peakPnlTry) + '<div class="small">zirve ' + age(trade.peakAt) + ' · $' + Number(trade.peakPriceUsd).toPrecision(4) + '</div></td><td class="' + pnlClass(trade.missedTry) + '">' + fmtTry(trade.missedTry) + '<div class="small">' + (trade.recovered ? 'kâra dönerdi' : 'zarar devam') + '</div></td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">Kıyaslanacak zarar satışı yok.</td></tr>';

      document.getElementById('settings').textContent =
        'Başlangıç kasa: ' + fmtTry(data.config?.startingTry) + '\\n' +
        'Max açık pozisyon: ' + data.config?.maxOpenPositions + '\\n' +
        'Normal lot: ' + fmtTry(data.config?.normalTradeTry) + '\\n' +
        'Alım slippage: %' + data.config?.buySlippagePct + ' · Satış slippage: %' + data.config?.sellSlippagePct + '\\n' +
        'Platform fee: %' + data.config?.platformFeePct + ' · Priority fee: ' + fmtTry(data.config?.priorityFeeTry) + '\\n' +
        'Stop loss: ' + data.config?.stopLossPct + '%\\n' +
        'TP1: +' + data.config?.takeProfit1Pct + '% · TP2: +' + data.config?.takeProfit2Pct + '%\\n' +
        'Trailing stop: ' + data.config?.trailingStopPct + '%\\n' +
        'Moonshot TP1: +' + data.config?.moonshotTakeProfit1Pct + '% · TP2: +' + data.config?.moonshotTakeProfit2Pct + '%\\n' +
        'Moonshot trailing: ' + data.config?.moonshotTrailingStopPct + '% · wallet sell: tam cikis\\n' +
        'Cüzdan sayısı: ' + (data.config?.wallets || []).length;

      document.getElementById('log').textContent = data.logs?.out || 'Log bekleniyor...';
    }

    function connectStream() {
      const source = new EventSource('/api/stream');
      source.addEventListener('state', event => {
        render(JSON.parse(event.data));
      });
      source.onerror = () => {
        document.getElementById('dot').className = 'dot';
        document.getElementById('botStatus').textContent = 'Canlı bağlantı koptu';
        source.close();
        setTimeout(connectStream, 1500);
      };
    }

    connectStream();

    setInterval(async () => {
      if (Date.now() - lastPayloadAt < 5000) return;
      try {
        const res = await fetch('/api/state?ts=' + Date.now(), { cache: 'no-store' });
        render(await res.json());
      } catch (error) {
        document.getElementById('dot').className = 'dot';
        document.getElementById('botStatus').textContent = 'Veri alınamadı';
        document.getElementById('pulse').textContent = error.message || 'fetch error';
      }
    }, 2000);
  </script>
</body>
</html>`;
}

function controlPageHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kontrol Merkezi</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --panel:#121923; --panel2:#0f151d; --line:#263241; --text:#e7edf5; --muted:#8fa0b5; --good:#35d08c; --bad:#ff5e6c; --warn:#f2c14e; --blue:#6bb7ff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    header { position:sticky; top:0; z-index:3; display:flex; justify-content:space-between; gap:14px; padding:14px 18px; background:rgba(11,15,20,.96); border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:20px; }
    .sub, .small { color:var(--muted); font-size:12px; line-height:1.35; }
    .nav { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .btn, button, select, input, textarea { border:1px solid var(--line); border-radius:8px; background:var(--panel2); color:var(--text); }
    .btn, button { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:9px 12px; text-decoration:none; cursor:pointer; font-size:13px; }
    button.primary, .btn.active { border-color:rgba(107,183,255,.7); color:var(--blue); }
    button.danger { border-color:rgba(255,94,108,.55); color:var(--bad); }
    button.good { border-color:rgba(53,208,140,.55); color:var(--good); }
    button:disabled { opacity:.55; cursor:wait; }
    .actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    main { padding:18px; display:grid; gap:16px; }
    .metrics { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; }
    .metric, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .metric { padding:14px; min-height:92px; }
    .label { color:var(--muted); font-size:12px; }
    .value { font-size:24px; font-weight:800; margin-top:8px; letter-spacing:0; }
    .goodText { color:var(--good); } .badText { color:var(--bad); } .warnText { color:var(--warn); }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
    .wide { grid-column:1 / -1; }
    .panel h2 { margin:0; padding:12px 14px; border-bottom:1px solid var(--line); font-size:15px; }
    .panel-body { padding:14px; display:grid; gap:12px; }
    .field-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; }
    input, select, textarea { width:100%; padding:9px 10px; font-size:14px; }
    textarea { min-height:72px; resize:vertical; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid rgba(38,50,65,.7); vertical-align:top; }
    th { color:var(--muted); font-size:12px; font-weight:600; }
    tr:last-child td { border-bottom:0; }
    .table-scroll { width:100%; overflow-x:auto; }
    .table-scroll table { min-width:980px; }
    .tag { display:inline-flex; border:1px solid var(--line); border-radius:6px; padding:3px 7px; color:var(--muted); background:var(--panel2); font-size:12px; }
    .tag.copy { color:var(--blue); border-color:rgba(107,183,255,.45); }
    .tag.alert { color:var(--warn); border-color:rgba(242,193,78,.45); }
    .tag.off { color:var(--bad); border-color:rgba(255,94,108,.45); }
    .mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; color:var(--muted); font-size:12px; }
    .row-actions { display:flex; gap:7px; flex-wrap:wrap; }
    .status { white-space:pre-wrap; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
    @media (max-width: 980px) { .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid, .field-grid { grid-template-columns:1fr; } header { flex-direction:column; } }
    @media (max-width: 640px) {
      html { -webkit-text-size-adjust:100%; scroll-padding-top:132px; }
      body { overflow-x:hidden; }
      header { padding:12px; max-height:48vh; overflow:auto; }
      h1 { font-size:22px; line-height:1.1; }
      .sub, .small { font-size:12px; }
      .nav { flex-wrap:nowrap; overflow-x:auto; padding-bottom:6px; -webkit-overflow-scrolling:touch; }
      .nav .btn, .nav a { flex:0 0 auto; white-space:nowrap; font-size:13px; padding:9px 11px; }
      .row-actions, .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; width:100%; }
      .row-actions button, .actions button, .actions .btn { width:100%; min-width:0; }
      main { padding:12px; gap:12px; }
      .metrics { grid-template-columns:1fr 1fr; gap:10px; }
      .metric { min-height:84px; padding:12px; }
      .value { font-size:22px; overflow-wrap:anywhere; }
      .panel h2 { font-size:16px; padding:12px; }
      .panel-body { padding:12px; }
      input, select, textarea { font-size:16px; min-height:44px; }
      .table-scroll { border-radius:8px; -webkit-overflow-scrolling:touch; }
      .table-scroll table { min-width:620px; }
      th,td { padding:10px; font-size:13px; }
      th,.mono,.tag { font-size:12px; }
    }
    @media (max-width:380px) { .metrics, .row-actions, .actions { grid-template-columns:1fr; } }
  </style>
</head>
<body class="simple">
  <header>
    <div>
      <h1>Kontrol Merkezi</h1>
      <div class="sub">Lot, cüzdan modu, risk kapıları, bot start/stop ve manuel paper kapatma tek ekranda.</div>
      <div class="nav">
        <a class="btn" href="/">Dashboard</a>
        <a class="btn active" href="/control">Kontrol</a>
        <a class="btn" href="/wallets">Cüzdanlar</a>
        <a class="btn" href="/positions">Pozisyonlar</a>
        <a class="btn" href="/token-research">Token Arastir</a>
        <a class="btn" href="/wallet-research">Cuzdan Arastir</a>
        <a class="btn" href="/moonshot">Moonshot</a>
        <a class="btn" href="/chat">Sohbet</a>
      </div>
    </div>
    <div class="row-actions">
      <button class="good" id="startBot">Botu Başlat</button>
      <button class="primary" id="restartBot">Restart</button>
      <button class="danger" id="stopBot">Durdur</button>
    </div>
  </header>
  <main>
    <section class="metrics">
      <div class="metric"><div class="label">Bot</div><div id="botValue" class="value">-</div></div>
      <div class="metric"><div class="label">Kasa</div><div id="cashValue" class="value">-</div></div>
      <div class="metric"><div class="label">Portföy</div><div id="equityValue" class="value">-</div></div>
      <div class="metric"><div class="label">Realized</div><div id="realizedValue" class="value">-</div></div>
      <div class="metric"><div class="label">Açık Pozisyon</div><div id="openValue" class="value">-</div></div>
      <div class="metric"><div class="label">Copy Cüzdan</div><div id="copyValue" class="value">-</div></div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Hızlı Modlar</h2>
        <div class="panel-body">
          <div class="row-actions">
            <button id="presetSafe">Kalkan Modu</button>
            <button id="presetBalanced" class="primary">Dengeli Mod</button>
            <button id="presetAggro">Agresif Sim</button>
            <button id="presetUltra" class="good">Ultra Avcı</button>
          </div>
          <div class="small">Kalkan daha az pozisyon ve küçük lot; dengeli kontrollü test; agresif daha fazla fırsat; Ultra Avcı iki cüzdan onayı, kalite kapısı ve günlük zarar freni açar.</div>
          <div class="row-actions">
            <button id="allAlert">Hepsi Alarm</button>
            <button id="allOff" class="danger">Hepsi Pasif</button>
          </div>
          <div id="status" class="status">Hazır.</div>
        </div>
      </div>
      <div class="panel">
        <h2>Canlı Karar Özeti</h2>
        <div class="panel-body">
          <div id="decisionSummary" class="status">Yükleniyor...</div>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Risk ve Lot Ayarları</h2>
      <div class="panel-body">
        <div id="settingsForm" class="field-grid"></div>
        <div class="row-actions">
          <button class="primary" id="saveSettings">Ayarları Kaydet ve Botu Yeniden Başlat</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Alpha Kaynaklari ve Guvenlik Katmanlari</h2>
      <div class="panel-body">
        <div id="intelligenceForm" class="field-grid"></div>
        <div class="small">Cielo/Birdeye/Defined/Geyser bilgileri buradan girilir. Key yoksa sistem hata vermez; ilgili kaynak eksik teyit olarak isaretlenir.</div>
        <div class="actions">
          <a class="btn" target="_blank" rel="noreferrer" href="https://nolimitnodes.com/">NoLimitNodes trial</a>
          <a class="btn" target="_blank" rel="noreferrer" href="https://drpc.org/docs/solana-yellowstone-geyser-grpc">dRPC Yellowstone</a>
          <a class="btn" target="_blank" rel="noreferrer" href="https://www.helius.dev/docs/grpc/quickstart">Helius gRPC</a>
          <a class="btn" target="_blank" rel="noreferrer" href="https://www.quicknode.com/docs/solana/yellowstone-grpc/overview/">QuickNode docs</a>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Yeni Cüzdan Ekle</h2>
      <div class="panel-body">
        <div class="field-grid">
          <label>Adres<input id="newWalletAddress" placeholder="Solana cüzdan adresi"></label>
          <label>İsim<input id="newWalletName" placeholder="boşsa Aday-xx"></label>
          <label>Mod<select id="newWalletMode"><option value="alert">alert</option><option value="copy">copy</option><option value="off">off</option></select></label>
          <label>Lot TL<input id="newWalletLot" type="number" step="1" value="60"></label>
          <label>Sınıf<select id="newWalletClass"><option>B</option><option>A</option><option>AG</option><option>C</option><option>D</option></select></label>
          <label>Skor<input id="newWalletScore" type="number" min="0" max="100" value="60"></label>
          <label>Moonshot<select id="newWalletMoon"><option value="true">evet</option><option value="false">hayır</option></select></label>
        </div>
        <label>Not<textarea id="newWalletNote" placeholder="Neden ekledik? Hangi kaynaktan geldi?"></textarea></label>
        <div class="row-actions">
          <button class="primary" id="addWalletAlert">Alert Ekle</button>
          <button class="good" id="addWalletCopy">Copy Ekle</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Cüzdan Kumandası</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Cüzdan</th><th>Mod</th><th>Lot</th><th>Sınıf</th><th>Skor</th><th>Moonshot</th><th>Performans</th><th>Karar</th><th>İşlem</th></tr></thead>
          <tbody id="walletRows"></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Fırsat Radarı</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Skor</th><th>Alıcılar</th><th>Satış Baskısı</th><th>Son Sinyal</th><th>Not</th></tr></thead>
          <tbody id="radarRows"></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Açık Pozisyon Kontrolü</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Cüzdan</th><th>Yatırım</th><th>PnL</th><th>Potansiyel</th><th>İşlem</th></tr></thead>
          <tbody id="positionRows"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const fmtTry = value => Number(value || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' TL';
    const pct = value => value === null || value === undefined ? '-' : Number(value).toFixed(1) + '%';
    const short = value => value ? value.slice(0, 6) + '...' + value.slice(-4) : '-';
    const settingFields = [
      ['normalTradeTry','Normal lot TL'], ['highConfidenceTradeTry','High lot TL'], ['maxOpenPositions','Max açık'], ['maxCoreOpenPositions','Max core'],
      ['maxMoonshotOpenPositions','Max moonshot'], ['maxOpenPerWallet','Cüzdan başı açık'], ['walletCooldownSec','Cüzdan cooldown sn'], ['tokenCooldownMin','Token cooldown dk'],
      ['maxBuyMarketCapUsd','Max mcap USD (0=sınırsız)'], ['minLiquidityUsd','Min likidite USD'], ['minVolume24hUsd','Min hacim 24s USD'], ['strongLiquidityUsd','Güçlü likidite USD'],
      ['strongVolume24hUsd','Güçlü hacim USD'], ['sourceSizeGateEnabled','Kaynak boyut kapısı'], ['minSourceBuySol','Min kaynak SOL'], ['maxSourceBuySol','Max kaynak SOL'],
      ['sourceScaleEnabled','Kaynağa göre lot'], ['sourceScalePct','Kaynak ölçek %'], ['minPairAgeSec','Min pair yaşı sn'], ['maxPairAgeHours','Max pair yaşı sa'], ['minTxns5m','Min 5dk işlem'],
      ['rejectNoLiquidity','Likidite yoksa ele'], ['authorityRiskGate','Mint/holder güvenliği'], ['rejectMintAuthority','Mint yetkisi red'], ['rejectFreezeAuthority','Freeze yetkisi red'],
      ['maxTopHolderPct','Max top1 holder %'], ['maxTop10HolderPct','Max top10 holder %'], ['rejectPaidDexOrders','Paid hype red'], ['dynamicLotSizing','Dinamik lot'], ['dynamicMinTradeTry','Dinamik min TL'],
      ['dynamicMaxTradeTry','Dinamik max TL'], ['dynamicMaxMultiplier','Dinamik max çarpan'], ['requireMultiWalletConfirm','2 cüzdan onayı'], ['confirmMinWallets','Onay cüzdan sayısı'],
      ['confirmWindowMin','Onay pencere dk'], ['vetoBuyOnSellPressure','Satış baskısı veto'], ['sellPressureWindowMin','Satış baskısı dk'], ['sellPressureMinSellers','Veto min satıcı'],
      ['sellPressureVetoRatio','Veto satıcı/alıcı'], ['exitOnSellPressure','Satış baskısında çık'], ['exitSellPressureMinSellers','Çıkış min satıcı'], ['exitSellPressureRatio','Çıkış satıcı/alıcı'],
      ['sellPressureExitFraction','Çıkış oranı'], ['maxDailyDrawdownTry','Günlük zarar freni TL'],
      ['maxDailyDrawdownPct','Günlük zarar freni %'], ['dailyDrawdownCooldownMin','Zarar freni dk'], ['globalLossBrake','Zarar serisi freni'], ['maxConsecutiveLosses','Max üst üste zarar'],
      ['globalLossBrakeCooldownMin','Seri fren dk'], ['tokenLossBlockTry','Token zarar blok TL'], ['tokenLossBlockMin','Token blok dk'], ['autoDemoteLosers','Kötü cüzdan auto fren'], ['autoDemoteMinClosed','Auto fren min satış'],
      ['autoDemoteWinRatePct','Auto fren WR %'], ['autoDemoteRealizedTry','Auto fren PnL TL'], ['autoDemoteCooldownMin','Auto fren dk'], ['buySlippagePct','Alım slip %'], ['sellSlippagePct','Satış slip %'], ['platformFeePct','Platform fee %'],
      ['priorityFeeTry','Priority fee TL'], ['stopLossPct','Stop loss %'], ['coreProfitLockTry','Core kar kilidi TL'], ['coreProfitLockFraction','Core kar al oran'],
      ['takeProfit1Pct','TP1 %'], ['takeProfit2Pct','TP2 %'], ['trailingStopPct','Trailing %'], ['moonshotStopLossPct','Moon stop %'],
      ['moonshotTakeProfit1Pct','Moon TP1 %'], ['moonshotTakeProfit2Pct','Moon TP2 %'], ['moonshotTrailingStopPct','Moon trailing %'], ['runnerExitIfWalletSoldBelowPct','Wallet çıktı %'],
      ['autoTrackTransferTargets','Transfer hedefi takip'], ['copyTransferInAsBuy','Transfer-in alım'], ['inferNoPriceFromSol','No-price tahmin']
    ];
    const intelligenceFields = [
      ['enableFakeSmartFilter','Fake smart filtresi'],
      ['enableBundleHardGate','Bundle hard gate'],
      ['enableTransferChainFollow','Transfer zinciri'],
      ['enableCieloPnl','Cielo PnL'],
      ['cieloApiKey','Cielo API key'],
      ['enableBirdeyeFirstBuyers','Birdeye ilk alicilar'],
      ['birdeyeApiKey','Birdeye API key'],
      ['definedApiKey','Defined API key'],
      ['heliusWebhookUrl','Helius webhook URL'],
      ['enableUltraOnchainLayer','Ultra on-chain katman'],
      ['ultraCrashGatePct','AMM crash kilit %'],
      ['enableGenesisTrace','Genesis trace'],
      ['enableBytecodeGuard','Bytecode guard'],
      ['enableGeyserJitoLayer','Jito/Geyser katmani'],
      ['geyserProvider','Geyser saglayici'],
      ['geyserGrpcEndpoint','Geyser gRPC endpoint'],
      ['geyserAuthToken','Geyser auth token'],
      ['jitoTipMinSol','Min Jito tip SOL'],
      ['enableExperimentalWebsockets','Websocket hiz katmani']
    ];
    let latest = null;
    let editLockUntil = 0;
    const walletDrafts = new Map();

    function lockEditing(ms = 45000) {
      editLockUntil = Date.now() + ms;
    }

    function editingActive() {
      const active = document.activeElement;
      return Date.now() < editLockUntil || (active && active.matches && active.matches('input, select, textarea'));
    }

    function rememberWalletDraft(input) {
      const tr = input.closest('tr[data-wallet]');
      if (!tr) return;
      const name = decodeURIComponent(tr.dataset.wallet);
      const draft = {};
      tr.querySelectorAll('[data-field]').forEach(field => draft[field.dataset.field] = field.value);
      walletDrafts.set(name, draft);
    }

    function updateLiveWalletRow(input) {
      const tr = input.closest('tr[data-wallet]');
      if (!tr) return;
      const modeInput = tr.querySelector('[data-field="mode"]');
      const tag = tr.querySelector('[data-live-mode]');
      if (modeInput && tag) {
        tag.textContent = modeInput.value;
        tag.className = 'tag ' + modeInput.value;
      }
    }

    function fieldValue(wallet, key, fallback) {
      const draft = walletDrafts.get(wallet.name);
      if (draft && draft[key] !== undefined) return draft[key];
      return fallback;
    }

    function boolValue(value) {
      return value === true || value === 'true';
    }

    function setBusy(busy) {
      document.querySelectorAll('button').forEach(button => button.disabled = busy);
    }

    async function postJson(url, body, options = {}) {
      setBusy(true);
      try {
        const res = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body || {}) });
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || 'işlem başarısız');
        document.getElementById('status').textContent = 'Tamam: ' + new Date().toLocaleTimeString('tr-TR');
        if (options.reload !== false) await load({ force:true });
        return data;
      } catch (error) {
        document.getElementById('status').textContent = 'Hata: ' + (error.message || error);
        return { ok:false, error: error.message || String(error) };
      } finally {
        setBusy(false);
      }
    }

    function walletDecision(wallet) {
      const pnl = Number(wallet.realizedTry || 0);
      const wr = wallet.winRate;
      if (wallet.mode === 'off') return 'Pasif: bot takip etmiyor';
      if (wallet.autoDemoted?.blockedUntil && new Date(wallet.autoDemoted.blockedUntil).getTime() > Date.now()) return 'Auto fren: ' + wallet.autoDemoted.reason;
      if (wallet.mode === 'copy' && pnl < -150) return 'Copy riskli: lot küçült veya alarm';
      if (wallet.paperSells >= 3 && wr !== null && wr < 35) return 'Zayıf form: alarm/off';
      if (pnl > 150 && (wr === null || wr >= 45)) return 'Copy adayı: küçük lot mantıklı';
      if (wallet.openPositions > 0) return 'Açık pozisyon var: satışları izle';
      return 'İzle ve doğrula';
    }

    function renderSettings(config) {
      const html = settingFields.map(([key, label]) => {
        const value = config[key];
        const isBool = typeof value === 'boolean';
        if (isBool) {
          return '<label>' + label + '<select data-setting="' + key + '"><option value="true" ' + (value ? 'selected' : '') + '>Açık</option><option value="false" ' + (!value ? 'selected' : '') + '>Kapalı</option></select></label>';
        }
        return '<label>' + label + '<input data-setting="' + key + '" type="number" step="0.01" value="' + (value === null || value === undefined ? '' : value) + '"></label>';
      }).join('');
      document.getElementById('settingsForm').innerHTML = html;
      const intelHtml = intelligenceFields.map(([key, label]) => {
        const value = config[key];
        const isBool = typeof value === 'boolean' || key.startsWith('enable');
        if (isBool) {
          return '<label>' + label + '<select data-setting="' + key + '"><option value="true" ' + (value ? 'selected' : '') + '>Açık</option><option value="false" ' + (!value ? 'selected' : '') + '>Kapalı</option></select></label>';
        }
        const masked = /(ApiKey|AuthToken)/i.test(key) && value ? '********' : (value || '');
        return '<label>' + label + '<input data-setting="' + key + '" type="text" value="' + masked + '"></label>';
      }).join('');
      const intelligenceForm = document.getElementById('intelligenceForm');
      if (intelligenceForm) intelligenceForm.innerHTML = intelHtml;
    }

    function renderWallets(wallets) {
      document.getElementById('walletRows').innerHTML = wallets.map(wallet => {
        const pnlClass = Number(wallet.realizedTry || 0) >= 0 ? 'goodText' : 'badText';
        const id = encodeURIComponent(wallet.name);
        const mode = fieldValue(wallet, 'mode', wallet.mode || 'alert');
        const tradeTry = fieldValue(wallet, 'tradeTry', wallet.tradeTry || 0);
        const walletClass = fieldValue(wallet, 'class', wallet.class || 'B');
        const score = fieldValue(wallet, 'score', wallet.score || 0);
        const moonshot = boolValue(fieldValue(wallet, 'moonshot', wallet.moonshot));
        const decisionWallet = { ...wallet, mode, tradeTry, class: walletClass, score, moonshot };
        return '<tr data-wallet="' + id + '">' +
          '<td><b>' + wallet.name + '</b><div class="mono">' + short(wallet.address) + '</div><div class="small">' + (wallet.note || '') + '</div></td>' +
          '<td><select data-field="mode"><option value="copy" ' + (mode === 'copy' ? 'selected' : '') + '>copy</option><option value="alert" ' + (mode === 'alert' ? 'selected' : '') + '>alert</option><option value="off" ' + (mode === 'off' ? 'selected' : '') + '>off</option></select></td>' +
          '<td><input data-field="tradeTry" type="text" inputmode="decimal" value="' + tradeTry + '"></td>' +
          '<td><select data-field="class"><option ' + (walletClass === 'AG' ? 'selected' : '') + '>AG</option><option ' + (walletClass === 'A' ? 'selected' : '') + '>A</option><option ' + (walletClass === 'B' ? 'selected' : '') + '>B</option><option ' + (walletClass === 'C' ? 'selected' : '') + '>C</option><option ' + (walletClass === 'D' ? 'selected' : '') + '>D</option></select></td>' +
          '<td><input data-field="score" type="text" inputmode="numeric" value="' + score + '"></td>' +
          '<td><select data-field="moonshot"><option value="true" ' + (moonshot ? 'selected' : '') + '>evet</option><option value="false" ' + (!moonshot ? 'selected' : '') + '>hayır</option></select></td>' +
          '<td><span class="' + pnlClass + '">' + fmtTry(wallet.realizedTry) + '</span><div class="small">' + wallet.paperBuys + ' alım / ' + wallet.paperSells + ' satış · WR ' + pct(wallet.winRate) + '</div><div class="small">açık ' + wallet.openPositions + ' · skip ' + wallet.skipped + '</div></td>' +
          '<td><span data-live-mode class="tag ' + mode + '">' + mode + '</span><div class="small">' + walletDecision(decisionWallet) + '</div></td>' +
          '<td><button class="primary saveWallet">Kaydet</button></td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="9">Cüzdan yok.</td></tr>';
      document.querySelectorAll('.saveWallet').forEach(button => {
        button.addEventListener('click', async () => {
          const tr = button.closest('tr');
          const name = decodeURIComponent(tr.dataset.wallet);
          const body = { name };
          tr.querySelectorAll('[data-field]').forEach(input => body[input.dataset.field] = input.value);
          const data = await postJson('/api/control/wallet', body, { reload:false });
          if (data?.ok) {
            walletDrafts.delete(name);
            editLockUntil = 0;
            await load({ force:true });
          }
        });
      });
      document.querySelectorAll('#walletRows input, #walletRows select, #settingsForm input, #settingsForm select, #newWalletAddress, #newWalletName, #newWalletMode, #newWalletLot, #newWalletClass, #newWalletScore, #newWalletMoon, #newWalletNote').forEach(input => {
        const markEditing = () => {
          lockEditing();
          rememberWalletDraft(input);
          updateLiveWalletRow(input);
        };
        input.addEventListener('pointerdown', markEditing);
        input.addEventListener('touchstart', markEditing);
        input.addEventListener('mousedown', markEditing);
        input.addEventListener('keydown', markEditing);
        input.addEventListener('input', markEditing);
        input.addEventListener('change', markEditing);
        input.addEventListener('focus', markEditing);
      });
    }

    function renderPositions(positions) {
      document.getElementById('positionRows').innerHTML = positions.map(position => {
        const pnlClass = Number(position.unrealizedTry || 0) >= 0 ? 'goodText' : 'badText';
        const pot = position.potential || {};
        return '<tr><td><b>' + (position.symbol || short(position.mint)) + '</b><div class="mono">' + short(position.mint) + '</div></td>' +
          '<td>' + position.wallet + '<div class="small">' + (position.moonshot ? 'moonshot' : 'core') + '</div></td>' +
          '<td>' + fmtTry(position.investedTry) + '<div class="small">net çıkış ' + fmtTry(position.valueTry) + '</div></td>' +
          '<td class="' + pnlClass + '">' + fmtTry(position.unrealizedTry) + '<div class="small">' + Number(position.unrealizedPct || 0).toFixed(1) + '%</div></td>' +
          '<td>' + (pot.label || '-') + '<div class="small">skor ' + (pot.score ?? '-') + ' · ' + (pot.action || '-') + '</div></td>' +
          '<td><button class="danger closePosition" data-id="' + position.id + '">Paper Kapat</button></td></tr>';
      }).join('') || '<tr><td colspan="6">Açık pozisyon yok.</td></tr>';
      document.querySelectorAll('.closePosition').forEach(button => {
        button.addEventListener('click', async () => {
          await postJson('/api/control/position', { action:'close', id: button.dataset.id });
        });
      });
    }

    function renderRadar(rows) {
      document.getElementById('radarRows').innerHTML = (rows || []).map(row => {
        const token = row.url ? '<a href="' + row.url + '" target="_blank"><b>' + row.symbol + '</b></a>' : '<b>' + row.symbol + '</b>';
        const scoreClass = row.score >= 75 ? 'goodText' : row.score >= 50 ? 'warnText' : '';
        const pressureClass = row.uniqueSellers > row.uniqueBuyers ? 'badText' : row.uniqueSellers ? 'warnText' : 'goodText';
        return '<tr><td>' + token + '<div class="mono">' + short(row.mint) + '</div></td>' +
          '<td class="' + scoreClass + '">' + row.score + '<div class="small">' + row.label + '</div></td>' +
          '<td>' + row.uniqueBuyers + ' farklı cüzdan<div class="small">copy ' + row.copyBuyers + ' · buy ' + row.buys + '</div><div class="small">' + (row.buyers || []).join(', ') + '</div></td>' +
          '<td class="' + pressureClass + '">' + row.uniqueSellers + ' satıcı<div class="small">sell ' + row.sells + '</div></td>' +
          '<td>' + new Date(row.lastAt).toLocaleTimeString('tr-TR') + '</td>' +
          '<td>' + ((row.skippedReasons || []).join(' · ') || 'engel yok') + '</td></tr>';
      }).join('') || '<tr><td colspan="6">Son 60 dakikada radar sinyali yok.</td></tr>';
    }

    function render(data) {
      latest = data;
      const config = data.config || {};
      const wallets = data.walletStats || [];
      const mtm = data.mtm || {};
      const state = data.state || {};
      const copyCount = wallets.filter(w => w.mode === 'copy').length;
      document.getElementById('botValue').textContent = data.bot?.running ? 'Çalışıyor' : 'Kapalı';
      document.getElementById('botValue').className = 'value ' + (data.bot?.running ? 'goodText' : 'badText');
      document.getElementById('cashValue').textContent = fmtTry(state.cashTry);
      document.getElementById('equityValue').textContent = fmtTry(mtm.equityTry);
      document.getElementById('realizedValue').textContent = fmtTry(state.realizedTry);
      document.getElementById('realizedValue').className = 'value ' + (Number(state.realizedTry || 0) >= 0 ? 'goodText' : 'badText');
      document.getElementById('openValue').textContent = String((state.positions || []).length);
      document.getElementById('copyValue').textContent = copyCount + '/' + wallets.length;
      renderSettings(config);
      renderWallets(wallets);
      renderRadar(data.signalRadar || []);
      renderPositions(mtm.positions || []);
      const losers = wallets.filter(w => Number(w.realizedTry || 0) < 0).slice(0, 4).map(w => w.name + ' ' + fmtTry(w.realizedTry)).join('\\n');
      const winners = wallets.filter(w => Number(w.realizedTry || 0) > 0).slice(0, 4).map(w => w.name + ' ' + fmtTry(w.realizedTry)).join('\\n');
      document.getElementById('decisionSummary').textContent =
        'Copy aktif: ' + copyCount + '\\n' +
        'Max açık: ' + config.maxOpenPositions + ' · core ' + config.maxCoreOpenPositions + ' · moon ' + config.maxMoonshotOpenPositions + '\\n' +
        'Lotlar: normal ' + fmtTry(config.normalTradeTry) + ' · high ' + fmtTry(config.highConfidenceTradeTry) + '\\n\\n' +
        'Ultra kapılar: ' + (config.requireMultiWalletConfirm ? '2 cüzdan onayı açık' : '2 cüzdan onayı kapalı') +
        ' · likidite min $' + Number(config.minLiquidityUsd || 0).toLocaleString('en-US') +
        ' · hacim min $' + Number(config.minVolume24hUsd || 0).toLocaleString('en-US') +
        ' · günlük fren ' + fmtTry(config.maxDailyDrawdownTry || 0) + '/' + (config.maxDailyDrawdownPct || 0) + '%\\n\\n' +
        'Tanrısal katman: ' + (config.dynamicLotSizing ? 'dinamik lot açık' : 'dinamik lot kapalı') +
        ' · ' + (config.vetoBuyOnSellPressure ? 'satış veto açık' : 'satış veto kapalı') +
        ' · ' + (config.exitOnSellPressure ? 'baskıda çıkış açık' : 'baskıda çıkış kapalı') +
        ' · zarar serisi ' + (data.riskGuards?.globalPerformance?.consecutiveLosses ?? 0) + '\\n\\n' +
        'İyi görünenler:\\n' + (winners || '-') + '\\n\\n' +
        'Zarar yazanlar:\\n' + (losers || '-') + '\\n\\n' +
        'Kural: gerçek para yok; önce paperda copy cüzdanları küçük lotla doğruluyoruz.';
    }

    async function load(options = {}) {
      const res = await fetch('/api/state?ts=' + Date.now(), { cache:'no-store' });
      const data = await res.json();
      if (editingActive() && !options.force) {
        latest = data;
        return;
      }
      render(data);
    }

    document.getElementById('saveSettings').addEventListener('click', async () => {
      const settings = {};
      document.querySelectorAll('[data-setting]').forEach(input => settings[input.dataset.setting] = input.value);
      editLockUntil = 0;
      await postJson('/api/control/config', { settings });
    });
    async function addWalletFromForm(modeOverride) {
      const body = {
        address: document.getElementById('newWalletAddress').value,
        name: document.getElementById('newWalletName').value,
        mode: modeOverride || document.getElementById('newWalletMode').value,
        tradeTry: document.getElementById('newWalletLot').value,
        class: document.getElementById('newWalletClass').value,
        score: document.getElementById('newWalletScore').value,
        moonshot: document.getElementById('newWalletMoon').value,
        note: document.getElementById('newWalletNote').value || 'Kontrol panelinden eklendi.'
      };
      const data = await postJson('/api/control/wallet/add', body);
      if (data?.ok) {
        editLockUntil = 0;
        document.getElementById('newWalletAddress').value = '';
        document.getElementById('newWalletName').value = '';
        document.getElementById('newWalletNote').value = '';
      }
    }
    document.getElementById('addWalletAlert').addEventListener('click', () => addWalletFromForm('alert'));
    document.getElementById('addWalletCopy').addEventListener('click', () => addWalletFromForm('copy'));
    document.getElementById('startBot').addEventListener('click', () => postJson('/api/control/bot', { action:'start' }));
    document.getElementById('stopBot').addEventListener('click', () => postJson('/api/control/bot', { action:'stop' }));
    document.getElementById('restartBot').addEventListener('click', () => postJson('/api/control/bot', { action:'restart' }));
    document.getElementById('allAlert').addEventListener('click', () => postJson('/api/control/wallets/batch', { mode:'alert' }));
    document.getElementById('allOff').addEventListener('click', () => postJson('/api/control/wallets/batch', { mode:'off' }));
    document.getElementById('presetSafe').addEventListener('click', () => postJson('/api/control/config', { settings:{ normalTradeTry:60, highConfidenceTradeTry:120, maxOpenPositions:2, maxCoreOpenPositions:1, maxMoonshotOpenPositions:1, walletCooldownSec:180, tokenCooldownMin:30, stopLossPct:-18, moonshotStopLossPct:-28, coreProfitLockTry:35 } }));
    document.getElementById('presetBalanced').addEventListener('click', () => postJson('/api/control/config', { settings:{ normalTradeTry:100, highConfidenceTradeTry:180, maxOpenPositions:4, maxCoreOpenPositions:2, maxMoonshotOpenPositions:2, walletCooldownSec:90, tokenCooldownMin:15, stopLossPct:-22, moonshotStopLossPct:-35, coreProfitLockTry:50 } }));
    document.getElementById('presetAggro').addEventListener('click', () => postJson('/api/control/config', { settings:{ normalTradeTry:150, highConfidenceTradeTry:300, maxOpenPositions:6, maxCoreOpenPositions:3, maxMoonshotOpenPositions:3, walletCooldownSec:45, tokenCooldownMin:8, stopLossPct:-28, moonshotStopLossPct:-45, coreProfitLockTry:75 } }));
    document.getElementById('presetUltra').addEventListener('click', () => postJson('/api/control/config', { settings:{ normalTradeTry:90, highConfidenceTradeTry:180, maxOpenPositions:4, maxCoreOpenPositions:1, maxMoonshotOpenPositions:3, walletCooldownSec:75, tokenCooldownMin:12, stopLossPct:-20, moonshotStopLossPct:-34, coreProfitLockTry:45, requireMultiWalletConfirm:true, confirmMinWallets:2, confirmWindowMin:12, minLiquidityUsd:2000, minVolume24hUsd:10000, strongLiquidityUsd:15000, strongVolume24hUsd:75000, sourceSizeGateEnabled:true, minSourceBuySol:0.004, maxSourceBuySol:8, sourceScaleEnabled:true, sourceScalePct:0.22, minPairAgeSec:45, maxPairAgeHours:72, minTxns5m:2, rejectNoLiquidity:false, authorityRiskGate:true, rejectMintAuthority:false, rejectFreezeAuthority:true, maxTopHolderPct:35, maxTop10HolderPct:82, rejectPaidDexOrders:false, dynamicLotSizing:true, dynamicMinTradeTry:40, dynamicMaxTradeTry:220, dynamicMaxMultiplier:1.8, vetoBuyOnSellPressure:true, sellPressureWindowMin:12, sellPressureMinSellers:2, sellPressureVetoRatio:1, exitOnSellPressure:true, exitSellPressureMinSellers:2, exitSellPressureRatio:1, sellPressureExitFraction:1, maxDailyDrawdownTry:250, maxDailyDrawdownPct:8, dailyDrawdownCooldownMin:90, globalLossBrake:true, maxConsecutiveLosses:3, globalLossBrakeCooldownMin:90, tokenLossBlockTry:80, tokenLossBlockMin:240, autoDemoteLosers:true, autoDemoteMinClosed:3, autoDemoteWinRatePct:35, autoDemoteRealizedTry:-120, autoDemoteCooldownMin:180 } }));
    load({ force:true });
    setInterval(() => {
      if (!editingActive()) load();
    }, 2500);
  </script>
</body>
</html>`;
}

function moonshotPageHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Küçükten Büyüğe Radar</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f14;
      --panel: #121923;
      --panel2: #0f151d;
      --line: #263241;
      --text: #e7edf5;
      --muted: #8fa0b5;
      --good: #35d08c;
      --bad: #ff5e6c;
      --warn: #f2c14e;
      --blue: #6bb7ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; z-index: 3; padding: 16px 18px; background: rgba(11,15,20,.96); border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 22px; }
    .sub { color: var(--muted); margin-top: 4px; line-height: 1.35; }
    main { padding: 18px; display: grid; gap: 16px; }
    .nav { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    a.btn { color: var(--text); border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 9px 12px; text-decoration: none; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .metric { padding: 14px; min-height: 86px; }
    .label, .small { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .value { font-size: 28px; font-weight: 800; margin-top: 7px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
    .wide { grid-column: 1 / -1; }
    .panel h2 { margin: 0; padding: 12px 14px; font-size: 15px; border-bottom: 1px solid var(--line); }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid rgba(38,50,65,.72); vertical-align: top; }
    th { color: var(--muted); font-size: 12px; }
    .tag { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; padding: 3px 7px; color: var(--muted); background: var(--panel2); font-size: 12px; }
    .tag.hot { color: var(--good); border-color: rgba(53,208,140,.45); }
    .tag.mid { color: var(--warn); border-color: rgba(242,193,78,.45); }
    .tag.risk { color: var(--bad); border-color: rgba(255,94,108,.45); }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--muted); font-size: 12px; }
    .goodText { color: var(--good); }
    .badText { color: var(--bad); }
    .log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--muted); font-size: 13px; line-height: 1.45; padding: 12px 14px; background: var(--panel2); }
    @media (max-width: 900px) {
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .wide { grid-column: auto; }
    }
    @media (max-width: 560px) {
      header { padding: 18px 16px; }
      h1 { font-size: 27px; line-height: 1.1; }
      .sub { font-size: 16px; }
      main { padding: 16px; }
      .metrics { grid-template-columns: 1fr; }
      .metric { padding: 20px; min-height: 106px; }
      .label { font-size: 17px; }
      .value { font-size: 38px; }
      .panel h2 { font-size: 21px; padding: 16px 18px; }
      th, td { font-size: 16px; padding: 14px 16px; }
      th, .small, .mono, .tag { font-size: 15px; }
    }
    @media (max-width: 640px) {
      html { -webkit-text-size-adjust:100%; scroll-padding-top:128px; }
      body { overflow-x:hidden; }
      header { padding:12px; max-height:46vh; overflow:auto; }
      h1 { font-size:22px; }
      .sub { font-size:13px; }
      main { padding:12px; gap:12px; }
      .nav { flex-wrap:nowrap; overflow-x:auto; padding-bottom:6px; -webkit-overflow-scrolling:touch; }
      .nav a, a.btn { flex:0 0 auto; white-space:nowrap; font-size:13px; padding:9px 11px; }
      .metrics { grid-template-columns:1fr 1fr; gap:10px; }
      .metric { min-height:84px; padding:12px; }
      .label { font-size:12px; }
      .value { font-size:23px; overflow-wrap:anywhere; }
      .panel h2 { font-size:16px; padding:12px; }
      .table-scroll { border-radius:8px; -webkit-overflow-scrolling:touch; }
      table { min-width:560px; }
      th, td { padding:10px; font-size:13px; }
      th, .small, .mono, .tag { font-size:12px; }
      .log { font-size:12px; }
    }
    @media (max-width:380px) { .metrics { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Küçükten Büyüğe Radar</h1>
    <div class="sub">Küçük lotlarla büyük çarpan yakalayan cüzdanları izler. Burada amaç tam win rate değil, küçük riskle asimetrik fırsat bulmak.</div>
    <div class="nav"><a class="btn" href="/">Dashboard</a><a class="btn" href="/token-research">Token Arastir</a><a class="btn" href="/wallet-research">Cuzdan Arastir</a><a class="btn" href="/moonshot">Moonshot Radar</a><a class="btn" href="/chat">Sohbet</a></div>
  </header>
  <main>
    <section class="metrics">
      <div class="metric"><div class="label">Aday Cüzdan</div><div id="candidateCount" class="value">-</div></div>
      <div class="metric"><div class="label">En Yüksek Çarpan</div><div id="bestRoi" class="value">-</div></div>
      <div class="metric"><div class="label">3x+ Örnek</div><div id="threeX" class="value">-</div></div>
      <div class="metric"><div class="label">Önerilen Lot Aralığı</div><div id="lotRange" class="value">-</div></div>
    </section>

    <section class="grid">
      <div class="panel wide">
        <h2>Moonshot Cüzdanları</h2>
        <div class="table-scroll">
          <table>
            <thead><tr><th>İsim</th><th>Skor</th><th>Çarpan</th><th>Geçmiş</th><th>Risk Lot</th><th>Neden?</th></tr></thead>
            <tbody id="moonRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>Okuma Kuralı</h2>
        <div class="log">Bu sayfada %70 win rate şart değil.

Aradığımız profil:
- küçük/orta lotla giriş
- 3x, 5x, 10x yakalama geçmişi
- toplam PnL pozitif
- zararları tek işlemde kasayı bozmayacak kadar sınırlı

Bu cüzdanlara gerçek modda normal lotla değil, mini risk lotuyla bakılır.</div>
      </div>
      <div class="panel">
        <h2>Lot Mantığı</h2>
        <div class="log" id="lotLogic"></div>
      </div>
      <div class="panel wide">
        <h2>Erken Satış Analizi</h2>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Token</th><th>Cüzdan</th><th>Satış PnL</th><th>Tutsaydık Zirve</th><th>Kaçan</th></tr></thead>
            <tbody id="recoveryRows"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>
  <script>
    const fmtTry = value => Number(value || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 }) + ' TL';
    const short = value => value ? value.slice(0, 6) + '...' + value.slice(-4) : '-';
    const pctText = value => value === null || value === undefined ? '-' : Number(value).toFixed(1) + '%';
    const solText = value => value === null || value === undefined ? '-' : Number(value).toFixed(3) + ' SOL';
    const pnlClass = value => Number(value || 0) >= 0 ? 'goodText' : 'badText';

    function tagFor(score) {
      if (score >= 65) return 'hot';
      if (score >= 40) return 'mid';
      return 'risk';
    }

    async function load() {
      const res = await fetch('/api/state?ts=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      const rows = data.moonshot || [];
      document.getElementById('candidateCount').textContent = rows.length;
      document.getElementById('bestRoi').textContent = rows.length ? ((Math.max(...rows.map(r => r.bestRoi || 0)) / 100) + 1).toFixed(1) + 'x' : '-';
      document.getElementById('threeX').textContent = rows.reduce((sum, r) => sum + (r.threeX || 0), 0);
      const lots = rows.map(r => r.riskLotTry || 0).filter(Boolean);
      document.getElementById('lotRange').textContent = lots.length ? fmtTry(Math.min(...lots)) + ' - ' + fmtTry(Math.max(...lots)) : '-';
      document.getElementById('lotLogic').textContent =
        'Skor 65+  -> 150 TL test lotu\\n' +
        'Skor 45+  -> 100 TL test lotu\\n' +
        'Skor 30+  -> 50 TL test lotu\\n' +
        'Altı      -> 25 TL izleme/mini lot\\n\\n' +
        'Moonshot stratejisi:\\n' +
        '- Wallet sell gelirse biz de tam çıkarız\\n' +
        '- TP1 +' + data.config?.moonshotTakeProfit1Pct + '%: maliyet/kâr kırpma\\n' +
        '- TP2 +' + data.config?.moonshotTakeProfit2Pct + '%: küçük trim\\n' +
        '- Trailing ' + data.config?.moonshotTrailingStopPct + '%: runner koruma\\n\\n' +
        'Aynı tokena 2 moonshot cüzdan girerse sinyal güçlenir; tek cüzdan sinyali otomatik büyük lot değildir.';

      document.getElementById('moonRows').innerHTML = rows.map(row => {
        const best = (row.best || []).map(t => (Number(t.roiPct || 0) / 100 + 1).toFixed(1) + 'x / ' + solText(t.pnlSol)).join('<br>');
        const worst = (row.worst || []).map(t => solText(t.pnlSol)).join(', ');
        return '<tr><td>' + row.name + '<div class="mono">' + short(row.wallet) + '</div><div class="small">' + (row.tokens || []).join(', ') + '</div></td>' +
          '<td><span class="tag ' + tagFor(row.moonScore) + '">' + row.moonScore + '</span><div class="small">' + (row.tracked ? 'ekli' : 'izle') + '</div></td>' +
          '<td><strong>' + ((Number(row.bestRoi || 0) / 100) + 1).toFixed(1) + 'x</strong><div class="small">3x+ ' + row.threeX + ' · 5x+ ' + row.fiveX + '</div></td>' +
          '<td><span class="' + pnlClass(row.pnlSol) + '">' + solText(row.pnlSol) + '</span><div class="small">WR ' + pctText(row.winRate) + ' · ' + row.closed + ' kapalı</div><div class="small">en kötü: ' + worst + '</div></td>' +
          '<td><strong>' + fmtTry(row.riskLotTry) + '</strong></td>' +
          '<td>' + row.reason + '<div class="small">' + best + '</div></td></tr>';
      }).join('') || '<tr><td colspan="6">Aday yok.</td></tr>';

      document.getElementById('recoveryRows').innerHTML = (data.recoveryTrades || []).slice(0, 15).map(row => {
        const token = row.url ? '<a href="' + row.url + '" target="_blank">' + row.symbol + '</a>' : row.symbol;
        return '<tr><td>' + token + '<div class="mono">' + short(row.mint) + '</div></td><td>' + row.wallet + '<div><span class="tag">' + (row.category || '-') + '</span></div></td><td class="badText">' + fmtTry(row.soldPnlTry) + '</td><td class="' + pnlClass(row.peakPnlTry) + '">' + fmtTry(row.peakPnlTry) + '</td><td class="' + pnlClass(row.missedTry) + '">' + fmtTry(row.missedTry) + '<div class="small">' + (row.recovered ? 'kâra dönerdi' : 'zarar devam') + '</div></td></tr>';
      }).join('') || '<tr><td colspan="5">Veri yok.</td></tr>';
    }

    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

function researchPageHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wallet Research</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --panel:#121923; --panel2:#0f151d; --line:#263241; --text:#e7edf5; --muted:#8fa0b5; --good:#35d08c; --bad:#ff5e6c; --warn:#f2c14e; --blue:#6bb7ff; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { position: sticky; top:0; z-index:2; padding:16px 18px; background:rgba(11,15,20,.96); border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:22px; }
    .sub, .small { color:var(--muted); font-size:13px; line-height:1.4; }
    main { padding:18px; display:grid; gap:16px; max-width:1280px; margin:0 auto; }
    .nav { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; }
    .btn, button { border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:8px; padding:10px 12px; text-decoration:none; cursor:pointer; font:inherit; }
    .btn.active { border-color:rgba(107,183,255,.65); color:var(--blue); }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .panel h2 { margin:0; padding:14px 16px; border-bottom:1px solid var(--line); font-size:17px; }
    .panel-body { padding:14px 16px; }
    input { width:100%; border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:8px; padding:12px; font:inherit; }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; font-size:14px; }
    th { color:var(--muted); font-size:12px; font-weight:600; }
    a { color:var(--blue); text-decoration:none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); }
    .tag { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:2px 8px; color:var(--muted); font-size:12px; margin:2px 4px 2px 0; }
    .links { display:flex; flex-wrap:wrap; gap:8px; }
    .table-scroll { overflow:auto; }
    .log { white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; color:var(--muted); background:var(--panel2); padding:12px; border-radius:8px; }
    .decision { color:var(--text); font-family:inherit; line-height:1.45; }
    details.panel summary { cursor:pointer; padding:14px 16px; color:var(--muted); border-bottom:1px solid var(--line); }
    @media (max-width: 840px) { .grid { grid-template-columns:1fr; } h1 { font-size:26px; } th,td { font-size:15px; } }
    @media (max-width: 640px) {
      html { -webkit-text-size-adjust:100%; scroll-padding-top:128px; }
      body { overflow-x:hidden; }
      header { padding:12px; max-height:46vh; overflow:auto; }
      h1 { font-size:22px; line-height:1.1; }
      .sub, .small { font-size:12px; }
      main { padding:12px; gap:12px; }
      .nav, .links { flex-wrap:nowrap; overflow-x:auto; padding-bottom:6px; -webkit-overflow-scrolling:touch; }
      .nav .btn, .nav a, .links .btn { flex:0 0 auto; white-space:nowrap; font-size:13px; padding:9px 11px; }
      .panel h2, details.panel summary { font-size:16px; padding:12px; }
      .panel-body { padding:12px; }
      input, button { font-size:16px; min-height:44px; }
      button { width:100%; }
      .table-scroll { border-radius:8px; -webkit-overflow-scrolling:touch; }
      table { min-width:560px; }
      th,td { padding:10px; font-size:13px; }
      th,.mono,.tag { font-size:12px; }
      .log { font-size:12px; max-height:280px; overflow:auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Cuzdan Arastirma</h1>
    <div class="sub">Smart wallet, sniper/insider-benzeri cuzdan ve basari gecmisini inceler. Token analizi ayri sayfadadir.</div>
    <div class="nav"><a class="btn" href="/">Dashboard</a><a class="btn" href="/token-research">Token Arastir</a><a class="btn active" href="/wallet-research">Cuzdan Arastir</a><a class="btn" href="/moonshot">Moonshot</a><a class="btn" href="/chat">Sohbet</a></div>
  </header>
  <main>
    <section class="panel">
      <h2>Cüzdan Kontrol</h2>
      <div class="panel-body">
        <input id="walletInput" placeholder="Solana cüzdan adresi yapıştır..." />
        <div style="height:10px"></div>
        <button id="checkBtn">Kontrol Et</button>
        <div style="height:12px"></div>
        <div id="walletResult" class="log decision">Bir adres girince sade özet burada görünecek: cüzdan ne yapmış, başarı/zarar durumu, riskler ve bizim kararımız.</div>
      </div>
    </section>

    <section class="grid">
      <details class="panel">
        <summary>Teknik kaynaklar</summary>
        <div class="table-scroll"><table><thead><tr><th>Kaynak</th><th>Durum</th><th>Bizde kullanım</th></tr></thead><tbody id="apiNotes"></tbody></table></div>
      </details>
      <div class="panel">
        <h2>Sistem Özeti</h2>
        <div class="panel-body"><div id="summary" class="log decision">Yükleniyor...</div></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Free Alpha Cluster</h2>
        <div class="panel-body"><button id="scanAlphaBtn">Hızlı Free Alpha Tara</button><span id="scanAlphaStatus" class="small" style="margin-left:10px"></span></div>
        <div class="table-scroll"><table><thead><tr><th>Token</th><th>Skor</th><th>Akıllı Alıcı</th><th>Aksiyon</th></tr></thead><tbody id="alphaClusters"></tbody></table></div>
      </div>
      <div class="panel">
        <h2>Free Alpha Cüzdanlar</h2>
        <div class="table-scroll"><table><thead><tr><th>Cüzdan</th><th>Profil</th><th>Geçmiş</th><th>Aksiyon</th></tr></thead><tbody id="alphaWallets"></tbody></table></div>
      </div>
    </section>

    <section class="panel">
      <h2>Otomatik Avcı</h2>
      <div class="panel-body small">Sniper, insider-benzeri ve smart wallet adaylarını ayrı ayrı çıkarır. Bu bir kimlik iddiası değil; zincir üstü davranış puanıdır.</div>
      <div class="table-scroll"><table><thead><tr><th>Tip</th><th>Cüzdan</th><th>Skor</th><th>Ne Yapmış?</th><th>Karar</th></tr></thead><tbody id="hunterRows"></tbody></table></div>
    </section>

    <section class="panel">
      <h2>Başarılı Trader Adayları</h2>
      <div class="table-scroll"><table><thead><tr><th>Cüzdan</th><th>Performans</th><th>Çarpan</th><th>Kontrol</th></tr></thead><tbody id="candidates"></tbody></table></div>
    </section>
  </main>
  <script>
    const short = value => value ? value.slice(0, 6) + '...' + value.slice(-4) : '-';
    const sol = value => value === null || value === undefined ? '-' : Number(value).toFixed(4) + ' SOL';
    const pct = value => value === null || value === undefined ? '-' : Number(value).toFixed(1) + '%';
    const age = iso => {
      if (!iso) return '-';
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
      if (seconds < 60) return seconds + ' sn önce';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + ' dk önce';
      if (minutes < 1440) return Math.floor(minutes / 60) + ' sa önce';
      return Math.floor(minutes / 1440) + ' gün önce';
    };
    const links = address => ({
      gmgn: 'https://gmgn.ai/sol/address/' + address,
      solscan: 'https://solscan.io/account/' + address,
      cielo: 'https://app.cielo.finance/profile/' + address,
      arkham: 'https://platform.arkhamintelligence.com/explorer/address/' + address,
      nansen: 'https://app.nansen.ai/search?query=' + address
    });
    const linkHtml = address => {
      const l = links(address);
      return '<div class="links">' +
        '<a class="btn" target="_blank" href="' + l.gmgn + '">GMGN</a>' +
        '<a class="btn" target="_blank" href="' + l.solscan + '">Solscan</a>' +
        '<a class="btn" target="_blank" href="' + l.cielo + '">Cielo</a>' +
        '<a class="btn" target="_blank" href="' + l.arkham + '">Arkham</a>' +
        '<a class="btn" target="_blank" href="' + l.nansen + '">Nansen</a>' +
      '</div>';
    };
    async function addWallet(address, mode, note, score, lotTry) {
      const status = document.getElementById('scanAlphaStatus');
      status.textContent = 'cüzdan ekleniyor...';
      try {
        const res = await fetch('/api/control/wallet/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            address,
            mode,
            score: score || (mode === 'copy' ? 60 : 45),
            tradeTry: mode === 'copy' ? (lotTry || 60) : 0,
            class: mode === 'copy' ? 'B' : 'C',
            moonshot: true,
            note
          })
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || 'eklenemedi');
        status.textContent = (data.existing ? 'güncellendi: ' : 'eklendi: ') + data.wallet.name + ' / ' + data.wallet.mode;
        await load();
      } catch (error) {
        status.textContent = 'hata: ' + (error.message || error);
      }
    }
    window.addWallet = addWallet;
    const addButtons = (address, note, score, lotTry) =>
      '<div class="actions">' +
      '<button onclick="addWallet(\\'' + address + '\\', \\'alert\\', \\' ' + note.replace(/'/g, '') + '\\', ' + Number(score || 45) + ', ' + Number(lotTry || 60) + ')">Alert ekle</button>' +
      '<button onclick="addWallet(\\'' + address + '\\', \\'copy\\', \\' ' + note.replace(/'/g, '') + '\\', ' + Number(score || 60) + ', ' + Number(lotTry || 60) + ')">Copy ekle</button>' +
      '</div>';
    const explainProfile = row => {
      const p = row?.profile || '-';
      if (p === 'PIR ADAYI') return 'Güçlü aday: erken yakalıyor, geçmişi fena değil, risk bayrağı az.';
      if (p === 'IZLE + MINI') return 'Denemeye değer: mini lot ve ikinci onayla izlenir.';
      if (p === 'MOONSHOT RADAR') return 'Asimetrik fırsat: normal copy değil, küçük riskle izlenir.';
      if (p === 'RISKLI') return 'Şimdilik uzak: veri toplarız ama copy kapalı.';
      return 'Kararsız: sinyal gelirse yeniden puanlanır.';
    };
    const walletStory = row => {
      if (!row) return 'Bu cüzdan bizim lokal listelerde yok. Önce GMGN/Solscan ile manuel doğrulamak gerekir.';
      const flags = (row.riskFlags || []).length ? (row.riskFlags || []).join(', ') : 'belirgin risk bayrağı yok';
      const tokens = (row.tokens || []).length ? (row.tokens || []).join(', ') : 'token listesi yok';
      const cls = row.classifier || {};
      const gate = row.walletGate || {};
      const gateText = (gate.gates || []).map(item => item.name + ':' + item.status).join(', ') || 'kapilar yok';
      return [
        'Sistem sinifi: ' + (cls.label || '-') + ' / ' + Number(cls.score || 0).toFixed(1) + '. ' + (cls.action || '-'),
        '6 kapi: ' + (gate.grade || '-') + ' / gecen ' + (gate.passed || 0) + ', sari ' + (gate.warn || 0) + ', kalan ' + (gate.failed || 0) + ' -> ' + gateText,
        'Özet: ' + explainProfile(row),
        'Ne yapmış: taranan son örnekte ' + (row.hits || 0) + ' farklı tokena temas etmiş; ' + (row.earlyHits || 0) + ' tanesinde erken alıcı tarafında görünüyor.',
        'Geçmiş sonuç: ' + sol(row.pnlSol) + ' PnL, WR ' + pct(row.winRate) + ', max ' + (row.maxX || '-') + 'x, en kötü zarar ' + sol(row.biggestLossSol) + '.',
        'Davranış: açık token ' + (row.openLotCount || 0) + ', noise ' + (row.noiseRatio || 0) + ', harcanan ' + Number(row.spentSol || 0).toFixed(2) + ' SOL.',
        'Risk: ' + flags + '.',
        'Karar: ' + (row.action || '-') + ' Önerilen test lotu: ' + (row.lotTry || 0) + ' TL.',
        'Gördüğü tokenlar: ' + tokens + '.'
      ].join('\\n');
    };
    const clusterStory = row => {
      if (!row) return 'Henüz okunacak cluster yok.';
      return 'En öne çıkan token: ' + row.symbol + '\\n' +
        'Cluster skoru: ' + row.clusterScore + '/100. Pir onayı ' + (row.strongCount || 0) + ', smart alıcı ' + (row.smartCount || 0) + ', riskli alıcı ' + (row.riskyCount || 0) + '.\\n' +
        'Likidite $' + Number(row.liquidityUsd || 0).toLocaleString('en-US') + ', FDV $' + Number(row.fdv || 0).toLocaleString('en-US') + ', 24s değişim ' + Number(row.change24 || 0).toFixed(1) + '%.\\n' +
        'Sistem kararı: ' + row.action;
    };
    const hunterRows = hunter => {
      const addType = (type, rows) => (rows || []).map(row => ({ type, row }));
      const rows = [
        ...addType('Sniper', hunter?.sniperWallets),
        ...addType('Insider-benzeri', hunter?.insiderLikeWallets),
        ...addType('Smart wallet', hunter?.smartWallets)
      ];
      const seen = new Set();
      return rows.filter(item => {
        const key = item.type + ':' + item.row.wallet;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 18);
    };

    async function load(address = '') {
      const res = await fetch('/api/research' + (address ? '?address=' + encodeURIComponent(address) : ''), { cache:'no-store' });
      const data = await res.json();
      document.getElementById('apiNotes').innerHTML = data.apiNotes.map(row =>
        '<tr><td>' + (row.link ? '<a target="_blank" href="' + row.link + '">' + row.name + '</a>' : row.name) + '</td><td><span class="tag">' + row.status + '</span></td><td>' + row.use + '</td></tr>'
      ).join('');
      const s = data.configSummary || {};
      const topWallet = data.freeAlpha?.wallets?.[0];
      const topCluster = data.freeAlpha?.clusters?.[0];
      const hunter = data.freeAlpha?.hunter || {};
      document.getElementById('summary').textContent =
        'Kısa karar\\n' +
        (topWallet ? ('En iyi cüzdan: ' + short(topWallet.wallet) + ' / ' + (topWallet.profile || '-') + ' / alpha ' + topWallet.alphaScore + '\\n') : 'En iyi cüzdan: henüz yok\\n') +
        (topCluster ? ('En iyi token cluster: ' + topCluster.symbol + ' / skor ' + topCluster.clusterScore + ' / ' + topCluster.action + '\\n') : 'En iyi token cluster: henüz yok\\n') +
        'Avcı özeti: sniper ' + (hunter.sniperWallets?.length || 0) + ', insider-benzeri ' + (hunter.insiderLikeWallets?.length || 0) + ', smart wallet ' + (hunter.smartWallets?.length || 0) + '\\n' +
        '\\n' +
        'En iyi cüzdan ne yapmış?\\n' +
        walletStory(topWallet) + '\\n\\n' +
        'En iyi token tarafı\\n' +
        clusterStory(topCluster) + '\\n\\n' +
        'Sistem durumu\\n' +
        'Takip edilen cüzdan: ' + s.trackedWallets + '\\n' +
        'Copy açık: ' + s.copyWallets + '\\n' +
        'Helius: ' + (s.heliusEnabled ? 'bağlı' : 'API key yok') + '\\n' +
        'Nansen: ' + (s.nansenEnabled ? 'key var' : 'API key yok') + '\\n' +
        'Free Alpha son tarama: ' + (data.freeAlpha?.createdAt ? age(data.freeAlpha.createdAt) : 'yok') + '\\n' +
        'Max mcap filtresi: ' + (s.maxBuyMarketCapUsd === null ? 'kapalı' : s.maxBuyMarketCapUsd) + '\\n' +
        'Kasa: ' + (s.cashTry === null ? '-' : Number(s.cashTry).toFixed(2) + ' TL') + '\\n' +
        'Realized: ' + (s.realizedTry === null ? '-' : Number(s.realizedTry).toFixed(2) + ' TL');

      document.getElementById('alphaClusters').innerHTML = (data.freeAlpha?.clusters || []).map(row => {
        const token = row.url ? '<a target="_blank" href="' + row.url + '">' + row.symbol + '</a>' : row.symbol;
        const smart = (row.buyers || []).filter(buyer => Number(buyer.alphaScore || 0) >= 45).length;
        return '<tr><td>' + token + '<div class="mono">' + short(row.mint) + '</div><div class="small">liq $' + Number(row.liquidityUsd || 0).toLocaleString('en-US') + ' · fdv $' + Number(row.fdv || 0).toLocaleString('en-US') + '</div></td>' +
          '<td><b>' + row.clusterScore + '</b><div class="small">pir ' + (row.strongCount || 0) + ' · smart ' + smart + ' · risk ' + (row.riskyCount || 0) + '</div><div class="small">24h ' + Number(row.change24 || 0).toFixed(1) + '%</div></td>' +
          '<td>' + smart + '<div class="small">' + (row.buyers || []).slice(0, 3).map(buyer => short(buyer.wallet) + ' / A' + buyer.alphaScore + ' I' + (buyer.insiderScore || 0) + ' / ' + (buyer.profile || '-')).join('<br>') + '</div></td>' +
          '<td>' + row.action + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="small">Henüz Free Alpha taraması yok. Butona basınca dolar.</td></tr>';

      document.getElementById('alphaWallets').innerHTML = (data.freeAlpha?.wallets || []).map(row => {
        const flags = (row.riskFlags || []).length ? (row.riskFlags || []).join(', ') : 'temiz';
        const profileClass = row.classifier || {};
        const profileGate = row.walletGate || {};
        return '<tr><td><div class="mono">' + row.wallet + '</div><div class="small">' + (row.tokens || []).join(', ') + '</div></td>' +
          '<td><b>' + (row.profile || '-') + '</b><div class="small">alpha ' + row.alphaScore + ' · insider ' + (row.insiderScore || 0) + ' · kalite ' + row.quality + '</div><div class="small">risk: ' + flags + '</div></td>' +
          '<td>' + sol(row.pnlSol) + '<div class="small">WR ' + pct(row.winRate) + ' · max ' + row.maxX + 'x · zarar ' + sol(row.biggestLossSol) + '</div><div class="small">açık token ' + (row.openLotCount || 0) + ' · noise ' + (row.noiseRatio || 0) + '</div></td>' +
          '<td>' + (row.action || '-') + '<div class="small">lot ' + (row.lotTry || 0) + ' TL · ' + row.earlyHits + ' erken · ' + row.hits + ' hit · ' + Number(row.spentSol || 0).toFixed(2) + ' SOL</div>' + addButtons(row.wallet, 'Free Alpha ' + (row.profile || '-') + ' alpha ' + row.alphaScore, row.alphaScore, row.lotTry || 60) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="small">Henüz Free Alpha cüzdan verisi yok.</td></tr>';

      document.getElementById('hunterRows').innerHTML = hunterRows(data.freeAlpha?.hunter).map(item => {
        const row = item.row;
        const flags = (row.riskFlags || []).length ? (row.riskFlags || []).join(', ') : 'temiz';
        const profileClass = row.classifier || {};
        const profileGate = row.walletGate || {};
        const score =
          item.type === 'Sniper' ? row.sniperScore :
          item.type === 'Insider-benzeri' ? row.insiderScore :
          row.alphaScore;
        return '<tr><td><b>' + item.type + '</b><div class="small">' + (row.archetypes || []).join(', ') + '</div></td>' +
          '<td><div class="mono">' + row.wallet + '</div><div class="small">' + linkHtml(row.wallet) + '</div></td>' +
          '<td><b>' + score + '</b><div class="small">A' + row.alphaScore + ' · I' + row.insiderScore + ' · S' + row.sniperScore + '</div></td>' +
          '<td>' + (row.hits || 0) + ' token, ' + (row.earlyHits || 0) + ' erken giriş<div class="small">PnL ' + sol(row.pnlSol) + ' · WR ' + pct(row.winRate) + ' · max ' + row.maxX + 'x · risk: ' + flags + '</div></td>' +
          '<td>' + (row.action || '-') + '<div class="small">profil ' + (row.profile || '-') + ' · test lot ' + (row.lotTry || 0) + ' TL</div>' + addButtons(row.wallet, item.type + ' ' + (row.profile || '-') + ' skor ' + score, score, row.lotTry || 60) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="small">Henüz otomatik avcı adayı yok. Hızlı Free Alpha Tara çalışınca dolar.</td></tr>';

      document.getElementById('candidates').innerHTML = data.candidates.map(row => {
        const cls = Number(row.pnlSol || 0) >= 0 ? 'good' : 'bad';
        const verdict = row.verdict || {};
        const gradeClass = verdict.grade === 'A' || verdict.grade === 'MOON' ? 'good' : verdict.grade === 'RISK' ? 'bad' : 'warn';
        return '<tr><td><b>' + row.name + '</b><div class="mono">' + row.wallet + '</div><div class="small">' + (row.sources || []).join(', ') + '</div></td>' +
          '<td><span class="' + cls + '">' + sol(row.pnlSol) + '</span><div class="small">WR ' + pct(row.winRate) + ' · ' + row.closed + ' kapanış · max zarar ' + sol(row.biggestLossSol) + '</div></td>' +
          '<td><b>' + row.maxX + 'x</b><div class="small">skor ' + row.score + ' · ' + (row.tokens || []).join(', ') + '</div></td>' +
          '<td><b class="' + gradeClass + '">' + (verdict.grade || '-') + ' / ' + (verdict.confidence || 0) + '</b><div class="small">' + (verdict.action || '-') + '</div><div class="small">' + ((verdict.reasons || []).join(' | ')) + '</div>' + linkHtml(row.wallet) + '</td></tr>';
      }).join('');

      if (data.wallet) renderWallet(data.wallet);
    }

    function renderWallet(wallet) {
      const local = wallet.local;
      const alpha = wallet.alphaLocal;
      const nansenLabels = (wallet.nansen?.labels || []).slice(0, 8).map(label =>
        '- ' + label.label + ' [' + label.category + (label.confidence ? ' / ' + label.confidence : '') + ']'
      ).join('\\n');
      const nansenPremium = (wallet.nansen?.premiumLabels || []).slice(0, 8).map(label =>
        '- ' + label.label + ' [' + label.category + (label.confidence ? ' / ' + label.confidence : '') + ']'
      ).join('\\n');
      const txs = (wallet.recentSignatures || []).slice(0, 5).map(tx =>
        '- ' + (tx.time ? age(tx.time) : '-') + ' · ' + tx.signature.slice(0, 10) + '... ' + (tx.err ? 'ERR' : 'ok')
      ).join('\\n');
      document.getElementById('walletResult').innerHTML =
        '<b>' + wallet.address + '</b>\\n\\n' +
        'Sade karar\\n' +
        (alpha ? walletStory(alpha) : (local ? ('Bu cüzdan başarılı trader listemizde var. Lokal karar: ' + (wallet.verdict?.grade || '-') + ' / ' + (wallet.verdict?.confidence || 0) + '. ' + (wallet.verdict?.action || '-')) : 'Bu cüzdan bizim lokal listelerde yok. Önce sadece izleme ve manuel doğrulama.')) + '\\n\\n' +
        'Canlı durum\\n' +
        'Bakiye: ' + sol(wallet.balanceSol) + '\\n' +
        'Son aktivite: ' + age(wallet.lastSeenAt) + '\\n' +
        'Son 5 işlem:\\n' + (txs || '-') + '\\n\\n' +
        'Dış kontrol\\n' +
        'Helius:\\n' +
        '- durum: ' + (wallet.helius?.enabled ? 'bağlı' : 'API key yok') + '\\n' +
        '- asset sayısı: ' + (wallet.helius?.assetCount ?? '-') + '\\n' +
        '- native balance: ' + sol(wallet.helius?.nativeBalanceSol) + '\\n' +
        '- parsed tx: ' + ((wallet.helius?.enhancedTransactions || []).length || 0) + '\\n\\n' +
        'Nansen:\\n' +
        '- durum: ' + (wallet.nansen?.enabled ? 'key var' : 'API key yok') + '\\n' +
        '- label: ' + ((wallet.nansen?.labels || []).length || 0) + '\\n' +
        '- premium label: ' + ((wallet.nansen?.premiumLabels || []).length || 0) + '\\n' +
        (wallet.nansen?.error ? '- hata: ' + wallet.nansen.error + '\\n' : '') +
        (nansenLabels ? 'Normal label:\\n' + nansenLabels + '\\n' : '') +
        (nansenPremium ? 'Premium label:\\n' + nansenPremium + '\\n' : '') +
        '\\n' +
        (local ? ('Klasik trader skoru:\\n' +
          '- isim: ' + local.name + '\\n' +
          '- PnL: ' + sol(local.pnlSol) + '\\n' +
          '- WR: ' + pct(local.winRate) + '\\n' +
          '- max X: ' + local.maxX + 'x\\n' +
          '- karar: ' + (wallet.verdict?.grade || '-') + ' / ' + (wallet.verdict?.confidence || 0) + ' · ' + (wallet.verdict?.action || '-') + '\\n' +
          '- kaynak: ' + (local.sources || []).join(', ') + '\\n\\n') : 'Klasik trader listelerinde bulunamadı.\\n\\n') +
        linkHtml(wallet.address);
    }

    document.getElementById('checkBtn').addEventListener('click', () => {
      const address = document.getElementById('walletInput').value.trim();
      if (address) load(address);
    });
    document.getElementById('walletInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') document.getElementById('checkBtn').click();
    });
    document.getElementById('scanAlphaBtn').addEventListener('click', async () => {
      const status = document.getElementById('scanAlphaStatus');
      const btn = document.getElementById('scanAlphaBtn');
      btn.disabled = true;
      status.textContent = 'tarama çalışıyor...';
      try {
        const res = await fetch('/api/free-alpha/scan', { method:'POST', cache:'no-store' });
        const data = await res.json();
        status.textContent = data.ok ? 'bitti: ' + (data.wallets?.length || 0) + ' cüzdan / ' + (data.clusters?.length || 0) + ' cluster' : 'hata';
        await load(document.getElementById('walletInput').value.trim());
      } catch (error) {
        status.textContent = 'hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    });
    load();
  </script>
</body>
</html>`;
}

function oraclePageHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Token Arastirma</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#0b0f14; --panel:#121923; --panel2:#0f151d; --line:#263241;
      --text:#e7edf5; --muted:#8fa0b5; --good:#35d08c; --bad:#ff5e6c;
      --warn:#f2c14e; --blue:#6bb7ff;
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body.simple main > section:not(.keep-simple) { display:none; }
    header { position:sticky; top:0; z-index:4; padding:16px 18px; background:rgba(11,15,20,.96); border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:24px; letter-spacing:0; }
    .sub, .small { color:var(--muted); line-height:1.4; }
    .sub { margin-top:4px; }
    main { padding:18px; display:grid; gap:16px; max-width:1320px; margin:0 auto; }
    .nav, .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .nav { margin-top:12px; }
    .oracle-map { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
    .oracle-jump { text-align:left; min-height:92px; display:grid; align-content:start; gap:6px; }
    .oracle-jump b { color:var(--text); font-size:14px; }
    .oracle-jump span { color:var(--muted); font-size:12px; line-height:1.35; }
    .section-kicker { color:var(--blue); font-size:12px; font-weight:750; margin-right:8px; }
    .kid-grid { display:grid; grid-template-columns:1.15fr 1fr 1fr; gap:12px; align-items:start; }
    .kid-card { border:1px solid rgba(38,50,65,.8); background:rgba(15,21,29,.82); border-radius:8px; padding:14px; min-height:150px; }
    .kid-title { color:var(--muted); font-size:12px; margin-bottom:8px; }
    .kid-main { font-size:26px; font-weight:850; line-height:1.15; overflow-wrap:anywhere; }
    .kid-list { display:grid; gap:8px; }
    .kid-item { border:1px solid rgba(38,50,65,.65); border-radius:8px; padding:10px; background:rgba(11,15,20,.45); }
    .kid-item b { display:block; margin-bottom:4px; }
    .kid-steps { display:grid; gap:8px; counter-reset:step; }
    .kid-step { display:grid; grid-template-columns:28px 1fr; gap:8px; align-items:start; color:var(--muted); }
    .kid-step:before { counter-increment:step; content:counter(step); display:grid; place-items:center; width:24px; height:24px; border-radius:999px; background:#18324b; color:var(--text); font-size:12px; font-weight:800; }
    .plain-guide { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
    .plain-guide div { padding:10px; border:1px solid rgba(38,50,65,.65); border-radius:8px; background:rgba(15,21,29,.7); }
    a, .link { color:var(--blue); text-decoration:none; }
    .btn, button { border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:8px; padding:10px 12px; text-decoration:none; cursor:pointer; font:inherit; min-height:40px; }
    .btn.active { border-color:rgba(107,183,255,.65); color:var(--blue); }
    button.primary { background:#18324b; border-color:#295c88; }
    button:disabled { opacity:.6; cursor:wait; }
    input { width:100%; border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:8px; padding:13px 14px; font:inherit; min-height:46px; }
    .search { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:10px; align-items:center; }
    .metrics { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; }
    .metric, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .metric { padding:14px; min-height:96px; }
    .label { color:var(--muted); font-size:12px; }
    .value { margin-top:7px; font-size:28px; font-weight:800; line-height:1.1; overflow-wrap:anywhere; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
    .wide { grid-column:1 / -1; }
    .panel h2 { margin:0; padding:13px 15px; border-bottom:1px solid var(--line); font-size:16px; }
    .panel-body { padding:14px 15px; }
    .table-scroll { overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:620px; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid rgba(38,50,65,.75); vertical-align:top; font-size:14px; }
    th { color:var(--muted); font-size:12px; }
    .tag { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:3px 8px; color:var(--muted); font-size:12px; margin:2px 4px 2px 0; }
    .tag.A { color:var(--good); border-color:rgba(53,208,140,.45); }
    .tag.B, .tag.WATCH { color:var(--warn); border-color:rgba(242,193,78,.45); }
    .tag.RISK { color:var(--bad); border-color:rgba(255,94,108,.45); }
    .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); } .blue { color:var(--blue); }
    .mono { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .log { white-space:pre-wrap; color:var(--muted); background:var(--panel2); border-radius:8px; padding:12px; line-height:1.5; }
    .bars { display:grid; gap:8px; }
    .bar { display:grid; grid-template-columns:130px minmax(0,1fr) 48px; gap:10px; align-items:center; font-size:13px; }
    .track { height:10px; background:var(--panel2); border:1px solid var(--line); border-radius:999px; overflow:hidden; }
    .fill { height:100%; background:linear-gradient(90deg, var(--blue), var(--good)); width:0%; }
    .token-head { display:grid; grid-template-columns:72px minmax(0,1fr); gap:12px; align-items:center; }
    .token-img { width:72px; height:72px; border-radius:8px; object-fit:cover; background:var(--panel2); border:1px solid var(--line); }
    .empty { color:var(--muted); padding:14px; }
    .simple-hero { display:grid; grid-template-columns:1.2fr .8fr; gap:14px; }
    .decision-card { padding:16px; background:var(--panel2); border:1px solid var(--line); border-radius:8px; min-height:132px; }
    .decision-title { color:var(--muted); font-size:13px; }
    .decision-main { margin-top:8px; font-size:28px; line-height:1.12; font-weight:850; overflow-wrap:anywhere; }
    .simple-list { display:grid; gap:10px; }
    .simple-row { padding:12px; border:1px solid rgba(38,50,65,.75); border-radius:8px; background:rgba(15,21,29,.7); }
    .simple-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .mini-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
    .mini-card { padding:12px; border:1px solid rgba(38,50,65,.75); border-radius:8px; background:rgba(15,21,29,.78); min-height:92px; }
    .mini-card b { display:block; font-size:18px; margin-top:6px; overflow-wrap:anywhere; }
    .certainty { height:12px; border:1px solid var(--line); background:var(--panel2); border-radius:999px; overflow:hidden; margin-top:10px; }
    .certainty > span { display:block; height:100%; width:0%; background:linear-gradient(90deg, var(--bad), var(--warn), var(--good)); }
    .category-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
    .cat-card { padding:12px; border:1px solid rgba(38,50,65,.75); border-radius:8px; background:rgba(15,21,29,.78); min-height:104px; }
    .cat-card strong { display:block; font-size:15px; margin-bottom:6px; }
    .alien-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
    .alien-card { padding:13px; border:1px solid rgba(107,183,255,.24); border-radius:8px; background:linear-gradient(180deg, rgba(18,25,35,.96), rgba(12,18,25,.96)); min-height:148px; }
    .alien-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    .alien-score { font-size:26px; font-weight:850; line-height:1; }
    .alien-track { height:8px; border:1px solid var(--line); background:var(--panel2); border-radius:999px; overflow:hidden; margin:10px 0; }
    .alien-track > span { display:block; height:100%; width:0%; background:linear-gradient(90deg, var(--blue), var(--good)); }
    @media (max-width: 900px) {
      .grid { grid-template-columns:1fr; }
      .wide { grid-column:auto; }
      .metrics { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .search { grid-template-columns:1fr; }
      .simple-hero { grid-template-columns:1fr; }
      .mini-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .category-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .alien-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .oracle-map { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .kid-grid { grid-template-columns:1fr; }
      .plain-guide { grid-template-columns:repeat(2,minmax(0,1fr)); }
    }
    @media (max-width: 560px) {
      header { padding:16px; }
      h1 { font-size:26px; }
      main { padding:14px; }
      .metrics { grid-template-columns:1fr; }
      .value { font-size:34px; }
      th, td { font-size:15px; }
      .bar { grid-template-columns:1fr; gap:5px; }
      table { min-width:720px; }
      .mini-grid { grid-template-columns:1fr; }
      .category-grid { grid-template-columns:1fr; }
      .alien-grid { grid-template-columns:1fr; }
      .oracle-map { grid-template-columns:1fr; }
      .plain-guide { grid-template-columns:1fr; }
    }
    @media (max-width: 640px) {
      html { -webkit-text-size-adjust:100%; scroll-padding-top:132px; }
      body { overflow-x:hidden; }
      header { padding:12px; max-height:48vh; overflow:auto; }
      h1 { font-size:22px; line-height:1.1; }
      .sub, .small { font-size:12px; }
      main { padding:12px; gap:12px; }
      .nav, .actions, .simple-actions { flex-wrap:nowrap; overflow-x:auto; padding-bottom:6px; -webkit-overflow-scrolling:touch; }
      .nav .btn, .nav a, .actions button, .actions .btn, .simple-actions button, .simple-actions .btn { flex:0 0 auto; white-space:nowrap; font-size:13px; padding:9px 11px; }
      .kid-grid, .grid, .simple-hero, .alien-grid, .category-grid, .oracle-map, .mini-grid, .plain-guide { grid-template-columns:1fr; }
      .kid-card, .mini-card, .metric { min-height:0; padding:12px; }
      .kid-main, .decision-main { font-size:22px; }
      .metrics { grid-template-columns:1fr 1fr; gap:10px; }
      .value { font-size:23px; overflow-wrap:anywhere; }
      .panel h2 { font-size:16px; padding:12px; }
      .panel-body { padding:12px; }
      .search { grid-template-columns:1fr; }
      input, button { font-size:16px; min-height:44px; }
      .table-scroll { border-radius:8px; -webkit-overflow-scrolling:touch; }
      table { min-width:560px; }
      th, td { padding:10px; font-size:13px; }
      th, .mono, .tag { font-size:12px; }
      .log { font-size:12px; max-height:280px; overflow:auto; }
      .alien-card { min-height:0; padding:12px; }
      .alien-score { font-size:22px; }
      .oracle-jump { min-height:74px; }
    }
    @media (max-width:380px) { .metrics { grid-template-columns:1fr; } }
  </style>
</head>
<body class="simple">
  <header>
    <h1>Token Arastirma</h1>
    <div class="sub">Token CA, DexScreener linki veya sembol ile token risk/firsat analizi yapar. Cuzdan analizi ayri sayfadadir.</div>
    <div class="nav">
      <a class="btn" href="/">Dashboard</a>
      <a class="btn active" href="/token-research">Token Arastir</a>
      <a class="btn" href="/wallet-research">Cuzdan Arastir</a>
      <a class="btn" href="/moonshot">Moonshot</a>
      <a class="btn" href="/gmgn">GMGN Agent</a>
      <a class="btn" href="/control">Kontrol</a>
      <a class="btn" href="/chat">Sohbet</a>
    </div>
  </header>
  <main>
    <section class="panel keep-simple">
      <h2>Token Girisi</h2>
      <div class="panel-body">
        <div class="search">
          <input id="query" placeholder="Mint, DexScreener linki veya sembol..." />
          <button id="analyze" class="primary">Analiz Et</button>
          <button id="analyzeCurrent">Son Sinyal</button>
        </div>
        <div id="status" class="small" style="margin-top:10px">Hazir.</div>
      </div>
    </section>

    <section class="panel keep-simple">
      <h2>Sayfa Haritasi</h2>
      <div class="panel-body">
        <div class="oracle-map">
          <button class="oracle-jump" data-target="oracle-summary"><b>1. Ozet</b><span>Net karar, neden almadik, trend ve bugunku frenler.</span></button>
          <button class="oracle-jump" data-target="oracle-token-hunt"><b>2. Token Avi</b><span>Otomatik bulunan ve manuel eklenen token adaylari.</span></button>
          <button class="oracle-jump" data-target="oracle-social"><b>3. Sosyal & Trend</b><span>Buyuk hesaplar, anlatilar ve zincir sicakligi.</span></button>
          <button class="oracle-jump" data-target="oracle-opportunity"><b>4. Firsat & Risk</b><span>Alim engelleri, risk doktoru ve ayar onerileri.</span></button>
          <button class="oracle-jump" data-target="oracle-wallet-link"><b>5. Cuzdan Sayfasi</b><span>Cuzdan avini ayri ekranda yonet.</span></button>
          <button class="oracle-jump" data-target="oracle-premium"><b>6. Premium Akis</b><span>Nansen ve GMGN tarzi smart-money teyitleri.</span></button>
          <button class="oracle-jump" data-target="oracle-council"><b>7. Karar Kurulu</b><span>Coklu teyit, oylar ve izleme aksiyonlari.</span></button>
          <button class="oracle-jump" data-target="oracle-lab"><b>8. Laboratuvar</b><span>Edge Matrix, detayli token raporu ve ham veriler.</span></button>
        </div>
        <div class="small" style="margin-top:10px">Kategoriye basinca detay modu acilir ve ilgili bolume gider. Gercek emir yok; burasi karar ve eleme ekrani.</div>
      </div>
    </section>

    <section class="panel keep-simple">
      <h2>En Basit Haliyle Ne Oluyor?</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="simpleRefresh" class="primary">Yenile</button>
          <button id="toggleAdvanced">Teknik Detayları Göster</button>
          <span id="simpleStatus" class="small">Tokenler, cüzdanlar ve net karar hazırlanıyor.</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="kid-grid">
          <div class="kid-card">
            <div class="kid-title">Şu anki net karar</div>
            <div id="childDecision" class="kid-main">Yükleniyor...</div>
            <div id="childWhy" class="small" style="margin-top:10px"></div>
            <div id="childActions" class="simple-actions"></div>
          </div>
          <div class="kid-card">
            <div class="kid-title">Bulunan tokenler</div>
            <div id="childTokens" class="kid-list"><div class="kid-item">Yükleniyor...</div></div>
          </div>
          <div class="kid-card">
            <div class="kid-title">Cüzdan araştırması</div>
            <div id="childWallets" class="kid-list"><div class="kid-item">Cüzdan avı ayrı sayfada.</div></div>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <div class="kid-grid">
          <div class="kid-card">
            <div class="kid-title">Buna bakınca ne yapacağız?</div>
            <div id="childNextSteps" class="kid-steps"></div>
          </div>
          <div class="kid-card">
            <div class="kid-title">Renklerin anlamı</div>
            <div class="plain-guide">
              <div><b class="good">SCOUT</b><span class="small">Paper denemeye aday.</span></div>
              <div><b class="warn">İZLE</b><span class="small">Teyit bekliyor.</span></div>
              <div><b class="bad">ALMA</b><span class="small">Risk veya veri eksiği var.</span></div>
              <div><b class="blue">COPY</b><span class="small">Önce küçük paper lot.</span></div>
            </div>
          </div>
          <div class="kid-card">
            <div class="kid-title">Sistem neye bakıyor?</div>
            <div id="childSignals" class="kid-list"></div>
          </div>
        </div>
      </div>
    </section>

    <section id="oracle-summary" class="panel">
      <h2><span class="section-kicker">TEKNIK OZET</span>Modül Detayları</h2>
      <div class="panel-body">
        <div class="actions">
          <span class="small">Burası teknik kontrol alanı. İlk karar için üstteki “En Basit Haliyle” kutusu yeterli.</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="mini-grid" id="simpleOracleCards">
          <div class="mini-card"><div class="label">Kahin Kesinliği</div><b id="oracleCertainty">-</b><div class="certainty"><span id="oracleCertaintyBar"></span></div></div>
          <div class="mini-card"><div class="label">Veri Kalitesi</div><b id="oracleDataQuality">-</b><div id="oracleDataWhy" class="small"></div></div>
          <div class="mini-card"><div class="label">Risk Kilidi</div><b id="oracleRiskLock">-</b><div id="oracleRiskWhy" class="small"></div></div>
          <div class="mini-card"><div class="label">Alım Planı</div><b id="oracleEntryPlan">-</b><div id="oracleEntryWhy" class="small"></div></div>
        </div>
      </div>
      <div class="panel-body">
        <div class="category-grid" id="simpleCategories"></div>
      </div>
      <div class="panel-body">
        <div class="simple-hero">
          <div class="decision-card">
            <div class="decision-title">Şu anki net karar</div>
            <div id="simpleDecision" class="decision-main">Yükleniyor...</div>
            <div id="simpleWhy" class="small" style="margin-top:10px"></div>
            <div class="simple-actions" id="simpleActionButtons"></div>
          </div>
          <div class="decision-card">
            <div class="decision-title">Sistem sağlığı</div>
            <div id="simpleHealth" class="log" style="margin-top:8px">Kontrol ediliyor...</div>
          </div>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Kahin Sinyal Haritası</h2>
          <div class="panel-body"><div id="simpleSignalMap" class="simple-list"></div></div>
        </div>
        <div class="panel">
          <h2>Bugünkü Frenler</h2>
          <div class="panel-body"><div id="simpleBrakes" class="simple-list"></div></div>
        </div>
      </div>
      <div class="panel">
        <h2>Sosyal Olaydan Doğan Tokenler</h2>
        <div class="panel-body"><div id="simpleNarratives" class="simple-list"></div></div>
      </div>
      <div class="panel">
        <h2>Trend Kayma Haritasi</h2>
        <div class="panel-body">
          <div id="trendVerdict" class="log">Trend haritasi yukleniyor...</div>
          <div class="grid" style="margin-top:12px">
            <div><div class="label">Zincir Isisi</div><div id="trendChains" class="simple-list" style="margin-top:8px"></div></div>
            <div><div class="label">Anlati Isisi</div><div id="trendNarratives" class="simple-list" style="margin-top:8px"></div></div>
          </div>
        </div>
      </div>
      <div class="grid">
        <div class="panel" id="oracle-wallet-link">
          <h2>Cuzdan Arastirma Ayrildi</h2>
          <div class="panel-body"><div class="simple-list"><div class="simple-row"><b>Smart/sniper/insider c?zdanlar</b><div class="small">Cuzdanlari ekleme, copy/alert alma ve detay inceleme artik ayri sayfada.</div><div class="actions"><a class="btn primary" href="/wallet-research">Cuzdan Arastir Sayfasina Git</a></div></div></div></div>
        </div>
        <div class="panel">
          <h2>Kaynak/Fikir Radar</h2>
          <div class="panel-body"><div id="simpleIdeaRadar" class="simple-list"></div></div>
        </div>
      </div>
      <div class="panel">
        <h2>Premium Uzay Modulleri</h2>
        <div class="panel-body"><div id="simpleFeatureLab" class="simple-list"></div></div>
      </div>
      <div class="panel">
        <h2>Dunya Disi Metrikler</h2>
        <div class="panel-body">
          <div class="log" style="margin-bottom:12px">Bu puanlar kehanet degil; sistemin topladigi sinyalleri 0-100 arasi ozetleyen kontrol lambalari. Yuksek puan = o konuda kosullar daha iyi. Dusuk puan = o konuda fren/risk var.</div>
          <div id="alienMetricLab" class="alien-grid"></div>
        </div>
      </div>
      <div class="panel">
        <h2>Risk Kapilari ve Evre</h2>
        <div class="panel-body">
          <div class="grid">
            <div>
              <div class="label">6 Kapili Risk Gate</div>
              <div id="riskGatePanel" class="simple-list" style="margin-top:8px"></div>
            </div>
            <div>
              <div class="label">Token Evresi</div>
              <div id="lifecyclePanel" class="log" style="margin-top:8px">Token analiz edilince dolar.</div>
            </div>
          </div>
          <div class="grid" style="margin-top:12px">
            <div>
              <div class="label">Jupiter Slippage</div>
              <div id="jupiterPanel" class="log" style="margin-top:8px">Route kontrolu bekliyor.</div>
            </div>
            <div>
              <div class="label">Copy Crowding</div>
              <div id="copyCrowdingPanel" class="log" style="margin-top:8px">Bizim cuzdanlarda iz aranacak.</div>
            </div>
          </div>
          <div class="grid" style="margin-top:12px">
            <div>
              <div class="label">AMM Crash Tolerance</div>
              <div id="ammShockPanel" class="log" style="margin-top:8px">Havuz sok simulasyonu bekliyor.</div>
            </div>
            <div>
              <div class="label">Ultra On-chain Katmani</div>
              <div id="ultraLayerPanel" class="log" style="margin-top:8px">Ultra katman bekliyor.</div>
            </div>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Cuzdan Kisa Yolu</h2>
        <div class="panel-body"><div class="simple-list"><div class="simple-row"><b>Cuzdanlar ayri sayfada</b><div class="small">Token analizi temiz kalsin diye cuzdan detayini buradan kaldirdim.</div><div class="actions"><a class="btn" href="/wallet-research">Cuzdan Arastir</a><a class="btn" href="/wallets">Takip Listesi</a></div></div></div></div>
      </div>
      <div class="panel-body">
        <div id="simpleGuide" class="small">
          Kısa kullanım: SCOUT = sadece paper deneme adayı, RADAR SICAK = izlemeye değer, TEYİT BEKLE = ikinci kaynak bekle, ALMA = risk freni.
        </div>
      </div>
    </section>

    <section id="oracle-token-hunt" class="panel">
      <h2><span class="section-kicker">TOKEN AVI</span>Otomatik Token Avi</h2>
      <div class="panel-body">
        <div class="search">
          <input id="manualToken" placeholder="Manuel izleme icin mint, DexScreener linki veya sembol..." />
          <input id="manualNote" placeholder="Not: neden izliyoruz?" />
          <button id="addManual">Listeye Ekle</button>
        </div>
        <div class="actions" style="margin-top:10px">
          <button id="discover" class="primary">Otomatik Tara</button>
          <button id="discoverFresh">Taze Tara</button>
          <span id="discoverStatus" class="small">Bulunan tokenlar burada puanlanacak.</span>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Skor</th><th>Kaynak</th><th>Piyasa</th><th>Karar</th><th>Aksiyon</th></tr></thead>
          <tbody id="discoverRows"></tbody>
        </table>
      </div>
    </section>

    <section id="oracle-social" class="panel">
      <h2><span class="section-kicker">SOSYAL & TREND</span>Buyuk Hesap Radar</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="socialScan" class="primary">Sosyal Radari Tara</button>
          <button id="socialFresh">Taze Sosyal Tara</button>
          <span id="socialStatus" class="small">Buyuk hesaplar X API ile otomatik taranir; key yoksa public sosyal kaynaklar izlenir.</span>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Token</th><th>Sosyal Skor</th><th>Hesaplar</th><th>Kanıt</th><th>Aksiyon</th></tr></thead>
          <tbody id="socialRows"></tbody>
        </table>
      </div>
    </section>

    <section id="oracle-opportunity" class="panel">
      <h2><span class="section-kicker">FIRSAT & RISK</span>Ultra Firsat Merkezi</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="opportunityScan" class="primary">Kahin Motorunu Yenile</button>
          <button id="opportunityFresh">Tum Kaynaklari Taze Tara</button>
          <span id="opportunityStatus" class="small">Firsatlar, alim engelleri, cuzdan doktoru ve ayar onerileri burada birlesir.</span>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Firsat Skoru</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Token</th><th>Skor</th><th>Neden</th><th>Plan</th></tr></thead>
              <tbody id="opportunityRows"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Neden Almiyoruz?</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Engel</th><th>Adet</th><th>Anlam</th></tr></thead>
              <tbody id="blockerRows"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Cuzdan Doktoru</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Cuzdan</th><th>Durum</th><th>Sonuc</th></tr></thead>
              <tbody id="walletDoctorRows"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Ayar Doktoru</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Kapi</th><th>Etki</th><th>Oneri</th></tr></thead>
              <tbody id="tuningRows"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <div id="sourceHealth" class="small"></div>
      </div>
    </section>

    <section id="oracle-wallet-hunt" class="panel">
      <h2><span class="section-kicker">CUZDAN AVI</span>Otomatik Smart Wallet Avcisi</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="hunterScan" class="primary">Cuzdan Avcisini Ac</button>
          <button id="hunterFresh">Taze Av Baslat</button>
          <span id="hunterStatus" class="small">Sniper, insider-benzeri ve smart wallet adaylari otomatik puanlanir.</span>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Cuzdan Adaylari</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Cuzdan</th><th>Skor</th><th>Kanıt</th><th>Karar</th></tr></thead>
              <tbody id="hunterWalletRows"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Convergence Cluster</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Token</th><th>Cluster</th><th>Alicilar</th><th>Karar</th></tr></thead>
              <tbody id="hunterClusterRows"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <div id="hunterRules" class="small"></div>
      </div>
    </section>

    <section id="oracle-premium" class="panel">
      <h2><span class="section-kicker">PREMIUM AKIS</span>Nansen Premium Smart Money</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="nansenScan" class="primary">Premium Akisi Ac</button>
          <button id="nansenFresh">Taze Premium Tara</button>
          <span id="nansenStatus" class="small">Nansen smart-money DEX trade akisi cüzdan ve token adaylarini ayri puanlar.</span>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Premium Cuzdan Adaylari</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Cuzdan</th><th>Skor</th><th>Kanıt</th><th>Aksiyon</th></tr></thead>
              <tbody id="nansenWalletRows"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Premium Token Adaylari</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Token</th><th>Skor</th><th>Akilli Para</th><th>Aksiyon</th></tr></thead>
              <tbody id="nansenTokenRows"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <div class="table-scroll">
          <table>
            <thead><tr><th>Son Smart Trade</th><th>Token</th><th>Tutar</th><th>Etiket</th></tr></thead>
            <tbody id="nansenTradeRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="oracle-council" class="panel">
      <h2><span class="section-kicker">KARAR KURULU</span>Alpha Council</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="councilScan" class="primary">Karar Kurulunu Aç</button>
          <button id="councilFresh">Taze Kurul</button>
          <span id="councilStatus" class="small">GitHub/Reddit/GMGN mantıklarından gelen çoklu teyit sistemi: tek sinyalle copy yok.</span>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Token Karar Masası</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Token</th><th>Karar</th><th>Oylar</th><th>Eksik / Aksiyon</th></tr></thead>
              <tbody id="councilTokenRows"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Cüzdan Ligi</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Cüzdan</th><th>Skor</th><th>Performans</th><th>Aksiyon</th></tr></thead>
              <tbody id="councilWalletRows"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Kaynaklardan Alınan Dersler</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Modül</th><th>Durum</th><th>Ne Ekledi?</th></tr></thead>
              <tbody id="councilPlaybookRows"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Araştırma Kaynakları</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Kaynak</th><th>Kullanım</th></tr></thead>
              <tbody id="councilSourceRows"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section id="oracle-lab" class="panel">
      <h2><span class="section-kicker">LABORATUVAR</span>Edge Matrix</h2>
      <div class="panel-body">
        <div class="actions">
          <button id="edgeScan" class="primary">Edge Matrix Yenile</button>
          <button id="edgeFresh">Tam Taze Edge</button>
          <span id="edgeStatus" class="small">Cuzdan, token, sosyal, cluster, kural ve bizim ozel hafiza tek karar kuyrugunda.</span>
        </div>
        <div id="edgeMetrics" class="small" style="margin-top:10px"></div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Hamle</th><th>Skor</th><th>Neden</th><th>Risk / Aksiyon</th></tr></thead>
          <tbody id="edgeRows"></tbody>
        </table>
      </div>
      <div class="panel-body">
        <div id="edgeDoctrine" class="small"></div>
      </div>
    </section>

    <section class="metrics">
      <div class="metric"><div class="label">Kahin Skoru</div><div id="overall" class="value">-</div></div>
      <div class="metric"><div class="label">Karar</div><div id="verdict" class="value">-</div></div>
      <div class="metric"><div class="label">Likidite</div><div id="liquidity" class="value">-</div></div>
      <div class="metric"><div class="label">Risk Bayragi</div><div id="riskCount" class="value">-</div></div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Karar Motoru</h2>
        <div class="panel-body">
          <div id="decision" class="log">Analiz bekleniyor.</div>
        </div>
      </div>
      <div class="panel">
        <h2>Modul Puanlari</h2>
        <div class="panel-body"><div id="bars" class="bars"></div></div>
      </div>
    </section>

    <section class="panel">
      <h2>Arastirma Sinyal Laboratuvari</h2>
      <div class="panel-body">
        <div id="researchSummary" class="log">Token analiz edilince GitHub/Pump/Rug arastirmalarindan turetilen ileri sinyaller burada gorunecek.</div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Modul</th><th>Skor</th><th>Sinyal</th><th>Risk / Kaynak Mantigi</th></tr></thead>
          <tbody id="researchRows"></tbody>
        </table>
      </div>
      <div class="panel-body">
        <div id="researchPlaybook" class="small"></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Token Profili</h2>
        <div class="panel-body" id="profile"></div>
      </div>
      <div class="panel">
        <h2>Holder / Authority Riski</h2>
        <div class="panel-body" id="risk"></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Sosyal Iz</h2>
        <div class="panel-body" id="social"></div>
      </div>
      <div class="panel">
        <h2>DeFiLlama Arka Plan</h2>
        <div class="panel-body" id="llama"></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Ultra Risk Oracle</h2>
        <div class="panel-body" id="ultraRisk"></div>
      </div>
      <div class="panel">
        <h2>Launchpad / Creator</h2>
        <div class="panel-body" id="launchpad"></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>GitHub Eslesmeleri</h2>
        <div class="table-scroll"><table><thead><tr><th>Repo</th><th>Yildiz</th><th>Guncel</th></tr></thead><tbody id="githubRows"></tbody></table></div>
      </div>
      <div class="panel">
        <h2>Reddit Konusmalari</h2>
        <div class="table-scroll"><table><thead><tr><th>Post</th><th>Sub</th><th>Etki</th></tr></thead><tbody id="redditRows"></tbody></table></div>
      </div>
    </section>

    <section class="panel">
      <h2>Kaynak Durumu</h2>
      <div class="table-scroll"><table><thead><tr><th>Kaynak</th><th>Durum</th><th>Kullanim</th></tr></thead><tbody id="sources"></tbody></table></div>
    </section>
  </main>
  <script>
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const fmtUsd = value => value === null || value === undefined || Number(value) === 0 ? '-' : '$' + Number(value).toLocaleString('en-US', { maximumFractionDigits: Number(value) < 1 ? 8 : 0 });
    const fmtPct = value => value === null || value === undefined ? '-' : Number(value).toFixed(1) + '%';
    const fmtTryish = value => value === null || value === undefined ? '-' : Number(value).toLocaleString('tr-TR', { maximumFractionDigits: 0 });
    const fmtAge = minutes => {
      if (minutes === null || minutes === undefined) return '-';
      if (minutes < 60) return Math.max(0, Math.round(minutes)) + ' dk';
      if (minutes < 1440) return (minutes / 60).toFixed(1) + ' sa';
      return (minutes / 1440).toFixed(1) + ' gun';
    };
    const short = value => value ? String(value).slice(0, 6) + '...' + String(value).slice(-4) : '-';
    const cls = verdict => verdict === 'A' ? 'good' : verdict === 'RISK' ? 'bad' : 'warn';
    const link = (url, label) => url ? '<a target="_blank" rel="noreferrer" href="' + esc(url) + '">' + esc(label || url) + '</a>' : '-';

    function renderDiscovery(data) {
      const rows = data.rows || [];
      document.getElementById('discoverStatus').textContent =
        'Bulunan ' + (data.counts?.seeds || 0) + ' adaydan ' + rows.length + ' token puanlandi. Manuel liste: ' + (data.counts?.manual || 0);
      document.getElementById('discoverRows').innerHTML = rows.map(row => {
        const source = (row.sources || []).map(item => '<span class="tag">' + esc(item) + '</span>').join('');
        const risks = (row.riskFlags || []).length ? '<div class="small bad">' + esc(row.riskFlags.join(' · ')) + '</div>' : '<div class="small good">buyuk hizli risk yok</div>';
        const notes = (row.notes || []).length ? '<div class="small">' + esc(row.notes.join(' · ')) + '</div>' : '';
        const delta = row.scoreDelta === null || row.scoreDelta === undefined ? '' : '<div class="small ' + (row.scoreDelta >= 0 ? 'good' : 'bad') + '">delta skor ' + (row.scoreDelta >= 0 ? '+' : '') + Number(row.scoreDelta).toFixed(1) + '</div>';
        const volDelta = row.volumeDeltaPct === null || row.volumeDeltaPct === undefined ? '' : ' · hacim delta ' + (row.volumeDeltaPct >= 0 ? '+' : '') + fmtPct(row.volumeDeltaPct);
        return '<tr><td><b>' + link(row.url, row.symbol || short(row.mint)) + '</b><div class="small">' + esc(row.name || '-') + '</div><div class="mono">' + esc(row.mint) + '</div>' + notes + '</td>' +
          '<td><span class="tag ' + esc(row.verdict) + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.verdict) + '</span>' + delta + '<div class="small">mom ' + fmtPct(row.change1h) + ' · 5dk ' + fmtPct(row.change5m) + volDelta + '</div></td>' +
          '<td>' + source + '<div class="small">sosyal link ' + (row.socialLinks || 0) + '</div></td>' +
          '<td>liq ' + fmtUsd(row.liquidityUsd) + '<div class="small">hacim ' + fmtUsd(row.volume24) + ' · tx5 ' + (row.tx5 || 0) + ' · tx1s ' + (row.tx1h || 0) + '</div><div class="small">FDV ' + fmtUsd(row.fdv) + ' · yas ' + fmtAge(row.ageMinutes) + '</div></td>' +
          '<td><b>' + esc(row.lane || 'Radar') + '</b><div class="small">' + esc(row.scoutPlan || row.action || '-') + '</div>' + risks + '</td>' +
          '<td><div class="actions"><button data-action="analyze" data-mint="' + esc(row.mint) + '">Derin Analiz</button><button data-action="watch" data-mint="' + esc(row.mint) + '" data-symbol="' + esc(row.symbol || '') + '">Listeye Al</button><button data-action="remove" data-mint="' + esc(row.mint) + '">Sil</button></div></td></tr>';
      }).join('') || '<tr><td colspan="6" class="empty">Henuz token taramasi yok. Otomatik Tara ile baslat.</td></tr>';
    }

    async function loadDiscovery(force = false) {
      const btn = document.getElementById(force ? 'discoverFresh' : 'discover');
      btn.disabled = true;
      document.getElementById('discoverStatus').textContent = 'Tokenlar taraniyor...';
      try {
        const res = await fetch('/api/oracle/discover' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderDiscovery(await res.json());
      } catch (error) {
        document.getElementById('discoverStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function updateWatchlist(body) {
      const res = await fetch('/api/oracle/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'liste guncellenemedi');
      await loadDiscovery(true);
      return data;
    }

    function renderSocialRadar(data) {
      const xText = data.x?.enabled ? 'X aktif' : 'X kapali: ' + (data.x?.error || 'API key yok');
      document.getElementById('socialStatus').textContent =
        xText + ' · post ' + (data.counts?.posts || 0) + ' · mention ' + (data.counts?.mentions || 0) + ' · X post ' + (data.counts?.xPosts || 0) + ' · Reddit post ' + (data.counts?.redditPosts || 0);
      document.getElementById('socialRows').innerHTML = (data.rows || []).map(row => {
        const accountHtml = (row.accounts || []).map(account =>
          '<div><span class="tag">' + esc(account.source) + '</span> ' + link(account.url, account.account) + '<div class="small">agirlik ' + Number(account.weight || 0).toFixed(1) + ' · ' + esc(account.label || '') + '</div></div>'
        ).join('');
        const postHtml = (row.posts || []).slice(0, 2).map(post =>
          '<div class="small">' + link(post.url, post.account) + ': ' + esc(post.text || '').slice(0, 150) + '</div>'
        ).join('');
        const tokenLabel = row.mint ? (row.url ? link(row.url, row.symbol || short(row.mint)) : esc(row.symbol || short(row.mint))) : '<span class="warn">$' + esc(row.symbol || '-') + '</span>';
        const tokenMeta = row.mint ? '<div class="mono">' + esc(row.mint) + '</div>' : '<div class="small warn">Sembol yakalandi; CA netlesmeden otomatik alim yok.</div>';
        return '<tr><td><b>' + tokenLabel + '</b><div class="small">' + esc(row.name || '-') + '</div>' + tokenMeta + '<div class="small">liq ' + fmtUsd(row.liquidityUsd) + ' · hacim ' + fmtUsd(row.volume24) + ' · 1s ' + fmtPct(row.change1h) + '</div></td>' +
          '<td><span class="tag ' + esc(row.verdict) + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.verdict) + '</span><div class="small">hesap ' + (row.uniqueAccounts || 0) + ' · agirlik ' + (row.sourceWeight || 0) + ' · etki ' + (row.engagement || 0) + '</div><div class="small">' + (row.directCa ? 'CA/link var' : 'sadece sembol') + ' · yas ' + fmtAge(row.ageMinutes) + '</div></td>' +
          '<td>' + accountHtml + '</td>' +
          '<td>' + postHtml + '</td>' +
          '<td>' + esc(row.action || '-') + '<div class="actions" style="margin-top:8px">' + (row.mint ? '<button data-action="analyze" data-mint="' + esc(row.mint) + '">Derin Analiz</button><button data-action="watch" data-mint="' + esc(row.mint) + '" data-symbol="' + esc(row.symbol || '') + '">Listeye Al</button>' : '') + '</div></td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">Sosyal token mention bulunmadi. X API key yoksa buyuk hesap taramasi kapali kalir.</td></tr>';
    }

    async function loadSocialRadar(force = false) {
      const btn = document.getElementById(force ? 'socialFresh' : 'socialScan');
      btn.disabled = true;
      document.getElementById('socialStatus').textContent = 'Sosyal radar taraniyor...';
      try {
        const res = await fetch('/api/oracle/social-scan' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderSocialRadar(await res.json());
      } catch (error) {
        document.getElementById('socialStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    function renderOpportunity(data) {
      document.getElementById('opportunityStatus').textContent =
        'firsat ' + (data.counts?.opportunities || 0) +
        ' · engel ' + (data.counts?.blockers || 0) +
        ' · copy ' + (data.counts?.copyWallets || 0) +
        ' · alert ' + (data.counts?.alertWallets || 0) +
        ' · acik poz ' + (data.counts?.openPositions || 0);
      document.getElementById('opportunityRows').innerHTML = (data.rows || []).map(row => {
        const token = row.mint
          ? (row.url ? link(row.url, row.symbol || short(row.mint)) : esc(row.symbol || short(row.mint)))
          : '<span class="warn">' + esc(row.symbol || '-') + '</span>';
        const why = (row.why || []).slice(0, 5).map(item => '<div class="small">' + esc(item) + '</div>').join('');
        const risk = (row.risk || []).length ? '<div class="small bad">' + esc((row.risk || []).slice(0, 3).join(' · ')) + '</div>' : '<div class="small good">buyuk risk bayragi yok</div>';
        return '<tr><td><b>' + token + '</b><div class="small">' + esc(row.name || row.source || '-') + '</div>' + (row.mint ? '<div class="mono">' + esc(row.mint) + '</div>' : '<div class="small warn">CA bekleniyor</div>') + '</td>' +
          '<td><span class="tag ' + esc(row.grade || 'WATCH') + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span><div class="small">' + esc(row.lane || '-') + '</div><div class="small">' + esc(row.source || '-') + '</div></td>' +
          '<td>' + why + risk + '</td>' +
          '<td>' + esc(row.plan || '-') + '<div class="actions" style="margin-top:8px">' + (row.mint ? '<button data-action="analyze" data-mint="' + esc(row.mint) + '">Derin Analiz</button><button data-action="watch" data-mint="' + esc(row.mint) + '" data-symbol="' + esc(row.symbol || '') + '">Listeye Al</button>' : '') + '</div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Firsat henuz yok; kaynaklar taraniyor.</td></tr>';

      document.getElementById('blockerRows').innerHTML = (data.blockers || []).map(row =>
        '<tr><td><b>' + esc(row.name) + '</b><div class="small">' + esc(row.severity || '-') + '</div></td><td>' + Number(row.count || 0) + '</td><td>' + esc(row.explain || '-') + '</td></tr>'
      ).join('') || '<tr><td colspan="3" class="empty">Son olaylarda alim engeli yok.</td></tr>';

      document.getElementById('walletDoctorRows').innerHTML = (data.walletDoctor || []).map(row => {
        const pnlCls = Number(row.realizedTry || 0) >= 0 ? 'good' : 'bad';
        return '<tr><td><b>' + esc(row.name || '-') + '</b><div class="mono">' + short(row.address || '') + '</div><div class="small">mod ' + esc(row.mode || '-') + ' · skor ' + (row.score ?? '-') + '</div></td>' +
          '<td>' + esc(row.issue || '-') + '<div class="small">' + esc(row.action || '-') + '</div></td>' +
          '<td><span class="' + pnlCls + '">' + fmtTryish(row.realizedTry || 0) + ' TL</span><div class="small">paper ' + (row.paperBuys || 0) + '/' + (row.paperSells || 0) + ' · WR ' + (row.winRate === null || row.winRate === undefined ? '-' : Number(row.winRate).toFixed(0) + '%') + '</div></td></tr>';
      }).join('') || '<tr><td colspan="3" class="empty">Cuzdan verisi yok.</td></tr>';

      document.getElementById('tuningRows').innerHTML = (data.tuning || []).map(row =>
        '<tr><td><b>' + esc(row.name || '-') + '</b><div class="small">' + esc(row.current || '-') + '</div></td><td>' + Number(row.impact || 0) + '</td><td>' + esc(row.suggestion || '-') + '</td></tr>'
      ).join('') || '<tr><td colspan="3" class="empty">Ayar onerisi yok.</td></tr>';

      document.getElementById('sourceHealth').innerHTML = (data.sourceHealth || []).map(item =>
        '<span class="tag">' + esc(item.name) + ': ' + esc(item.status) + ' / ' + esc(item.found) + '</span>'
      ).join(' ');
    }

    async function loadOpportunity(force = false) {
      const btn = document.getElementById(force ? 'opportunityFresh' : 'opportunityScan');
      btn.disabled = true;
      document.getElementById('opportunityStatus').textContent = 'Kahin motoru kaynaklari birlestiriyor...';
      try {
        const res = await fetch('/api/oracle/opportunity' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderOpportunity(await res.json());
      } catch (error) {
        document.getElementById('opportunityStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    function renderHunter(data) {
      document.getElementById('hunterStatus').textContent =
        (data.running ? 'tarama calisiyor · ' : '') +
        'cuzdan ' + (data.counts?.wallets || 0) +
        ' · cluster ' + (data.counts?.clusters || 0) +
        ' · smart ' + (data.counts?.smart || 0) +
        ' · sniper ' + (data.counts?.sniper || 0) +
        ' · insider-benzeri ' + (data.counts?.insider || 0) +
        ' · son tarama ' + (data.lastScanAt ? fmtAge(data.ageMinutes) + ' once' : 'yok') +
        (data.scanStatus?.stage ? ' ? asama ' + data.scanStatus.stage + (data.scanStatus.token ? ' / ' + data.scanStatus.token : '') : '');
      document.getElementById('hunterWalletRows').innerHTML = (data.rows || []).map(row => {
        const links = '<a target="_blank" rel="noreferrer" href="https://solscan.io/account/' + esc(row.wallet) + '">Solscan</a> · <a target="_blank" rel="noreferrer" href="https://gmgn.ai/sol/address/' + esc(row.wallet) + '">GMGN</a>';
        const cats = (row.categories || []).slice(0, 5).map(item => '<span class="tag">' + esc(item) + '</span>').join(' ');
        const risks = (row.riskFlags || []).length ? '<div class="small bad">' + esc((row.riskFlags || []).join(' · ')) + '</div>' : '<div class="small good">risk bayragi az</div>';
        const reasons = (row.reasons || []).slice(0, 5).map(item => '<div class="small">' + esc(item) + '</div>').join('');
        const addCopy = row.mode === 'copy-mini' ? '<button data-action="add-copy" data-wallet="' + esc(row.wallet) + '" data-score="' + esc(row.totalScore) + '" data-lot="' + esc(row.lotTry) + '">Mini Copy</button>' : '';
        return '<tr><td><div class="mono">' + esc(row.wallet) + '</div><div class="small">' + links + '</div>' + cats + '</td>' +
          '<td><span class="tag ' + esc(row.grade) + '">' + Number(row.totalScore || 0).toFixed(1) + ' / ' + esc(row.grade) + '</span><div class="small">A' + row.alphaScore + ' · I' + row.insiderScore + ' · S' + row.sniperScore + ' · $' + row.convictionScore + '</div><div class="small">mod ' + esc(row.mode) + ' · lot ' + (row.lotTry || 0) + ' TL</div></td>' +
          '<td>' + reasons + '<div class="small">PnL ' + Number(row.pnlSol || 0).toFixed(2) + ' SOL · WR ' + (row.winRate === null || row.winRate === undefined ? '-' : Number(row.winRate).toFixed(0) + '%') + ' · max ' + Number(row.maxX || 0).toFixed(1) + 'x</div><div class="small">proof ' + Number(row.proofScore || 0).toFixed(0) + ' ? repeat ' + Number(row.repeatabilityScore || 0).toFixed(0) + ' ? survival ' + Number(row.survivalScore || 0).toFixed(0) + ' ? copySafe ' + Number(row.copySafetyScore || 0).toFixed(0) + '</div><div class="small">spent ' + Number(row.spentSol || 0).toFixed(2) + ' SOL · max buy ' + Number(Math.max(row.maxBuySol || 0, row.maxEarlyBuySol || 0)).toFixed(2) + ' SOL · avg buy ' + Number(row.avgBuySol || 0).toFixed(2) + ' SOL</div>' + (row.funding ? '<div class="small warn">funder ' + short(row.funding.funder) + ' -> ' + Number(row.funding.receivedSol || 0).toFixed(2) + ' SOL</div>' : '') + (row.dustSniper ? '<div class="small bad">kucuk para sniper cezasi</div>' : '') + risks + '</td>' +
          '<td>' + esc(row.action || '-') + '<div class="actions" style="margin-top:8px"><button data-action="add-alert" data-wallet="' + esc(row.wallet) + '" data-score="' + esc(row.totalScore) + '" data-lot="' + esc(row.lotTry) + '">Alert Ekle</button>' + addCopy + '</div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Cuzdan adayi yok. Taze Av Baslat.</td></tr>';

      document.getElementById('hunterClusterRows').innerHTML = (data.clusters || []).map(row => {
        const buyers = (row.buyers || []).slice(0, 3).map(buyer => short(buyer.wallet) + ' A' + (buyer.alphaScore || 0) + ' I' + (buyer.insiderScore || 0) + ' S' + (buyer.sniperScore || 0)).join('<br>');
        return '<tr><td>' + link(row.url, row.symbol || short(row.mint)) + '<div class="mono">' + short(row.mint) + '</div></td>' +
          '<td><b>' + Number(row.clusterScore || 0).toFixed(1) + '</b><div class="small">smart ' + (row.smartCount || 0) + ' · pir ' + (row.strongCount || 0) + ' · risk ' + (row.riskyCount || 0) + '</div></td>' +
          '<td class="small">' + buyers + '</td><td>' + esc(row.action || '-') + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Cluster yok.</td></tr>';

      document.getElementById('hunterRules').innerHTML = (data.rules || []).map(rule =>
        '<span class="tag"><b>' + esc(rule.name) + '</b>: ' + esc(rule.rule) + '</span>'
      ).join(' ');
    }

    async function loadHunter(force = false) {
      const btn = document.getElementById(force ? 'hunterFresh' : 'hunterScan');
      btn.disabled = true;
      document.getElementById('hunterStatus').textContent = force ? 'Taze av baslatiliyor...' : 'Cuzdan avcisi yukleniyor...';
      try {
        const res = await fetch('/api/wallet-hunter/auto' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderHunter(await res.json());
      } catch (error) {
        document.getElementById('hunterStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function addHunterWallet(button, mode) {
      const wallet = button.dataset.wallet;
      if (!wallet) return;
      document.getElementById('hunterStatus').textContent = 'Cuzdan ekleniyor...';
      const score = Number(button.dataset.score || 60);
      const lot = mode === 'copy' ? Number(button.dataset.lot || 45) : 0;
      const res = await fetch('/api/control/wallet/add', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({
          address: wallet,
          mode,
          tradeTry: lot,
          class: score >= 82 ? 'AG' : score >= 70 ? 'A' : 'B',
          score,
          moonshot: true,
          note: 'Otomatik Smart Wallet Avcisi skoru ' + score + ' / ' + mode
        })
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'cuzdan eklenemedi');
      document.getElementById('hunterStatus').textContent = (data.existing ? 'guncellendi: ' : 'eklendi: ') + data.wallet.name + ' / ' + data.wallet.mode;
    }

    function renderNansenSmart(data) {
      const status = document.getElementById('nansenStatus');
      if (!data.ok) {
        status.textContent = data.enabled ? 'Nansen hata: ' + (data.error || 'bilinmeyen hata') : 'Nansen kapali: API key yok.';
        document.getElementById('nansenWalletRows').innerHTML = '<tr><td colspan="4" class="empty">Premium veri alinamadi.</td></tr>';
        document.getElementById('nansenTokenRows').innerHTML = '<tr><td colspan="4" class="empty">Premium veri alinamadi.</td></tr>';
        document.getElementById('nansenTradeRows').innerHTML = '<tr><td colspan="4" class="empty">Premium veri alinamadi.</td></tr>';
        return;
      }
      status.textContent = 'Nansen premium: trade ' + (data.counts?.trades || 0) + ' · cüzdan ' + (data.counts?.wallets || 0) + ' · token ' + (data.counts?.tokens || 0);
      document.getElementById('nansenWalletRows').innerHTML = (data.wallets || []).map(row => {
        const labels = (row.labels || []).slice(0, 4).map(item => '<span class="tag">' + esc(item) + '</span>').join('');
        return '<tr><td>' + link(row.url, short(row.address)) + '<div class="mono">' + esc(row.address) + '</div>' + labels + '</td>' +
          '<td><span class="tag ' + esc(row.grade) + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span><div class="small">mod ' + esc(row.mode || '-') + '</div></td>' +
          '<td><div class="small">alim ' + (row.buyCount || 0) + ' · token ' + (row.uniqueTokens || 0) + ' · hacim ' + fmtUsd(row.amountUsd) + '</div><div class="small">ornek: ' + esc((row.sampleTokens || []).join(', ') || '-') + '</div></td>' +
          '<td><div class="actions"><button data-action="nansen-alert" data-wallet="' + esc(row.address) + '" data-score="' + esc(row.score) + '">Alert</button><button data-action="nansen-copy" data-wallet="' + esc(row.address) + '" data-score="' + esc(row.score) + '">Mini Copy</button></div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Premium cüzdan adayi yok.</td></tr>';

      document.getElementById('nansenTokenRows').innerHTML = (data.tokens || []).map(row => {
        const labels = (row.labels || []).slice(0, 4).map(item => '<span class="tag">' + esc(item) + '</span>').join('');
        return '<tr><td>' + link(row.url, row.symbol || short(row.mint)) + '<div class="mono">' + esc(row.mint) + '</div>' + labels + '</td>' +
          '<td><span class="tag ' + esc(row.grade) + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span><div class="small">mod ' + esc(row.mode || '-') + '</div></td>' +
          '<td><div class="small">smart alici ' + (row.buyers || 0) + ' · alim ' + (row.buyCount || 0) + '</div><div class="small">hacim ' + fmtUsd(row.amountUsd) + ' · max ' + fmtUsd(row.maxTradeUsd) + '</div></td>' +
          '<td><div class="actions"><button data-action="nansen-token" data-mint="' + esc(row.mint) + '">Derin Analiz</button><button data-action="nansen-watch" data-mint="' + esc(row.mint) + '">Listeye Al</button></div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Premium token adayi yok.</td></tr>';

      document.getElementById('nansenTradeRows').innerHTML = (data.trades || []).slice(0, 15).map(row =>
        '<tr><td>' + link('https://gmgn.ai/sol/address/' + row.trader, short(row.trader)) + '<div class="small">' + esc(row.at ? row.at.slice(11, 19) : '-') + '</div></td>' +
        '<td>' + esc(row.boughtSymbol || short(row.boughtMint)) + '<div class="mono">' + esc(row.boughtMint) + '</div></td>' +
        '<td>' + fmtUsd(row.amountUsd) + '<div class="small">' + Number(row.amountSol || 0).toFixed(2) + ' SOL</div></td>' +
        '<td>' + esc((row.labels || []).slice(0, 3).join(', ') || '-') + '</td></tr>'
      ).join('') || '<tr><td colspan="4" class="empty">Smart trade yok.</td></tr>';
    }

    async function loadNansenSmart(force = false) {
      const btn = document.getElementById(force ? 'nansenFresh' : 'nansenScan');
      btn.disabled = true;
      document.getElementById('nansenStatus').textContent = 'Nansen smart money akisi okunuyor...';
      try {
        const res = await fetch('/api/premium/nansen-smart' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderNansenSmart(await res.json());
      } catch (error) {
        document.getElementById('nansenStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function addNansenWallet(button, mode) {
      const wallet = button.dataset.wallet;
      const score = Number(button.dataset.score || 70);
      const lot = mode === 'copy' ? Math.max(40, Math.min(90, Math.round(score))) : 0;
      document.getElementById('nansenStatus').textContent = 'Premium cüzdan ekleniyor...';
      const res = await fetch('/api/control/wallet/add', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({
          address: wallet,
          mode,
          tradeTry: lot,
          prefix: 'Nansen',
          class: score >= 84 ? 'AG' : 'A',
          score,
          moonshot: true,
          note: 'Nansen Smart Money DEX Trades premium akışından eklendi; once paper/alert dogrulama.'
        })
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'cüzdan eklenemedi');
      document.getElementById('nansenStatus').textContent = (data.existing ? 'guncellendi: ' : 'eklendi: ') + data.wallet.name + ' / ' + data.wallet.mode;
    }

    function renderAlphaCouncil(data) {
      const health = data.sourceHealth || {};
      document.getElementById('councilStatus').textContent =
        'karar ' + (data.tokenDecisions?.length || 0) +
        ' · cüzdan ligi ' + (data.walletLeague?.length || 0) +
        ' · sosyal ' + (health.socialMentions || 0) +
        ' · premium ' + (health.nansenOk ? 'aktif' : 'bekliyor');
      document.getElementById('councilTokenRows').innerHTML = (data.tokenDecisions || []).map(row => {
        const votes = (row.votes || []).map(vote =>
          '<div class="small ' + (vote.ok ? 'good' : (vote.weight < 0 ? 'bad' : 'warn')) + '">' +
          esc(vote.name) + ': ' + esc(vote.note || '-') + '</div>'
        ).join('');
        const missing = (row.missing || []).length ? '<div class="small warn">eksik: ' + esc(row.missing.join(', ')) + '</div>' : '<div class="small good">ana teyitler tamam</div>';
        const sources = (row.sources || []).map(item => '<span class="tag">' + esc(item) + '</span>').join('');
        return '<tr><td>' + link(row.url, row.symbol || short(row.mint)) + '<div class="mono">' + esc(row.mint) + '</div>' + sources + '</td>' +
          '<td><span class="tag ' + esc(row.grade) + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span><div><b>' + esc(row.decision || '-') + '</b></div></td>' +
          '<td>' + votes + '</td>' +
          '<td>' + esc(row.action || '-') + missing + '<div class="actions" style="margin-top:8px"><button data-action="council-token" data-mint="' + esc(row.mint) + '">Analiz</button><button data-action="council-watch" data-mint="' + esc(row.mint) + '">Listeye Al</button></div></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Karar adayı yok.</td></tr>';

      document.getElementById('councilWalletRows').innerHTML = (data.walletLeague || []).map(row =>
        '<tr><td>' + link('https://gmgn.ai/sol/address/' + row.address, row.name) + '<div class="mono">' + esc(row.address || '-') + '</div><div class="small">mod ' + esc(row.mode || '-') + ' · lot ' + (row.lot || 0) + ' TL</div></td>' +
        '<td><span class="tag ' + esc(row.grade) + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span></td>' +
        '<td>' + (row.reason || []).map(item => '<div class="small">' + esc(item) + '</div>').join('') + '</td>' +
        '<td>' + esc(row.action || '-') + '</td></tr>'
      ).join('') || '<tr><td colspan="4" class="empty">Cüzdan ligi yok.</td></tr>';

      document.getElementById('councilPlaybookRows').innerHTML = (data.playbook || []).map(row =>
        '<tr><td><b>' + esc(row.name) + '</b><div class="small">' + esc(row.panel || '-') + '</div></td><td><span class="tag">' + esc(row.status) + '</span></td><td>' + esc(row.idea) + '</td></tr>'
      ).join('');

      document.getElementById('councilSourceRows').innerHTML = (data.sources || []).map(row =>
        '<tr><td>' + link(row.url, row.name) + '</td><td>' + esc(row.use) + '</td></tr>'
      ).join('');
    }

    async function loadAlphaCouncil(force = false) {
      const btn = document.getElementById(force ? 'councilFresh' : 'councilScan');
      btn.disabled = true;
      document.getElementById('councilStatus').textContent = 'Kaynak fikirleri ve canlı sinyaller birleştiriliyor...';
      try {
        const res = await fetch('/api/oracle/alpha-council' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderAlphaCouncil(await res.json());
      } catch (error) {
        document.getElementById('councilStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    function renderSimpleDashboard(council, edge, state) {
      const top = (council.tokenDecisions || [])[0] || null;
      const copyWallets = (state.config?.wallets || []).filter(wallet => wallet.mode === 'copy');
      const botText = state.bot?.running ? 'Bot çalışıyor' : 'Bot durdu';
      const nansenText = council.sourceHealth?.nansenOk ? 'Nansen aktif' : 'Nansen bekliyor/kredi yok';
      document.getElementById('simpleStatus').textContent =
        botText + ' · copy cüzdan ' + copyWallets.length + ' · karar adayı ' + ((council.tokenDecisions || []).length);

      if (!top) {
        document.getElementById('simpleDecision').textContent = 'Net aday yok';
        document.getElementById('simpleWhy').textContent = 'Şu an çoklu teyit alan token çıkmadı.';
        document.getElementById('simpleActionButtons').innerHTML = '';
      } else {
        document.getElementById('simpleDecision').innerHTML =
          '<span class="' + (top.decision === 'SCOUT' ? 'good' : top.decision === 'ALMA' ? 'bad' : 'warn') + '">' +
          esc(top.decision) + '</span> · ' + esc(top.symbol || short(top.mint));
        const goodVotes = (top.votes || []).filter(vote => vote.ok).map(vote => vote.name);
        const missing = (top.missing || []).join(', ') || 'kritik eksik yok';
        document.getElementById('simpleWhy').textContent =
          'Skor ' + Number(top.score || 0).toFixed(1) + '. Tamam: ' + (goodVotes.join(', ') || '-') + '. Eksik: ' + missing + '. ' + (top.action || '');
        document.getElementById('simpleActionButtons').innerHTML =
          '<button data-action="simple-analyze" data-mint="' + esc(top.mint) + '">Bu Tokeni Analiz Et</button>' +
          '<button data-action="simple-watch" data-mint="' + esc(top.mint) + '">Listeye Al</button>';
      }

      const blockers = (edge.rows || []).filter(row => row.kind === 'rule-friction' || row.kind === 'negative-wallet').slice(0, 3);
      document.getElementById('simpleHealth').textContent =
        botText + '\\n' +
        nansenText + (council.sourceHealth?.nansenError ? ' (' + council.sourceHealth.nansenError.replace(/\\{.*$/, '').trim() + ')' : '') + '\\n' +
        'Aktif copy: ' + copyWallets.map(wallet => wallet.name + ':' + (wallet.tradeTry || 0) + 'TL').join(', ') + '\\n' +
        'Öne çıkan engel: ' + (blockers[0]?.title || 'yok');

      const simpleTokensBox = document.getElementById('simpleTokens');
      if (simpleTokensBox) simpleTokensBox.innerHTML = (council.tokenDecisions || []).slice(0, 5).map(row => {
        const missing = (row.missing || []).length ? 'Eksik: ' + row.missing.join(', ') : 'Ana teyitler tamam';
        return '<div class="simple-row"><b>' + link(row.url, row.symbol || short(row.mint)) + '</b> ' +
          '<span class="tag ' + esc(row.grade) + '">' + Number(row.score || 0).toFixed(1) + '</span>' +
          '<div class="small"><b>' + esc(row.decision || '-') + '</b> · ' + esc(row.action || '-') + '</div>' +
          '<div class="small">' + esc(missing) + '</div></div>';
      }).join('') || '<div class="empty">Token adayı yok.</div>';

      const simpleWalletBox = document.getElementById('simpleWallets');
      if (simpleWalletBox) simpleWalletBox.innerHTML = '<div class="simple-row"><b>Cuzdanlar ayri sayfada</b><div class="small">Cuzdan ligini Token Arastir ekranindan kaldirdim.</div><div class="actions"><a class="btn" href="/wallet-research">Cuzdan Arastir</a><a class="btn" href="/wallets">Takip Listesi</a></div></div>';
    }

    function renderSimpleDashboardV2(council, edge, state, social) {
      renderSimpleDashboard(council, edge, state);
      const top = (council.tokenDecisions || [])[0] || null;
      const botText = state.bot?.running ? 'Bot calisiyor' : 'Bot durdu';
      if (document.getElementById('childDecision')) {
        document.getElementById('childDecision').innerHTML = top
          ? '<span class="' + (top.decision === 'SCOUT' ? 'good' : top.decision === 'ALMA' ? 'bad' : 'warn') + '">' + esc(top.decision || '-') + '</span><div class="small">' + esc(top.symbol || short(top.mint)) + ' / skor ' + Number(top.score || 0).toFixed(1) + '</div>'
          : '<span class="warn">TEYIT BEKLE</span>';
      }
      if (document.getElementById('childWhy')) {
        document.getElementById('childWhy').textContent = top
          ? (top.action || 'Token detay analizi icin acilabilir.')
          : 'Su an coklu teyit alan net token yok; sistem izlemeye devam ediyor.';
      }
      if (document.getElementById('childActions')) {
        document.getElementById('childActions').innerHTML = top
          ? '<button data-action="simple-analyze" data-mint="' + esc(top.mint) + '">Analiz Et</button><button data-action="simple-watch" data-mint="' + esc(top.mint) + '">Listeye Al</button>'
          : '';
      }
      if (document.getElementById('childTokens')) {
        document.getElementById('childTokens').innerHTML = (council.tokenDecisions || []).slice(0, 5).map(row =>
          '<div class="kid-item"><b>' + esc(row.symbol || short(row.mint)) + '</b><span class="tag ' + esc(row.grade || '') + '">' + Number(row.score || 0).toFixed(1) + '</span><div class="small">' + esc(row.decision || '-') + ' - ' + esc(row.action || '-') + '</div><div class="actions"><button data-action="simple-analyze" data-mint="' + esc(row.mint) + '">Analiz</button><button data-action="simple-watch" data-mint="' + esc(row.mint) + '">Liste</button></div></div>'
        ).join('') || '<div class="kid-item">Token adayi yok.</div>';
      }
      if (document.getElementById('childWallets')) {
        document.getElementById('childWallets').innerHTML = '<div class="kid-item"><b>Cuzdanlar ayri sayfada</b><div class="small">Token arastirma ekrani artik sadece token kararina odakli. Smart/sniper/insider cuzdan bulma ve ekleme Wallet Research tarafinda.</div><div class="actions"><a class="btn primary" href="/wallet-research">Cuzdan Arastir</a><a class="btn" href="/wallets">Takip Listesi</a></div></div>';
      }
      if (document.getElementById('childNextSteps')) {
        document.getElementById('childNextSteps').innerHTML = '<div>1. Token kararini oku.</div><div>2. SCOUT ise analiz et.</div><div>3. Cuzdan icin Wallet Research sayfasina gec.</div>';
      }
      if (document.getElementById('childSignals')) {
        document.getElementById('childSignals').innerHTML = '<div class="kid-item">' + esc(botText) + '</div><div class="kid-item">Sosyal sinyal: ' + ((social.rows || []).length || 0) + '</div><div class="kid-item">Karar adayi: ' + ((council.tokenDecisions || []).length || 0) + '</div>';
      }
    }

    async function loadSimpleDashboard(force = false) {
      document.getElementById('simpleStatus').textContent = 'Basit ozet hazirlaniyor...';
      try {
        const timeoutFetch = (url, fallback, ms = 14000) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          return fetch(url, { cache:'no-store', signal: controller.signal })
            .then(res => res.ok ? res.json() : fallback)
            .catch(() => fallback)
            .finally(() => clearTimeout(timer));
        };
        const [council, edge, state, social] = await Promise.all([
          timeoutFetch('/api/oracle/alpha-council' + (force ? '?force=1' : ''), { tokenDecisions: [], walletLeague: [], sourceHealth: {}, sources: [] }),
          timeoutFetch('/api/oracle/super-alpha' + (force ? '?force=1' : ''), { rows: [], trendMap: {}, metrics: {}, sourceHealth: {} }),
          timeoutFetch('/api/state?ts=' + Date.now(), { config: { wallets: [] }, bot: { running: false } }, 9000),
          timeoutFetch('/api/oracle/social-scan' + (force ? '?force=1' : ''), { narratives: [], rows: [], counts: {} })
        ]);
        renderSimpleDashboardV2(council, edge, state, social, { rows: [] });
      } catch (error) {
        document.getElementById('simpleStatus').textContent = 'Hata: ' + error.message;
      }
    }

    async function addSimpleWallet(button, mode) {
      const wallet = button.dataset.wallet;
      if (!wallet) return;
      const score = Number(button.dataset.score || 60);
      const lot = mode === 'copy' ? Number(button.dataset.lot || 40) : 0;
      document.getElementById('simpleStatus').textContent = 'Cüzdan ekleniyor...';
      const res = await fetch('/api/control/wallet/add', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({
          address: wallet,
          mode,
          tradeTry: lot,
          class: score >= 82 ? 'AG' : score >= 70 ? 'A' : 'B',
          score,
          moonshot: true,
          note: 'Basit panel Cüzdan Bul ve Ekle akışından eklendi; önce paper doğrulama.'
        })
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'cüzdan eklenemedi');
      document.getElementById('simpleStatus').textContent = (data.existing ? 'güncellendi: ' : 'eklendi: ') + data.wallet.name + ' / ' + data.wallet.mode;
      await loadSimpleDashboard(false);
    }

    function renderWalletDetail(data) {
      if (!data.ok) {
        document.getElementById('simpleWalletDetail').textContent = data.error || 'Cüzdan detayı alınamadı.';
        return;
      }
      const w = data.wallet || {};
      const s = data.stats || {};
      const balance = data.balance ? Number(data.balance.sol || 0).toFixed(4) + ' SOL / ' + Number(data.balance.try || 0).toFixed(0) + ' TL' : 'bakiye alınamadı';
      const cielo = data.cielo || {};
      const cieloText = cielo.enabled ? (cielo.ok ? ('Cielo PnL: $' + Number(cielo.realizedUsd || 0).toFixed(0) + ' / WR ' + (cielo.winRate ?? '-') + '% / token ' + (cielo.tokenCount || 0)) : ('Cielo: ' + (cielo.error || 'veri yok'))) : 'Cielo: key yok';
      const related = (data.related || []).slice(0, 8).map(item => '- ' + item.type + ': ' + item.address).join('\\n') || '- ilişki yok';
      const open = (data.openPositions || []).slice(0, 6).map(pos => '- ' + (pos.symbol || '-') + ' ' + (pos.investedTry || 0) + ' TL / ' + (pos.walletStillHolding === false ? 'cüzdan çıkmış' : pos.walletStillHolding === true ? 'cüzdan tutuyor' : 'holding bilinmiyor')).join('\\n') || '- açık pozisyon yok';
      const trades = (data.trades || []).slice(0, 18).map(t => {
        const pnl = t.paper?.pnlTry !== undefined ? ' pnl ' + Number(t.paper.pnlTry || 0).toFixed(0) + ' TL' : t.paper?.skipped ? ' skip ' + t.paper.skipped : '';
        const owner = t.ownerAddress && t.ownerAddress !== w.address ? ' owner ' + short(t.ownerAddress) : '';
        return '- ' + String(t.time || '').slice(11, 19) + ' ' + (t.type || '-') + ' ' + (t.symbol || '-') + owner + pnl;
      }).join('\\n') || '- işlem yok';
      document.getElementById('simpleWalletDetail').innerHTML =
        '<b>' + esc(w.name || '-') + '</b> ' + '<span class="tag">' + esc(w.mode || '-') + '</span>' +
        '<div class="mono">' + esc(w.address || '-') + '</div>' +
        '<div class="actions" style="margin:8px 0">' +
        link(w.gmgn, 'GMGN') + ' ' + link(w.solscan, 'Solscan') + ' ' + link(w.cielo, 'Cielo') + ' ' + link(w.nansen, 'Nansen') +
        '</div>' +
        '<pre style="white-space:pre-wrap;margin:0;color:var(--muted);font-family:ui-monospace, SFMono-Regular, Consolas, monospace">' +
        esc('Özet\\n' +
          'WR: ' + (s.winRate === null || s.winRate === undefined ? '-' : s.winRate + '%') + '\\n' +
          'PnL: ' + Number(s.realizedTry || 0).toFixed(0) + ' TL\\n' +
          'Buy/Sell: ' + (s.buys || 0) + '/' + (s.sells || 0) + '\\n' +
          'Paper kapanış: ' + (s.paperSells || 0) + '\\n' +
          'Bakiye: ' + balance + '\\n' +
          cieloText + '\\n' +
          'Son sinyal: ' + (s.lastSignalAt || '-') + '\\n\\n' +
          'Açık pozisyonlar\\n' + open + '\\n\\n' +
          'İlişkili cüzdanlar\\n' + related + '\\n\\n' +
          'Son işlemler\\n' + trades) +
        '</pre>';
    }

    async function loadWalletDetail(wallet) {
      if (!wallet) return;
      document.getElementById('simpleWalletDetail').textContent = 'Cüzdan detayı yükleniyor...';
      try {
        const res = await fetch('/api/wallet/detail?wallet=' + encodeURIComponent(wallet), { cache:'no-store' });
        renderWalletDetail(await res.json());
      } catch (error) {
        document.getElementById('simpleWalletDetail').textContent = 'Hata: ' + error.message;
      }
    }

    function renderEdge(data) {
      const m = data.metrics || {};
      document.getElementById('edgeStatus').textContent =
        'edge ' + (m.edgeRows || 0) +
        ' · scout ' + (m.scoutReady || 0) +
        ' · risk ' + (m.hardRisks || 0) +
        ' · wallet ' + (m.walletCandidates || 0) +
        ' · token ' + (m.tokenOpportunities || 0) +
        ' · premium ' + (m.premiumTrades || 0) +
        ' · sosyal ' + (m.socialMentions || 0);
      document.getElementById('edgeMetrics').innerHTML = [
        'negatif cuzdan ' + (m.negativeWallets || 0),
        'Nansen ' + (data.sourceHealth?.nansenOk ? 'aktif' : (data.sourceHealth?.nansenEnabled ? 'hata' : 'kapali')),
        'X ' + (data.sourceHealth?.xEnabled ? 'aktif' : 'kapali'),
        'hunter ' + (data.sourceHealth?.hunterRunning ? 'tariyor' : 'hazir'),
        'blocker ' + (data.sourceHealth?.blockers || 0)
      ].map(item => '<span class="tag">' + esc(item) + '</span>').join(' ');
      document.getElementById('edgeRows').innerHTML = (data.rows || []).map(row => {
        const titleLink = row.url ? link(row.url, row.title) : esc(row.title || '-');
        const reasons = (row.reasons || []).map(item => '<div class="small">' + esc(item) + '</div>').join('');
        const risks = (row.risks || []).length ? '<div class="small bad">' + esc((row.risks || []).join(' · ')) + '</div>' : '<div class="small good">sert risk yok</div>';
        const actions = row.address
          ? '<div class="actions" style="margin-top:8px"><button data-action="edge-alert" data-wallet="' + esc(row.address) + '" data-score="' + esc(row.score) + '">Alert</button>' + (row.mode === 'scout-copy' ? '<button data-action="edge-copy" data-wallet="' + esc(row.address) + '" data-score="' + esc(row.score) + '">Scout Copy</button>' : '') + '</div>'
          : row.mint
            ? '<div class="actions" style="margin-top:8px"><button data-action="edge-token" data-mint="' + esc(row.mint) + '">Analiz</button><button data-action="edge-watch" data-mint="' + esc(row.mint) + '">Listeye Al</button></div>'
            : '';
        return '<tr><td><b>' + titleLink + '</b><div class="small">' + esc(row.kind || '-') + ' · ' + esc(row.mode || '-') + '</div></td>' +
          '<td><span class="tag ' + esc(row.grade || '-') + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span></td>' +
          '<td>' + reasons + '</td><td>' + esc(row.action || '-') + risks + actions + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Edge henuz yok.</td></tr>';
      document.getElementById('edgeDoctrine').innerHTML = (data.doctrine || []).map(item => '<span class="tag">' + esc(item) + '</span>').join(' ');
    }

    async function loadEdge(force = false) {
      const btn = document.getElementById(force ? 'edgeFresh' : 'edgeScan');
      btn.disabled = true;
      document.getElementById('edgeStatus').textContent = 'Edge Matrix kaynaklari birlestiriyor...';
      try {
        const res = await fetch('/api/oracle/super-alpha' + (force ? '?force=1' : ''), { cache:'no-store' });
        renderEdge(await res.json());
      } catch (error) {
        document.getElementById('edgeStatus').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    function renderBars(modules) {
      const labels = {
        liquidity: 'Likidite',
        activity: 'Aktivite',
        momentum: 'Momentum',
        buyPressure: 'Buy baskisi',
        social: 'Sosyal',
        dev: 'Dev/GitHub',
        trust: 'Ultra guven',
        age: 'Pair yasi',
        riskPenalty: 'Risk cezasi'
      };
      document.getElementById('bars').innerHTML = Object.entries(labels).map(([key, labelText]) => {
        const value = Number(modules?.[key] || 0);
        const barValue = key === 'riskPenalty' ? Math.min(100, value * 2) : value;
        const color = key === 'riskPenalty' ? 'linear-gradient(90deg, var(--warn), var(--bad))' : 'linear-gradient(90deg, var(--blue), var(--good))';
        return '<div class="bar"><div>' + esc(labelText) + '</div><div class="track"><div class="fill" style="width:' + Math.max(0, Math.min(100, barValue)) + '%;background:' + color + '"></div></div><div class="mono">' + value.toFixed(1) + '</div></div>';
      }).join('');
    }

    function renderResearch(research) {
      if (!research) {
        document.getElementById('researchSummary').textContent = 'Arastirma sinyali yok.';
        document.getElementById('researchRows').innerHTML = '<tr><td colspan="4" class="empty">Token analiz edilmedi.</td></tr>';
        document.getElementById('researchPlaybook').innerHTML = '';
        return;
      }
      document.getElementById('researchSummary').textContent =
        'Arastirma Alpha: ' + Number(research.alphaScore || 0).toFixed(1) + ' / ' + (research.grade || '-') + '\\n' +
        'Aksiyon: ' + (research.action || '-') + '\\n' +
        'Kill switch: ' + ((research.killSwitches || []).length ? (research.killSwitches || []).join(', ') : 'yok');
      document.getElementById('researchRows').innerHTML = (research.signals || []).map(row =>
        '<tr><td><b>' + esc(row.name || '-') + '</b><div class="small">' + esc(row.source || '-') + '</div></td>' +
        '<td><span class="tag ' + esc(row.grade || '-') + '">' + Number(row.score || 0).toFixed(1) + ' / ' + esc(row.grade || '-') + '</span></td>' +
        '<td>' + esc(row.signal || '-') + '</td>' +
        '<td>' + esc(row.danger || '-') + '</td></tr>'
      ).join('') || '<tr><td colspan="4" class="empty">Sinyal yok.</td></tr>';
      document.getElementById('researchPlaybook').innerHTML = (research.playbook || []).map(item =>
        '<span class="tag">' + esc(item) + '</span>'
      ).join(' ');
    }

    function renderRiskSystems(data) {
      const gate = data.riskGate || null;
      const lifecycle = data.lifecycle || null;
      const jupiter = data.jupiter || null;
      const crowd = data.copyCrowding || null;
      const birdeye = data.birdeye || null;
      const amm = data.ammShock || null;
      const ultra = data.ultraLayer || null;
      if (document.getElementById('riskGatePanel')) {
        document.getElementById('riskGatePanel').innerHTML = gate ? (
          '<div class="simple-row"><b>' + esc(gate.grade || '-') + ' / ' + Number(gate.score || 0).toFixed(1) + '</b><span>' + esc(gate.verdict || '-') + '</span></div>' +
          (gate.gates || []).map(item => '<div class="simple-row"><b class="' + (item.status === 'PASS' ? 'good' : item.status === 'FAIL' ? 'bad' : 'warn') + '">' + esc(item.status) + '</b><span>' + esc(item.name) + ': ' + esc(item.detail || '-') + '</span></div>').join('') +
          '<div class="small" style="margin-top:8px">' + esc(gate.action || '-') + '</div>'
        ) : '<div class="empty">Risk kapisi yok.</div>';
      }
      if (document.getElementById('lifecyclePanel')) {
        document.getElementById('lifecyclePanel').textContent = lifecycle ? (
          'Evre: ' + (lifecycle.stage || '-') + '\\n' +
          'Guven: ' + Number(lifecycle.confidence || 0).toFixed(1) + '/100\\n' +
          'Aksiyon: ' + (lifecycle.action || '-') + '\\n\\n' +
          'Nedenler:\\n- ' + (lifecycle.reasons || []).join('\\n- ')
        ) : 'Token evresi yok.';
      }
      if (document.getElementById('jupiterPanel')) {
        document.getElementById('jupiterPanel').textContent = jupiter ? (
          'Durum: ' + (jupiter.verdict || '-') + '\\n' +
          'Route: ' + (jupiter.routeCount ?? '-') + '\\n' +
          'Price impact: ' + (jupiter.priceImpactPct === null || jupiter.priceImpactPct === undefined ? '-' : Number(jupiter.priceImpactPct).toFixed(2) + '%') + '\\n' +
          'Aksiyon: ' + (jupiter.action || '-')
        ) : 'Jupiter verisi yok.';
      }
      if (document.getElementById('copyCrowdingPanel')) {
        document.getElementById('copyCrowdingPanel').textContent = crowd ? (
          'Durum: ' + (crowd.label || '-') + '\\n' +
          'Skor: ' + Number(crowd.score || 0).toFixed(1) + '/100\\n' +
          'Buyer/Seller: ' + (crowd.buyers || 0) + '/' + (crowd.sellers || 0) + '\\n' +
          'Olay: ' + (crowd.events || 0) + '\\n' +
          'Aksiyon: ' + (crowd.action || '-') + '\\n\\n' +
          'Birdeye ilk alicilar: ' + (birdeye?.enabled ? (birdeye.ok ? ((birdeye.firstBuyers || []).length + ' cuzdan / ' + (birdeye.tradeCount || 0) + ' swap') : ('aktif ama veri yok: ' + (birdeye.error || '-'))) : 'key/modul yok') + '\\n' +
          ((birdeye?.firstBuyers || []).slice(0, 5).map(item => '- ' + short(item.wallet) + ' buy ' + (item.buys || 0) + ' / sell ' + (item.sells || 0)).join('\\n') || '')
        ) : 'Copy crowding verisi yok.';
      }
      if (document.getElementById('ammShockPanel')) {
        document.getElementById('ammShockPanel').textContent = amm ? (
          'Durum: ' + (amm.verdict || '-') + '\\n' +
          'Crash index: ' + Number(amm.crashIndex || 0).toFixed(1) + '/100\\n' +
          'Simule holder satışı: top holder grubunun %' + Number(amm.assumedSellPct || 0).toFixed(0) + '\\n' +
          'Etkilenen arz: %' + Number(amm.simulatedHolderPct || 0).toFixed(2) + '\\n' +
          'Havuzdan çekilebilecek: $' + Number(amm.estimatedDrainUsd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' / %' + Number(amm.drainPct || 0).toFixed(1) + '\\n' +
          'Fiyat etkisi: ' + (amm.priceImpactPct === null || amm.priceImpactPct === undefined ? '-' : '%' + Number(amm.priceImpactPct).toFixed(1)) + '\\n' +
          'Aksiyon: ' + (amm.action || '-')
        ) : 'AMM sok simulasyonu yok.';
      }
      if (document.getElementById('ultraLayerPanel')) {
        document.getElementById('ultraLayerPanel').textContent = ultra ? (
          'Durum: ' + (ultra.verdict || '-') + '\\n' +
          'Skor: ' + Number(ultra.score || 0).toFixed(1) + '/100\\n' +
          'Aksiyon: ' + (ultra.action || '-') + '\\n\\n' +
          'Kapilar:\\n- ' + (ultra.gates || []).map(item => item.name + ': ' + item.status + ' (' + item.detail + ')').join('\\n- ') + '\\n\\n' +
          'Notlar:\\n- ' + (ultra.notes || []).map(item => item.name + ' / ' + item.status + ': ' + item.note).join('\\n- ')
        ) : 'Ultra katman verisi yok.';
      }
    }

    function render(data) {
      if (!data.ok) {
        document.getElementById('status').textContent = data.error || 'Bulunamadi.';
        document.getElementById('decision').textContent = data.error || 'Token bulunamadi.';
        renderResearch(null);
        renderRiskSystems({});
        document.getElementById('sources').innerHTML = (data.sources || []).map(source => '<tr><td>' + link(source.link, source.name) + '</td><td><span class="tag">' + esc(source.status) + '</span></td><td>' + esc(source.use) + '</td></tr>').join('');
        return;
      }
      const token = data.token || {};
      const market = data.market || {};
      const scores = data.scores || {};
      const modules = scores.modules || {};
      const riskFlags = scores.riskFlags || [];
      document.getElementById('status').textContent = esc(token.symbol) + ' analiz edildi. Kaynak: ' + esc(data.resolvedBy || '-');
      document.getElementById('overall').innerHTML = '<span class="' + cls(scores.verdict) + '">' + Number(scores.overall || 0).toFixed(1) + '</span>';
      document.getElementById('verdict').innerHTML = '<span class="tag ' + esc(scores.verdict) + '">' + esc(scores.verdict || '-') + '</span>';
      document.getElementById('liquidity').textContent = fmtUsd(market.liquidityUsd);
      document.getElementById('riskCount').innerHTML = '<span class="' + (riskFlags.length ? 'bad' : 'good') + '">' + riskFlags.length + '</span>';
      document.getElementById('decision').textContent =
        'Aksiyon: ' + (scores.action || '-') + '\\n\\n' +
        'Nedenler:\\n- ' + (scores.reasons || []).join('\\n- ') + '\\n\\n' +
        'Riskler:\\n- ' + (riskFlags.length ? riskFlags.join('\\n- ') : 'belirgin buyuk risk bayragi yok') + '\\n\\n' +
        'Not: Bu ekran emir vermez; sinyal kalitesini ve riskleri gormek icindir.';
      renderBars(modules);
      renderResearch(data.research);
      renderRiskSystems(data);

      const img = token.imageUrl ? '<img class="token-img" src="' + esc(token.imageUrl) + '" alt="" />' : '<div class="token-img"></div>';
      document.getElementById('profile').innerHTML =
        '<div class="token-head">' + img + '<div><h3 style="margin:0">' + esc(token.symbol) + ' <span class="small">' + esc(token.name) + '</span></h3>' +
        '<div class="mono">' + esc(token.mint) + '</div><div class="small">' + link(token.url, 'DexScreener') + ' · pair ' + short(token.pairAddress) + '</div></div></div>' +
        '<div style="height:12px"></div>' +
        '<table><tbody>' +
        '<tr><td>Fiyat</td><td>' + fmtUsd(market.priceUsd) + '</td></tr>' +
        '<tr><td>FDV / Mcap</td><td>' + fmtUsd(market.fdv) + ' / ' + fmtUsd(market.marketCap) + '</td></tr>' +
        '<tr><td>Pair yasi</td><td>' + fmtAge(token.pairAgeMinutes) + '</td></tr>' +
        '<tr><td>24s hacim</td><td>' + fmtUsd(market.volume?.h24) + '</td></tr>' +
        '<tr><td>5dk / 1s tx</td><td>' + ((market.txns?.m5?.buys || 0) + (market.txns?.m5?.sells || 0)) + ' / ' + ((market.txns?.h1?.buys || 0) + (market.txns?.h1?.sells || 0)) + '</td></tr>' +
        '<tr><td>Degisim</td><td>5dk ' + fmtPct(market.priceChange?.m5) + ' · 1s ' + fmtPct(market.priceChange?.h1) + ' · 24s ' + fmtPct(market.priceChange?.h24) + '</td></tr>' +
        '</tbody></table>';

      const onchain = data.onchain || {};
      document.getElementById('risk').innerHTML =
        '<table><tbody>' +
        '<tr><td>Supply</td><td>' + (onchain.supply ? Number(onchain.supply).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '-') + '</td></tr>' +
        '<tr><td>Top1 holder</td><td class="' + ((onchain.top1Pct || 0) > 35 ? 'bad' : 'good') + '">' + fmtPct(onchain.top1Pct) + '</td></tr>' +
        '<tr><td>Top10 holder</td><td class="' + ((onchain.top10Pct || 0) > 82 ? 'bad' : 'good') + '">' + fmtPct(onchain.top10Pct) + '</td></tr>' +
        '<tr><td>Mint authority</td><td>' + (onchain.mintAuthority ? '<span class="bad">' + esc(short(onchain.mintAuthority)) + '</span>' : '<span class="good">kapali</span>') + '</td></tr>' +
        '<tr><td>Freeze authority</td><td>' + (onchain.freezeAuthority ? '<span class="bad">' + esc(short(onchain.freezeAuthority)) + '</span>' : '<span class="good">kapali</span>') + '</td></tr>' +
        '</tbody></table>' +
        '<div class="small" style="margin-top:10px">Top holder verisi Solana RPC largest accounts uzerinden hesaplanir; borsa/pool hesaplari ayristirilmis garanti sayilmaz.</div>';

      const social = data.social || {};
      const dex = data.dex || {};
      document.getElementById('social').innerHTML =
        '<div class="actions">' +
        (social.links || []).map(item => '<a class="btn" target="_blank" rel="noreferrer" href="' + esc(item.url) + '">' + esc(item.label || item.type || 'link') + '</a>').join('') +
        '<a class="btn" target="_blank" rel="noreferrer" href="' + esc(social.xSearch) + '">X ara</a>' +
        '</div>' +
        '<div style="height:12px"></div>' +
        '<div class="log">Paid order: ' + (dex.orders || []).length + '\\nBoost amount: ' + Number(dex.boostAmount || 0).toFixed(0) + '\\nBoost total: ' + Number(dex.boostTotalAmount || 0).toFixed(0) + '\\nReddit post: ' + (data.reddit?.count || 0) + '\\nGitHub repo: ' + (data.github?.total || 0) + '</div>';

      const llama = data.defiLlama || {};
      document.getElementById('llama').innerHTML =
        '<table><tbody>' +
        '<tr><td>Token fiyat</td><td>' + (llama.price?.price ? fmtUsd(llama.price.price) : 'DefiLlama coin DB icinde yok') + '</td></tr>' +
        '<tr><td>Confidence</td><td>' + (llama.price?.confidence !== undefined ? Number(llama.price.confidence).toFixed(2) : '-') + '</td></tr>' +
        '<tr><td>Solana TVL</td><td>' + fmtUsd(llama.context?.solanaTvlUsd) + '</td></tr>' +
        '<tr><td>Solana stable</td><td>' + fmtUsd(llama.context?.solanaStableUsd) + '</td></tr>' +
        '<tr><td>Chain sayisi</td><td>' + (llama.context?.chainsSeen || '-') + '</td></tr>' +
        '</tbody></table>';

      const rug = data.rugcheck || {};
      const pump = data.pumpfun || {};
      const gecko = data.gecko || {};
      const rugRisks = (rug.risks || []).map(item => item.name || item.description || item.level || 'risk').slice(0, 6);
      document.getElementById('ultraRisk').innerHTML =
        '<table><tbody>' +
        '<tr><td>RugCheck</td><td>' + (rug.enabled ? '<span class="' + ((rug.risks || []).length || rug.rugged ? 'bad' : 'good') + '">' + ((rug.risks || []).length || 0) + ' risk · skor ' + (rug.scoreNormalised ?? rug.score ?? '-') + '</span>' : 'veri yok') + '</td></tr>' +
        '<tr><td>LP locked</td><td>' + (rug.lpLockedPct === null || rug.lpLockedPct === undefined ? '-' : fmtPct(rug.lpLockedPct)) + '</td></tr>' +
        '<tr><td>Holder</td><td>' + (rug.totalHolders || '-') + '</td></tr>' +
        '<tr><td>Insider graph</td><td>' + (rug.graphInsidersDetected === null || rug.graphInsidersDetected === undefined ? '-' : String(rug.graphInsidersDetected)) + '</td></tr>' +
        '<tr><td>Creator token</td><td>' + ((rug.creatorTokens || []).length || '-') + '</td></tr>' +
        '<tr><td>Gecko reserve</td><td>' + fmtUsd(gecko.reserveUsd) + '</td></tr>' +
        '</tbody></table>' +
        '<div class="log" style="margin-top:10px">' + (rugRisks.length ? rugRisks.map(item => '- ' + item).join('\\n') : 'RugCheck risk listesi temiz veya veri yok.') + '</div>';

      document.getElementById('launchpad').innerHTML =
        '<table><tbody>' +
        '<tr><td>Pump.fun</td><td>' + (pump.enabled ? (pump.complete ? '<span class="good">graduated</span>' : '<span class="warn">bonding</span>') : 'kayit yok') + '</td></tr>' +
        '<tr><td>Creator</td><td class="mono">' + esc(pump.creator || rug.creator || '-') + '</td></tr>' +
        '<tr><td>Olusum</td><td>' + (pump.createdAt ? fmtAge((Date.now() - new Date(pump.createdAt).getTime()) / 60000) : '-') + '</td></tr>' +
        '<tr><td>Reply / live</td><td>' + (pump.replyCount ?? '-') + ' / ' + (pump.currentlyLive ? 'live' : '-') + '</td></tr>' +
        '<tr><td>ATH mcap</td><td>' + fmtUsd(pump.athMarketCap) + '</td></tr>' +
        '<tr><td>Gecko launchpad</td><td>' + (gecko.launchpad?.completed ? 'completed' : (gecko.launchpad ? 'var' : '-')) + '</td></tr>' +
        '</tbody></table>' +
        '<div class="actions" style="margin-top:10px">' +
        (pump.twitter ? '<a class="btn" target="_blank" rel="noreferrer" href="' + esc(pump.twitter) + '">Pump X</a>' : '') +
        (pump.website ? '<a class="btn" target="_blank" rel="noreferrer" href="' + esc(pump.website) + '">Website</a>' : '') +
        '</div>';

      document.getElementById('githubRows').innerHTML = (data.github?.items || []).map(repo =>
        '<tr><td>' + link(repo.url, repo.name) + '<div class="small">' + esc(repo.description || '') + '</div></td><td>' + Number(repo.stars || 0).toLocaleString('en-US') + '</td><td>' + esc((repo.updatedAt || '').slice(0, 10)) + '</td></tr>'
      ).join('') || '<tr><td colspan="3" class="empty">GitHub eslesmesi yok veya alakasiz cikti.</td></tr>';

      document.getElementById('redditRows').innerHTML = (data.reddit?.posts || []).map(post =>
        '<tr><td>' + link(post.url, post.title) + '<div class="small">' + esc(post.selftext || '') + '</div></td><td>r/' + esc(post.subreddit) + '</td><td>' + Number(post.score || 0) + ' oy<br><span class="small">' + Number(post.comments || 0) + ' yorum</span></td></tr>'
      ).join('') || '<tr><td colspan="3" class="empty">Reddit izi yok.</td></tr>';

      document.getElementById('sources').innerHTML = (data.sources || []).map(source =>
        '<tr><td>' + link(source.link, source.name) + '</td><td><span class="tag">' + esc(source.status) + '</span></td><td>' + esc(source.use) + '</td></tr>'
      ).join('');
    }

    async function analyze(value) {
      const query = (value ?? document.getElementById('query').value).trim();
      if (!query) return;
      const btn = document.getElementById('analyze');
      btn.disabled = true;
      document.getElementById('status').textContent = 'Analiz calisiyor...';
      try {
        const res = await fetch('/api/oracle/token?q=' + encodeURIComponent(query), { cache:'no-store' });
        render(await res.json());
      } catch (error) {
        document.getElementById('status').textContent = 'Hata: ' + error.message;
      } finally {
        btn.disabled = false;
      }
    }

    document.getElementById('analyze').addEventListener('click', () => analyze());
    document.querySelectorAll('.oracle-jump').forEach(button => {
      button.addEventListener('click', () => {
        document.body.classList.remove('simple');
        document.getElementById('toggleAdvanced').textContent = 'Basit Moda Dön';
        const target = document.getElementById(button.dataset.target);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    document.getElementById('query').addEventListener('keydown', event => { if (event.key === 'Enter') analyze(); });
    document.getElementById('simpleRefresh').addEventListener('click', () => loadSimpleDashboard(true));
    document.getElementById('toggleAdvanced').addEventListener('click', () => {
      const simple = document.body.classList.toggle('simple');
      document.getElementById('toggleAdvanced').textContent = simple ? 'Detayları Göster' : 'Basit Moda Dön';
    });
    document.getElementById('simpleActionButtons').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      const mint = button.dataset.mint;
      if (!mint) return;
      if (button.dataset.action === 'simple-analyze') {
        document.getElementById('query').value = mint;
        analyze(mint);
        document.body.classList.remove('simple');
        document.getElementById('toggleAdvanced').textContent = 'Basit Moda Dön';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      if (button.dataset.action === 'simple-watch') {
        document.getElementById('simpleStatus').textContent = 'Listeye alınıyor...';
        try {
          await updateWatchlist({ action:'add', query: mint, note:'Basit panelden eklendi' });
          await loadSimpleDashboard(true);
        } catch (error) {
          document.getElementById('simpleStatus').textContent = 'Hata: ' + error.message;
        }
      }
    });
    const simpleFoundWalletsEl = document.getElementById('simpleFoundWallets');
    if (simpleFoundWalletsEl) simpleFoundWalletsEl.addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.action === 'simple-wallet-alert') await addSimpleWallet(button, 'alert');
        if (button.dataset.action === 'simple-wallet-copy') await addSimpleWallet(button, 'copy');
        if (button.dataset.action === 'simple-wallet-detail') await loadWalletDetail(button.dataset.wallet);
      } catch (error) {
        document.getElementById('simpleStatus').textContent = 'Hata: ' + error.message;
      }
    });
    const simpleWalletsEl = document.getElementById('simpleWallets');
    if (simpleWalletsEl) simpleWalletsEl.addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.action === 'summary-wallet-alert') await addSimpleWallet(button, 'alert');
        if (button.dataset.action === 'summary-wallet-copy') await addSimpleWallet(button, 'copy');
        if (button.dataset.action === 'summary-wallet-detail') await loadWalletDetail(button.dataset.wallet);
      } catch (error) {
        document.getElementById('simpleStatus').textContent = 'Hata: ' + error.message;
      }
    });
    ['childActions', 'childTokens'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button) return;
        const mint = button.dataset.mint;
        if (!mint) return;
        if (button.dataset.action === 'simple-analyze') {
          document.getElementById('query').value = mint;
          analyze(mint);
          document.body.classList.remove('simple');
          document.getElementById('toggleAdvanced').textContent = 'Basit Moda Dön';
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (button.dataset.action === 'simple-watch') {
          document.getElementById('simpleStatus').textContent = 'Listeye alınıyor...';
          try {
            await updateWatchlist({ action:'add', query: mint, note:'Basit çocuk panelinden eklendi' });
            await loadSimpleDashboard(true);
          } catch (error) {
            document.getElementById('simpleStatus').textContent = 'Hata: ' + error.message;
          }
        }
      });
    });
    document.getElementById('childWallets').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.action === 'simple-wallet-alert') await addSimpleWallet(button, 'alert');
        if (button.dataset.action === 'simple-wallet-copy') await addSimpleWallet(button, 'copy');
        if (button.dataset.action === 'simple-wallet-detail') await loadWalletDetail(button.dataset.wallet);
      } catch (error) {
        document.getElementById('simpleStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('discover').addEventListener('click', () => loadDiscovery(false));
    document.getElementById('discoverFresh').addEventListener('click', () => loadDiscovery(true));
    document.getElementById('socialScan').addEventListener('click', () => loadSocialRadar(false));
    document.getElementById('socialFresh').addEventListener('click', () => loadSocialRadar(true));
    document.getElementById('opportunityScan').addEventListener('click', () => loadOpportunity(false));
    document.getElementById('opportunityFresh').addEventListener('click', () => loadOpportunity(true));
    document.getElementById('hunterScan').addEventListener('click', () => loadHunter(false));
    document.getElementById('hunterFresh').addEventListener('click', () => loadHunter(true));
    document.getElementById('nansenScan').addEventListener('click', () => loadNansenSmart(false));
    document.getElementById('nansenFresh').addEventListener('click', () => loadNansenSmart(true));
    document.getElementById('councilScan').addEventListener('click', () => loadAlphaCouncil(false));
    document.getElementById('councilFresh').addEventListener('click', () => loadAlphaCouncil(true));
    document.getElementById('edgeScan').addEventListener('click', () => loadEdge(false));
    document.getElementById('edgeFresh').addEventListener('click', () => loadEdge(true));
    document.getElementById('addManual').addEventListener('click', async () => {
      const query = document.getElementById('manualToken').value.trim();
      const note = document.getElementById('manualNote').value.trim();
      if (!query) return;
      document.getElementById('discoverStatus').textContent = 'Listeye ekleniyor...';
      try {
        await updateWatchlist({ action:'add', query, note });
        document.getElementById('manualToken').value = '';
        document.getElementById('manualNote').value = '';
      } catch (error) {
        document.getElementById('discoverStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('socialRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      const mint = button.dataset.mint;
      if (!mint) return;
      if (button.dataset.action === 'analyze') {
        document.getElementById('query').value = mint;
        analyze(mint);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (button.dataset.action === 'watch') {
        document.getElementById('socialStatus').textContent = 'Listeye aliniyor...';
        try {
          await updateWatchlist({ action:'add', query: mint, symbol: button.dataset.symbol || '', note:'buyuk hesap radarindan eklendi' });
          await loadSocialRadar(false);
        } catch (error) {
          document.getElementById('socialStatus').textContent = 'Hata: ' + error.message;
        }
      }
    });
    document.getElementById('opportunityRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      const mint = button.dataset.mint;
      if (!mint) return;
      if (button.dataset.action === 'analyze') {
        document.getElementById('query').value = mint;
        analyze(mint);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (button.dataset.action === 'watch') {
        document.getElementById('opportunityStatus').textContent = 'Listeye aliniyor...';
        try {
          await updateWatchlist({ action:'add', query: mint, symbol: button.dataset.symbol || '', note:'ultra firsat merkezinden eklendi' });
          await loadOpportunity(false);
        } catch (error) {
          document.getElementById('opportunityStatus').textContent = 'Hata: ' + error.message;
        }
      }
    });
    document.getElementById('hunterWalletRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.action === 'add-alert') await addHunterWallet(button, 'alert');
        if (button.dataset.action === 'add-copy') await addHunterWallet(button, 'copy');
      } catch (error) {
        document.getElementById('hunterStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('nansenWalletRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.action === 'nansen-alert') await addNansenWallet(button, 'alert');
        if (button.dataset.action === 'nansen-copy') await addNansenWallet(button, 'copy');
      } catch (error) {
        document.getElementById('nansenStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('nansenTokenRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      const mint = button.dataset.mint;
      if (!mint) return;
      try {
        if (button.dataset.action === 'nansen-token') {
          document.getElementById('query').value = mint;
          analyze(mint);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (button.dataset.action === 'nansen-watch') {
          await updateWatchlist({ action:'add', query: mint, note:'Nansen premium smart money token adayi' });
          await loadNansenSmart(false);
        }
      } catch (error) {
        document.getElementById('nansenStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('councilTokenRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      const mint = button.dataset.mint;
      if (!mint) return;
      try {
        if (button.dataset.action === 'council-token') {
          document.getElementById('query').value = mint;
          analyze(mint);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (button.dataset.action === 'council-watch') {
          await updateWatchlist({ action:'add', query: mint, note:'Alpha Council çoklu teyit adayı' });
          await loadAlphaCouncil(false);
        }
      } catch (error) {
        document.getElementById('councilStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('edgeRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.action === 'edge-alert') {
          await addHunterWallet(button, 'alert');
          await loadEdge(false);
        }
        if (button.dataset.action === 'edge-copy') {
          await addHunterWallet(button, 'copy');
          await loadEdge(false);
        }
        if (button.dataset.action === 'edge-token') {
          document.getElementById('query').value = button.dataset.mint;
          analyze(button.dataset.mint);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (button.dataset.action === 'edge-watch') {
          await updateWatchlist({ action:'add', query: button.dataset.mint, note:'Edge Matrix aday token' });
          await loadEdge(false);
        }
      } catch (error) {
        document.getElementById('edgeStatus').textContent = 'Hata: ' + error.message;
      }
    });
    document.getElementById('discoverRows').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      const mint = button.dataset.mint;
      if (!mint) return;
      if (button.dataset.action === 'analyze') {
        document.getElementById('query').value = mint;
        analyze(mint);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (button.dataset.action === 'watch') {
        document.getElementById('discoverStatus').textContent = 'Listeye aliniyor...';
        try {
          await updateWatchlist({ action:'add', query: mint, symbol: button.dataset.symbol || '', note:'otomatik avdan eklendi' });
        } catch (error) {
          document.getElementById('discoverStatus').textContent = 'Hata: ' + error.message;
        }
        return;
      }
      if (button.dataset.action === 'remove') {
        document.getElementById('discoverStatus').textContent = 'Listeden siliniyor...';
        try {
          await updateWatchlist({ action:'remove', mint });
        } catch (error) {
          document.getElementById('discoverStatus').textContent = 'Hata: ' + error.message;
        }
      }
    });
    document.getElementById('analyzeCurrent').addEventListener('click', async () => {
      const res = await fetch('/api/state?ts=' + Date.now(), { cache:'no-store' });
      const state = await res.json();
      const value = state.events?.[0]?.mint || state.lastEventSymbol || '';
      document.getElementById('query').value = value;
      analyze(value);
    });
    loadSimpleDashboard(false);
    loadDiscovery(false);
    loadSocialRadar(false);
    loadOpportunity(false);
    loadHunter(false);
    loadNansenSmart(false);
    loadAlphaCouncil(false);
    loadEdge(false);
  </script>
</body>
</html>`;
}

function gmgnAgentPageHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GMGN Agent Panel</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --panel:#121923; --panel2:#0f151d; --line:#263241; --text:#e7edf5; --muted:#8fa0b5; --good:#35d08c; --bad:#ff5e6c; --warn:#f2c14e; --blue:#6bb7ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { position:sticky; top:0; z-index:3; background:rgba(11,15,20,.96); border-bottom:1px solid var(--line); padding:16px 18px; }
    h1 { margin:0; font-size:24px; }
    .sub,.small { color:var(--muted); line-height:1.4; }
    .nav,.actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:12px; }
    a,.link { color:var(--blue); text-decoration:none; }
    .btn,button { border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:8px; padding:10px 12px; min-height:40px; cursor:pointer; font:inherit; text-decoration:none; }
    button.primary { background:#18324b; border-color:#295c88; }
    button:disabled { opacity:.65; cursor:wait; }
    main { padding:18px; display:grid; gap:16px; max-width:1320px; margin:0 auto; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
    .panel,.metric { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .panel h2 { margin:0; padding:13px 15px; border-bottom:1px solid var(--line); font-size:16px; }
    .body { padding:14px 15px; display:grid; gap:12px; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .metric { padding:14px; min-height:92px; }
    .label { color:var(--muted); font-size:12px; }
    .value { font-size:24px; font-weight:850; margin-top:8px; overflow-wrap:anywhere; }
    input,textarea { width:100%; border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:8px; padding:12px; font:inherit; }
    textarea { min-height:116px; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
    table { width:100%; border-collapse:collapse; min-width:760px; }
    th,td { text-align:left; padding:10px 12px; border-bottom:1px solid rgba(38,50,65,.75); vertical-align:top; font-size:14px; }
    th { color:var(--muted); font-size:12px; }
    .table-scroll { overflow:auto; }
    .tag { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:3px 8px; color:var(--muted); font-size:12px; margin:2px 4px 2px 0; }
    .tag.good { color:var(--good); border-color:rgba(53,208,140,.45); }
    .tag.warn { color:var(--warn); border-color:rgba(242,193,78,.45); }
    .tag.bad { color:var(--bad); border-color:rgba(255,94,108,.45); }
    .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); } .blue { color:var(--blue); }
    .mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .log { white-space:pre-wrap; color:var(--muted); background:var(--panel2); border-radius:8px; padding:12px; line-height:1.5; }
    .gmgn-map { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
    .gmgn-map a { display:grid; align-content:start; gap:6px; min-height:86px; }
    .gmgn-map b { color:var(--text); font-size:14px; }
    .gmgn-map span { color:var(--muted); font-size:12px; line-height:1.35; }
    @media (max-width:900px) { .grid,.metrics { grid-template-columns:1fr; } table { min-width:680px; } }
    @media (max-width:700px) { .gmgn-map { grid-template-columns:1fr; } }
    @media (max-width:640px) {
      html { -webkit-text-size-adjust:100%; scroll-padding-top:132px; }
      body { overflow-x:hidden; }
      header { padding:12px; max-height:48vh; overflow:auto; }
      h1 { font-size:22px; line-height:1.1; }
      .sub,.small { font-size:12px; }
      main { padding:12px; gap:12px; }
      .nav,.actions { flex-wrap:nowrap; overflow-x:auto; padding-bottom:6px; -webkit-overflow-scrolling:touch; }
      .nav .btn,.nav a,.actions button,.actions .btn { flex:0 0 auto; white-space:nowrap; font-size:13px; padding:9px 11px; }
      .gmgn-map { grid-template-columns:1fr; }
      .metrics { grid-template-columns:1fr 1fr; gap:10px; }
      .metric { min-height:84px; padding:12px; }
      .value { font-size:22px; overflow-wrap:anywhere; }
      .panel h2 { font-size:16px; padding:12px; }
      .body { padding:12px; }
      input,textarea,button { font-size:16px; min-height:44px; }
      textarea { min-height:92px; }
      .table-scroll { border-radius:8px; -webkit-overflow-scrolling:touch; }
      table { min-width:560px; }
      th,td { padding:10px; font-size:13px; }
      th,.mono,.tag { font-size:12px; }
      .log { font-size:12px; max-height:280px; overflow:auto; }
    }
    @media (max-width:380px) { .metrics { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>GMGN Agent Panel</h1>
    <div class="sub">GMGN CLI + Agent Skills veri katmani. Gercek emir kapali; swap/order icin ayrica manuel onay gerekir.</div>
    <div class="nav">
      <a class="btn" href="/">Dashboard</a>
      <a class="btn" href="/token-research">Token Arastir</a>
      <a class="btn" href="/control">Kontrol</a>
      <a class="btn" href="/gmgn-key">Public Key</a>
      <a class="btn" href="/chat">Sohbet</a>
    </div>
  </header>
  <main>
    <section class="panel">
      <h2>GMGN Sayfa Haritasi</h2>
      <div class="body">
        <div class="gmgn-map">
          <a class="btn" href="#gmgn-setup"><b>1. API Bagla</b><span>Key kaydet, CLI ve private key durumunu test et.</span></a>
          <a class="btn" href="#gmgn-flow"><b>2. Smart/KOL Akisi</b><span>Akilli para ve KOL alim-satim akisini cek.</span></a>
          <a class="btn" href="#gmgn-market"><b>3. Trend Adaylari</b><span>GMGN trend, signal ve trenches adaylarini puanla.</span></a>
          <a class="btn" href="#gmgn-token"><b>4. Token Kontrol</b><span>Mint girip security, holder ve smart trader raporu al.</span></a>
        </div>
        <div class="small">API key'i sohbete yazmana gerek yok; bu paneldeki kutuya yapistirip kaydetmen daha temiz.</div>
      </div>
    </section>

    <section class="metrics">
      <div class="metric"><div class="label">CLI</div><div id="cliReady" class="value">-</div></div>
      <div class="metric"><div class="label">API Key</div><div id="apiReady" class="value">-</div></div>
      <div class="metric"><div class="label">Private Key</div><div id="privReady" class="value">-</div></div>
      <div class="metric"><div class="label">Test</div><div id="testReady" class="value">-</div></div>
    </section>

    <section id="gmgn-setup" class="grid">
      <div class="panel">
        <h2>1. API Key Bagla</h2>
        <div class="body">
          <div class="small">GMGN Create API Key basarili olunca ekranda verdigi API key'i buraya yapistir. Private key localdeki Binance generator key ile eslestirilir.</div>
          <textarea id="publicKey" readonly></textarea>
          <div class="actions">
            <button id="copyPublic">Public Key Kopyala</button>
            <a class="btn" href="https://gmgn.ai/ai?chain=sol" target="_blank" rel="noreferrer">GMGN API Sayfasi</a>
          </div>
          <input id="apiKey" type="password" placeholder="GMGN API key..." />
          <div class="actions">
            <button id="saveKey" class="primary">Kaydet ve Test Et</button>
            <button id="refreshStatus">Durumu Yenile</button>
          </div>
          <div id="setupStatus" class="log">Hazir.</div>
        </div>
      </div>
      <div class="panel">
        <h2>2. Veri Akislari</h2>
        <div class="body">
          <div class="actions">
            <button id="loadTrack" class="primary">Smart/KOL Akisini Cek</button>
            <button id="loadMarket">Trend ve Sinyal Cek</button>
          </div>
          <div class="log" id="gmgnSummary">GMGN API key baglaninca burasi dolacak.</div>
        </div>
      </div>
    </section>

    <section id="gmgn-flow" class="panel">
      <h2>Smart Money / KOL Cluster</h2>
      <div class="table-scroll"><table>
        <thead><tr><th>Token</th><th>Yön</th><th>Cüzdan</th><th>Hacim</th><th>Güç</th></tr></thead>
        <tbody id="clusterRows"></tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>Canli Smart/KOL Islem Akisi</h2>
      <div class="table-scroll"><table>
        <thead><tr><th>Zaman</th><th>Kaynak</th><th>Yön</th><th>Token</th><th>Tutar</th><th>Trader</th></tr></thead>
        <tbody id="tradeRows"></tbody>
      </table></div>
    </section>

    <section id="gmgn-market" class="panel">
      <h2>GMGN Trend / Signal / Trenches Adaylari</h2>
      <div class="table-scroll"><table>
        <thead><tr><th>Token</th><th>Skor</th><th>Piyasa</th><th>Smart/KOL</th><th>Risk</th><th>Karar</th></tr></thead>
        <tbody id="marketRows"></tbody>
      </table></div>
    </section>

    <section id="gmgn-token" class="panel">
      <h2>Token Due Diligence</h2>
      <div class="body">
        <div class="actions">
          <input id="tokenAddress" placeholder="Solana token mint..." />
          <button id="scanToken" class="primary">GMGN Token Analiz</button>
        </div>
        <div id="tokenReport" class="log">Token adresi girince GMGN info/security/smart traders ceker.</div>
      </div>
    </section>
  </main>
  <script>
    const fmtUsd = v => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const short = v => v ? String(v).slice(0,6) + '...' + String(v).slice(-4) : '-';
    const time = ts => ts ? new Date(Number(ts) * 1000).toLocaleTimeString('tr-TR') : '-';
    const cls = ok => ok ? 'good' : 'bad';
    function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
    async function getJson(url, options){ const res = await fetch(url, { cache:'no-store', ...options }); const data = await res.json(); if (!res.ok) throw new Error(data.error || res.statusText); return data; }
    async function refreshStatus(){
      const data = await getJson('/api/gmgn/status');
      document.getElementById('cliReady').innerHTML = '<span class="' + cls(data.cliReady) + '">' + (data.cliReady ? 'hazir' : 'yok') + '</span>';
      document.getElementById('apiReady').innerHTML = '<span class="' + cls(data.apiKeyPresent) + '">' + (data.apiKeyPresent ? data.apiKeyMasked : 'yok') + '</span>';
      document.getElementById('privReady').innerHTML = '<span class="' + cls(data.privateKeyPresent) + '">' + (data.privateKeyPresent ? 'var' : 'yok') + '</span>';
      document.getElementById('testReady').innerHTML = '<span class="' + cls(data.test && data.test.ok) + '">' + (data.test && data.test.ok ? 'OK' : 'bekliyor') + '</span>';
      document.getElementById('publicKey').value = data.publicKeyPem || '';
      document.getElementById('setupStatus').textContent = (data.test && data.test.message) || 'Durum alindi.';
      return data;
    }
    document.getElementById('copyPublic').onclick = async () => { await navigator.clipboard.writeText(document.getElementById('publicKey').value.trim() + '\\n'); };
    document.getElementById('refreshStatus').onclick = refreshStatus;
    document.getElementById('saveKey').onclick = async () => {
      const apiKey = document.getElementById('apiKey').value.trim();
      document.getElementById('setupStatus').textContent = 'Kaydediliyor ve test ediliyor...';
      try {
        const data = await getJson('/api/gmgn/setup', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ apiKey, includePrivateKey:true }) });
        document.getElementById('apiKey').value = '';
        await refreshStatus();
        document.getElementById('setupStatus').textContent = (data.test && data.test.message) || 'Kaydedildi.';
      } catch (e) { document.getElementById('setupStatus').textContent = e.message; }
    };
    document.getElementById('loadTrack').onclick = async () => {
      document.getElementById('gmgnSummary').textContent = 'Smart/KOL akisi cekiliyor...';
      const data = await getJson('/api/gmgn/track?force=1');
      document.getElementById('gmgnSummary').textContent = (data.ok ? 'Akis geldi. ' : 'Akis bos/hata. ') + (data.errors || []).join('\\n');
      document.getElementById('clusterRows').innerHTML = (data.clusters || []).map(r => '<tr><td><a href="https://gmgn.ai/sol/token/' + esc(r.address) + '" target="_blank">' + esc(r.token) + '</a><div class="mono">' + short(r.address) + '</div></td><td>' + esc(r.side) + '</td><td>' + r.makers + '</td><td>' + fmtUsd(r.amountUsd) + '</td><td><span class="tag ' + (r.strength === 'GUCLU' ? 'good' : r.strength === 'ORTA' ? 'warn' : '') + '">' + r.strength + '</span></td></tr>').join('') || '<tr><td colspan="5" class="small">Cluster yok.</td></tr>';
      document.getElementById('tradeRows').innerHTML = (data.trades || []).map(r => '<tr><td>' + time(r.timestamp) + '</td><td>' + esc(r.source) + '</td><td><span class="tag ' + (r.side === 'buy' ? 'good' : 'bad') + '">' + esc(r.side) + '</span></td><td><a href="https://gmgn.ai/sol/token/' + esc(r.address) + '" target="_blank">' + esc(r.token) + '</a><div class="mono">' + short(r.address) + '</div></td><td>' + fmtUsd(r.amountUsd) + '</td><td>' + esc(r.makerName || short(r.maker)) + '<div class="mono">' + short(r.maker) + '</div></td></tr>').join('') || '<tr><td colspan="6" class="small">Veri yok.</td></tr>';
    };
    document.getElementById('loadMarket').onclick = async () => {
      document.getElementById('gmgnSummary').textContent = 'Trend/sinyal verisi cekiliyor...';
      const data = await getJson('/api/gmgn/market?force=1');
      document.getElementById('gmgnSummary').textContent = (data.ok ? 'GMGN market verisi geldi.' : 'GMGN market verisi bos/hata.') + '\\n' + (data.errors || []).join('\\n');
      document.getElementById('marketRows').innerHTML = (data.rows || []).map(r => '<tr><td><a href="https://gmgn.ai/sol/token/' + esc(r.address) + '" target="_blank">' + esc(r.symbol) + '</a><div class="mono">' + short(r.address) + '</div><div class="small">' + esc(r.source) + ' · ' + esc(r.platform) + '</div></td><td class="' + (r.score >= 75 ? 'good' : r.score >= 58 ? 'warn' : 'bad') + '">' + r.score + '</td><td>MC ' + fmtUsd(r.marketCap) + '<div class="small">liq ' + fmtUsd(r.liquidity) + ' · vol ' + fmtUsd(r.volume) + '</div></td><td>SM ' + r.smartDegens + ' · KOL ' + r.renowned + '<div class="small">holders ' + r.holders + '</div></td><td>rug ' + Number(r.rugRatio || 0).toFixed(2) + '<div class="small">' + (r.washTrading ? 'wash risk' : 'wash yok') + '</div></td><td><span class="tag ' + (r.verdict === 'SCOUT' ? 'good' : r.verdict === 'IZLE' ? 'warn' : 'bad') + '">' + r.verdict + '</span></td></tr>').join('') || '<tr><td colspan="6" class="small">Aday yok.</td></tr>';
    };
    document.getElementById('scanToken').onclick = async () => {
      const q = document.getElementById('tokenAddress').value.trim();
      document.getElementById('tokenReport').textContent = 'GMGN token analizi cekiliyor...';
      try {
        const data = await getJson('/api/gmgn/token?address=' + encodeURIComponent(q));
        const info = (data.info && data.info.data) || data.info || {};
        const sec = (data.security && data.security.data) || data.security || {};
        const tags = info.wallet_tags_stat || {};
        const priceObj = info.price || {};
        const statObj = info.stat || {};
        document.getElementById('tokenReport').textContent =
          'Token: ' + (info.symbol || '-') + ' / ' + (info.name || '-') + '\\n' +
          'Fiyat: ' + (priceObj.price || info.price || '-') + ' · Likidite: ' + fmtUsd(info.liquidity) + ' · Holder: ' + (info.holder_count || '-') + '\\n' +
          'Smart: ' + (tags.smart_wallets || 0) + ' · KOL: ' + (tags.renowned_wallets || 0) + ' · Sniper: ' + (tags.sniper_wallets || 0) + '\\n' +
          'Risk: top10 ' + Number(sec.top_10_holder_rate || statObj.top_10_holder_rate || 0).toFixed(3) + ' · rug ' + Number(sec.rug_ratio || 0).toFixed(3) + '\\n' +
          'Smart trader sayisi: ' + (data.smartTraders || []).length + '\\n' +
          (data.errors || []).join('\\n');
      } catch (e) { document.getElementById('tokenReport').textContent = e.message; }
    };
    refreshStatus().catch(e => document.getElementById('setupStatus').textContent = e.message);
  </script>
</body>
</html>`;
}

function chatPageHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Mobil Sohbet</title>
  <style>
    :root { color-scheme:dark; --bg:#0b0f14; --panel:#121923; --panel2:#0f151d; --line:#263241; --text:#e7edf5; --muted:#8fa0b5; --good:#35d08c; --bad:#ff5e6c; --warn:#f2c14e; --blue:#6bb7ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-x:hidden; }
    header { position:sticky; top:0; z-index:3; padding:14px 16px; background:rgba(11,15,20,.96); border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:22px; line-height:1.1; }
    .sub,.small { color:var(--muted); line-height:1.4; font-size:13px; }
    .nav,.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; align-items:center; }
    .nav { flex-wrap:nowrap; overflow-x:auto; padding-bottom:5px; -webkit-overflow-scrolling:touch; }
    a,.btn,button { color:var(--text); text-decoration:none; }
    .btn,button { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:10px 12px; min-height:42px; font:inherit; cursor:pointer; }
    .btn.active,button.primary { border-color:rgba(107,183,255,.7); color:var(--blue); }
    main { padding:14px; display:grid; gap:12px; max-width:880px; margin:0 auto; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .panel h2 { margin:0; padding:12px 14px; border-bottom:1px solid var(--line); font-size:16px; }
    .body { padding:12px; display:grid; gap:10px; }
    textarea { width:100%; min-height:120px; resize:vertical; border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:8px; padding:12px; font:inherit; font-size:16px; }
    .messages { display:grid; gap:10px; max-height:58vh; overflow:auto; padding:12px; background:var(--panel2); border-radius:8px; border:1px solid var(--line); }
    .msg { padding:11px 12px; border:1px solid rgba(38,50,65,.8); border-radius:8px; background:rgba(18,25,35,.82); }
    .msg.user { border-color:rgba(107,183,255,.45); }
    .msg.assistant { border-color:rgba(53,208,140,.42); }
    .meta { display:flex; justify-content:space-between; gap:8px; color:var(--muted); font-size:12px; margin-bottom:6px; }
    .text { white-space:pre-wrap; line-height:1.45; overflow-wrap:anywhere; }
    .hint { border:1px solid rgba(242,193,78,.35); background:rgba(242,193,78,.08); padding:10px 12px; border-radius:8px; color:var(--muted); }
    @media (max-width:640px) {
      header { padding:12px; max-height:42vh; overflow:auto; }
      h1 { font-size:21px; }
      .sub,.small { font-size:12px; }
      main { padding:12px; }
      .nav .btn { flex:0 0 auto; white-space:nowrap; font-size:13px; padding:9px 11px; }
      .actions { display:grid; grid-template-columns:1fr 1fr; }
      button { width:100%; }
      .messages { max-height:50vh; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Codex Mobil Sohbet</h1>
    <div class="sub">Mobilden mesajlasma paneli. Sen yazarsin, ben buradan okurum; cevaplarimi da ayni ekrana dusururum.</div>
    <div class="nav">
      <a class="btn" href="/">Dashboard</a>
      <a class="btn" href="/token-research">Token Arastir</a>
      <a class="btn" href="/control">Kontrol</a>
      <a class="btn" href="/gmgn">GMGN</a>
      <a class="btn active" href="/chat">Sohbet</a>
    </div>
  </header>
  <main>
    <section class="panel">
      <h2>Mesaj Yaz</h2>
      <div class="body">
        <div class="hint">Not: Bu panel kendi basina AI uretmez; ama mesajlarin ve benim cevaplarim burada gorunur. Ben cevap verdikce Codex etiketiyle bu listeye kaydederim.</div>
        <textarea id="message" placeholder="Abi buraya yaz: neyi degistireyim, hangi sayfaya bakayim, hangi token/cuzdan incelensin..."></textarea>
        <div class="actions">
          <button id="send" class="primary">Gönder</button>
          <button id="refresh">Yenile</button>
        </div>
        <div id="status" class="small">Hazir.</div>
      </div>
    </section>
    <section class="panel">
      <h2>Mesajlar</h2>
      <div class="body"><div id="messages" class="messages"><div class="small">Yukleniyor...</div></div></div>
    </section>
  </main>
  <script>
    function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmt(t){ try { return new Date(t).toLocaleString('tr-TR'); } catch { return t || '-'; } }
    async function load(){
      const res = await fetch('/api/chat?ts=' + Date.now(), { cache:'no-store' });
      const data = await res.json();
      const rows = data.messages || [];
      document.getElementById('messages').innerHTML = rows.map(m =>
        '<div class="msg ' + esc(m.role) + '"><div class="meta"><b>' + (m.role === 'assistant' ? 'Codex' : 'Sen') + '</b><span>' + fmt(m.at) + '</span></div><div class="text">' + esc(m.text) + '</div></div>'
      ).join('') || '<div class="small">Henüz mesaj yok.</div>';
      const box = document.getElementById('messages');
      box.scrollTop = box.scrollHeight;
    }
    async function send(){
      const el = document.getElementById('message');
      const text = el.value.trim();
      if (!text) return;
      document.getElementById('status').textContent = 'Gonderiliyor...';
      const res = await fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        document.getElementById('status').textContent = data.error || 'Gonderilemedi';
        return;
      }
      el.value = '';
      document.getElementById('status').textContent = 'Kaydedildi. Ben buradan okuyup cevabi yine bu ekrana dusurebilirim.';
      await load();
    }
    document.getElementById('send').addEventListener('click', send);
    document.getElementById('refresh').addEventListener('click', load);
    document.getElementById('message').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') send();
    });
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/api/health") {
      send(res, 200, JSON.stringify({ ok: true, now: new Date().toISOString() }), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/state") {
      send(res, 200, JSON.stringify(await cachedApiState()), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/chat") {
      if ((req.method || "GET").toUpperCase() === "POST") {
        try {
          const body = await readBodyJson(req);
          const message = await appendChatMessage({ role: body.role, text: body.text });
          send(res, 200, JSON.stringify({ ok: true, message }), "application/json; charset=utf-8");
        } catch (error) {
          send(res, 400, JSON.stringify({ ok: false, error: error?.message || String(error) }), "application/json; charset=utf-8");
        }
        return;
      }
      send(res, 200, JSON.stringify({ ok: true, messages: await readChatMessages() }), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/control/bot") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      const body = await readBodyJson(req);
      const action = body.action || "status";
      const bot =
        action === "start" ? await startBotProcess() :
        action === "stop" ? await stopBotProcess() :
        action === "restart" ? await restartBotProcess() :
        await getBotStatus();
      send(res, 200, JSON.stringify({ ok: true, bot }), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/control/config") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify(await updateControlSettings((await readBodyJson(req)).settings || {})), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/control/wallet") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify(await updateControlWallet(await readBodyJson(req))), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/control/wallet/add") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      try {
        send(res, 200, JSON.stringify(await addControlWallet(await readBodyJson(req))), "application/json; charset=utf-8");
      } catch (error) {
        send(res, 400, JSON.stringify({ ok: false, error: error?.message || String(error) }), "application/json; charset=utf-8");
      }
      return;
    }
    if (url.pathname === "/api/control/wallets/batch") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      const body = await readBodyJson(req);
      send(res, 200, JSON.stringify(await batchWalletMode(body.mode || "alert")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/control/position") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      const body = await readBodyJson(req);
      if (body.action !== "close" || !body.id) throw new Error("position id required");
      send(res, 200, JSON.stringify(await manualClosePosition(body.id)), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/research") {
      send(res, 200, JSON.stringify(await apiResearch(url.searchParams.get("address") || "")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/wallet/detail") {
      send(res, 200, JSON.stringify(await apiWalletDetail(url.searchParams.get("wallet") || "")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/token") {
      send(res, 200, JSON.stringify(await apiOracleToken(url.searchParams.get("q") || "")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/discover") {
      send(res, 200, JSON.stringify(await apiOracleDiscover(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/social-scan") {
      send(res, 200, JSON.stringify(await apiSocialRadar(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/opportunity") {
      send(res, 200, JSON.stringify(await apiOracleOpportunity(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/super-alpha") {
      send(res, 200, JSON.stringify(await apiSuperAlpha(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/trends") {
      send(res, 200, JSON.stringify(await apiTrendMap(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/alpha-council") {
      send(res, 200, JSON.stringify(await apiAlphaCouncil(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/premium/nansen-smart") {
      send(res, 200, JSON.stringify(await apiNansenSmart(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/gmgn/status") {
      send(res, 200, JSON.stringify(await apiGmgnStatus()), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/gmgn/setup") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      try {
        send(res, 200, JSON.stringify(await apiGmgnSetup(await readBodyJson(req))), "application/json; charset=utf-8");
      } catch (error) {
        send(res, 400, JSON.stringify({ ok: false, error: error?.message || String(error) }), "application/json; charset=utf-8");
      }
      return;
    }
    if (url.pathname === "/api/gmgn/track") {
      send(res, 200, JSON.stringify(await apiGmgnTrack(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/gmgn/market") {
      send(res, 200, JSON.stringify(await apiGmgnMarket()), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/gmgn/token") {
      send(res, 200, JSON.stringify(await apiGmgnToken(url.searchParams.get("address") || "")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/wallet-hunter/auto") {
      send(res, 200, JSON.stringify(await apiWalletHunter(url.searchParams.get("force") === "1")), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/oracle/watchlist") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      try {
        send(res, 200, JSON.stringify(await updateOracleWatchlist(await readBodyJson(req))), "application/json; charset=utf-8");
      } catch (error) {
        send(res, 400, JSON.stringify({ ok: false, error: error?.message || String(error) }), "application/json; charset=utf-8");
      }
      return;
    }
    if (url.pathname === "/api/free-alpha/scan") {
      if ((req.method || "GET").toUpperCase() !== "POST") {
        send(res, 405, JSON.stringify({ error: "method not allowed" }), "application/json; charset=utf-8");
        return;
      }
      try {
        send(res, 200, JSON.stringify(await runFreeAlphaScan()), "application/json; charset=utf-8");
      } catch (error) {
        send(res, 500, JSON.stringify({ ok: false, error: error?.message || String(error) }), "application/json; charset=utf-8");
      }
      return;
    }
    if (url.pathname === "/moonshot") {
      send(res, 200, moonshotPageHtml());
      return;
    }
    if (url.pathname === "/research" || url.pathname === "/wallet-research") {
      send(res, 200, researchPageHtml());
      return;
    }
    if (url.pathname === "/oracle" || url.pathname === "/token-research") {
      send(res, 200, oraclePageHtml());
      return;
    }
    if (url.pathname === "/gmgn") {
      send(res, 200, gmgnAgentPageHtml());
      return;
    }
    if (url.pathname === "/chat") {
      send(res, 200, chatPageHtml());
      return;
    }
    if (url.pathname === "/gmgn-key") {
      send(res, 200, await fs.readFile("gmgn-key-helper.html", "utf8"));
      return;
    }
    if (url.pathname === "/gmgn-public-key.txt") {
      send(res, 200, await fs.readFile("gmgn-public-key.txt", "utf8"), "text/plain; charset=utf-8");
      return;
    }
    if (url.pathname === "/gmgn-public-key-openssh.txt") {
      send(res, 200, await fs.readFile("gmgn-public-key-openssh.txt", "utf8"), "text/plain; charset=utf-8");
      return;
    }
    if (url.pathname === "/control") {
      send(res, 200, controlPageHtml());
      return;
    }
    if (url.pathname === "/guide" || url.pathname === "/SISTEM_KULLANIM_KILAVUZU.md") {
      const guide = await readText("SISTEM_KULLANIM_KILAVUZU.md", "Kilavuz dosyasi bulunamadi.");
      send(res, 200, guide, "text/markdown; charset=utf-8");
      return;
    }
    if (url.pathname === "/guide-download") {
      const guide = await readText("SISTEM_KULLANIM_KILAVUZU.md", "Kilavuz dosyasi bulunamadi.");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": "attachment; filename=\"SISTEM_KULLANIM_KILAVUZU.md\"",
        "cache-control": "no-store"
      });
      res.end(guide);
      return;
    }
    const views = new Map([
      ["/", "home"],
      ["/wallets", "wallets"],
      ["/signals", "signals"],
      ["/positions", "positions"],
      ["/trades", "trades"],
      ["/strategy", "strategy"],
      ["/logs", "logs"]
    ]);
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      await sendStateEvent(res);
      const timer = setInterval(() => {
        sendStateEvent(res).catch(() => {});
      }, 5000);
      req.on("close", () => clearInterval(timer));
      return;
    }
    send(res, 200, pageHtml(views.get(url.pathname) || "home"));
  } catch (error) {
    send(res, 500, error.stack || String(error), "text/plain; charset=utf-8");
  }
});

server.listen(PORT, () => {
  fs.writeFile("server.pid", `${process.pid}`, "utf8").catch(() => {});
  console.log(`Dashboard running at http://localhost:${PORT}`);
  startAutoWalletHunterLoop();
});
