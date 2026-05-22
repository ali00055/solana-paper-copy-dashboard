import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.resolve("config.json");
const STATE_PATH = path.resolve("paper-state.json");
const EVENTS_PATH = path.resolve("paper-events.ndjson");
const BOT_LOCK_PATH = path.resolve("bot-runtime.lock");
const PROCESSED_SIGNATURE_LIMIT = 50000;
const WSOL = "So11111111111111111111111111111111111111112";
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
]);

const mintSafetyCache = new Map();
const dexOrdersCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inFlightSignatures = new Set();

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendEvent(event) {
  await fs.appendFile(EVENTS_PATH, `${JSON.stringify(event)}\n`);
}

function isRunningPid(pid) {
  if (!pid || Number(pid) === process.pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireBotLock() {
  const existing = await readJson(BOT_LOCK_PATH, null);
  if (existing?.pid && isRunningPid(existing.pid)) {
    console.error(`another bot.mjs instance is already running pid=${existing.pid}; exiting`);
    process.exit(0);
  }
  await fs.writeFile(BOT_LOCK_PATH, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: "w" });
  const release = async () => {
    const lock = await readJson(BOT_LOCK_PATH, null);
    if (Number(lock?.pid) === process.pid) await fs.rm(BOT_LOCK_PATH, { force: true }).catch(() => {});
  };
  process.once("exit", () => {
    try {
      fs.rm(BOT_LOCK_PATH, { force: true });
    } catch {}
  });
  process.once("SIGINT", async () => { await release(); process.exit(0); });
  process.once("SIGTERM", async () => { await release(); process.exit(0); });
}

async function hydrateProcessedSignaturesFromEvents(state) {
  const text = await fs.readFile(EVENTS_PATH, "utf8").catch(() => "");
  const signatures = [];
  for (const line of text.trim().split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.signature) signatures.push(event.signature);
    } catch {
      // Ignore corrupt historical log lines.
    }
  }
  state.processedSignatures = [...new Set([...(state.processedSignatures || []), ...signatures])].slice(-PROCESSED_SIGNATURE_LIMIT);
  return signatures.length;
}

function trimProcessedSignatures(state) {
  state.processedSignatures ||= [];
  state.processedSignatures = [...new Set(state.processedSignatures)].slice(-PROCESSED_SIGNATURE_LIMIT);
}

function rememberProcessedSignature(state, signature) {
  if (!signature) return false;
  state.processedSignatures ||= [];
  if (state.processedSignatures.includes(signature)) return false;
  state.processedSignatures.push(signature);
  if (state.processedSignatures.length > PROCESSED_SIGNATURE_LIMIT) {
    state.processedSignatures = state.processedSignatures.slice(-PROCESSED_SIGNATURE_LIMIT);
  }
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

function fmtTry(value) {
  return `${value.toFixed(2)} TL`;
}

function pct(from, to) {
  if (!from || !to) return 0;
  return ((to - from) / from) * 100;
}

async function rpcCall(config, method, params) {
  const response = await fetch(config.rpcHttp, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getWalletTokenAmount(config, walletAddress, mint) {
  const result = await rpcCall(config, "getTokenAccountsByOwner", [
    walletAddress,
    { mint },
    { encoding: "jsonParsed" }
  ]).catch(() => null);
  return (result?.value || []).reduce((sum, item) => {
    const amount = item.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    return sum + Number(amount || 0);
  }, 0);
}

async function getClusterTokenAmount(config, wallet, mint) {
  const addresses = [wallet.address, ...(wallet.relatedAddresses || [])];
  const amounts = await Promise.all(addresses.map((address) => getWalletTokenAmount(config, address, mint)));
  return amounts.reduce((sum, amount) => sum + amount, 0);
}

async function getTransaction(config, signature) {
  return rpcCall(config, "getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  ]);
}

async function getMintSafety(config, mint) {
  const cached = mintSafetyCache.get(mint);
  if (cached && Date.now() - cached.at < (config.mintSafetyCacheMs ?? 5 * 60 * 1000)) return cached.value;

  const [account, supply, largest] = await Promise.all([
    rpcCall(config, "getParsedAccountInfo", [mint, { commitment: "confirmed" }]).catch(() => null),
    rpcCall(config, "getTokenSupply", [mint, { commitment: "confirmed" }]).catch(() => null),
    rpcCall(config, "getTokenLargestAccounts", [mint, { commitment: "confirmed" }]).catch(() => null)
  ]);

  const info = account?.value?.data?.parsed?.info || {};
  const supplyAmount = Number(supply?.value?.uiAmountString || supply?.value?.uiAmount || 0);
  const accounts = largest?.value || [];
  const amounts = accounts.map((item) => Number(item.uiAmountString || item.uiAmount || 0)).filter(Number.isFinite);
  const top1Pct = supplyAmount > 0 && amounts[0] ? (amounts[0] / supplyAmount) * 100 : null;
  const top10Pct = supplyAmount > 0 ? (amounts.slice(0, 10).reduce((sum, amount) => sum + amount, 0) / supplyAmount) * 100 : null;
  const value = {
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    supply: supplyAmount,
    top1Pct,
    top10Pct
  };
  mintSafetyCache.set(mint, { at: Date.now(), value });
  return value;
}

async function getDexPaidOrders(mint) {
  const cached = dexOrdersCache.get(mint);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  const response = await fetch(`https://api.dexscreener.com/orders/v1/solana/${mint}`).catch(() => null);
  const value = response?.ok ? await response.json().catch(() => []) : [];
  dexOrdersCache.set(mint, { at: Date.now(), value: Array.isArray(value) ? value : [] });
  return Array.isArray(value) ? value : [];
}

async function getTokenPriceUsd(mint) {
  const direct = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
  const directJson = direct?.ok ? await direct.json().catch(() => null) : null;
  let pairs = directJson?.pairs || [];

  if (!pairs.length) {
    const search = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(mint)}`).catch(() => null);
    const searchJson = search?.ok ? await search.json().catch(() => null) : null;
    pairs = searchJson?.pairs || [];
  }

  pairs = pairs
    .filter((pair) => pair.chainId === "solana" && Number(pair.priceUsd) > 0)
    .sort((a, b) => {
      const aExact = a.baseToken?.address === mint ? 1 : 0;
      const bExact = b.baseToken?.address === mint ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
    });
  const pair = pairs[0];
  if (!pair) return null;
  return {
    usd: Number(pair.priceUsd),
    symbol: pair.baseToken?.symbol || mint.slice(0, 6),
    url: pair.url,
    liquidityUsd: pair.liquidity?.usd ?? null,
    marketCap: pair.marketCap ?? null,
    volume24h: pair.volume?.h24 ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null,
    txns5m: Number(pair.txns?.m5?.buys || 0) + Number(pair.txns?.m5?.sells || 0),
    txns1h: Number(pair.txns?.h1?.buys || 0) + Number(pair.txns?.h1?.sells || 0),
    priceChange5m: pair.priceChange?.m5 ?? null,
    priceChange1h: pair.priceChange?.h1 ?? null,
    boostsActive: pair.boosts?.active ?? 0
  };
}

function inferTokenPriceFromSignal(config, signal) {
  if ((config.inferNoPriceFromSol ?? true) === false) return null;
  if (!signal?.tokenDelta || !signal?.solDelta) return null;

  const tokenAmount = Math.abs(Number(signal.tokenDelta));
  const solAmount = Math.abs(Number(signal.solDelta));
  if (!Number.isFinite(tokenAmount) || !Number.isFinite(solAmount) || tokenAmount <= 0) return null;
  if (solAmount < (config.minSolForInferredPrice ?? 0.003)) return null;

  return {
    usd: solAmount / tokenAmount,
    symbol: signal.mint?.slice(0, 6) || "TOKEN",
    url: null,
    liquidityUsd: null,
    marketCap: null,
    volume24h: null,
    inferred: true
  };
}

function inferredPriceRiskAllowed(position) {
  return !position.tokenMeta?.inferredPrice;
}

async function notify(config, message) {
  console.log(message);
  if (!config.telegram?.enabled) return;
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true })
    });
  } catch (error) {
    console.error("Telegram notify failed:", error.message);
  }
}

function initialState(config) {
  return {
    startedAt: nowIso(),
    cashTry: config.startingTry,
    realizedTry: 0,
    positions: [],
    processedSignatures: [],
    stats: {},
    pendingPriceSignals: [],
    risk: {
      walletLastBuyAt: {},
      tokenLastBuyAt: {},
      walletBuySignals: {},
      tokenBuySignals: {},
      tokenSellSignals: {},
      tokenBlocklist: {},
      dailyGuard: {},
      autoDemoted: {},
      globalPerformance: {},
      walletPerformance: {}
    }
  };
}

function ensureRiskState(state) {
  state.risk ||= {};
  state.risk.walletLastBuyAt ||= {};
  state.risk.tokenLastBuyAt ||= {};
  state.risk.walletBuySignals ||= {};
  state.risk.tokenBuySignals ||= {};
  state.risk.tokenSellSignals ||= {};
  state.risk.tokenBlocklist ||= {};
  state.risk.dailyGuard ||= {};
  state.risk.autoDemoted ||= {};
  state.risk.globalPerformance ||= {};
  state.risk.walletPerformance ||= {};
  return state.risk;
}

function ensurePendingSignals(state) {
  state.pendingPriceSignals ||= [];
  return state.pendingPriceSignals;
}

function queuePendingPriceSignal(config, state, signal, priceSymbol = null) {
  const queue = ensurePendingSignals(state);
  if (signal.type !== "BUY") return { skipped: "price not needed" };
  if (queue.some((item) => item.signature === signal.signature && item.mint === signal.mint && item.wallet === signal.wallet)) {
    return { skipped: "price pending" };
  }
  const now = Date.now();
  const maxAgeMs = (config.noPriceRetryMaxAgeSec ?? 180) * 1000;
  queue.push({
    queuedAt: nowIso(),
    nextRetryAt: new Date(now + (config.noPriceRetryDelaySec ?? 30) * 1000).toISOString(),
    expiresAt: new Date(now + maxAgeMs).toISOString(),
    attempts: 0,
    signal: { ...signal },
    symbol: priceSymbol || signal.mint.slice(0, 6)
  });
  state.pendingPriceSignals = queue.slice(-(config.noPriceRetryQueueLimit ?? 80));
  return { skipped: "price pending" };
}

function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function openCount(state, predicate) {
  return state.positions.filter(predicate).length;
}

function walletPerformance(state, wallet) {
  const risk = ensureRiskState(state);
  risk.walletPerformance[wallet] ||= {
    closed: 0,
    wins: 0,
    losses: 0,
    realizedTry: 0,
    lastLossAt: null,
    blockedUntil: null
  };
  return risk.walletPerformance[wallet];
}

function rememberBuySignal(config, state, wallet) {
  const risk = ensureRiskState(state);
  const now = Date.now();
  const windowMs = (config.walletSignalWindowSec ?? 60) * 1000;
  const list = (risk.walletBuySignals[wallet] || []).filter((time) => now - time < windowMs);
  list.push(now);
  risk.walletBuySignals[wallet] = list;
  return list.length;
}

function rememberTokenConfirmSignal(config, state, signal) {
  const risk = ensureRiskState(state);
  const now = Date.now();
  const windowMs = (config.confirmWindowMin ?? 10) * 60000;
  const id = `${signal.wallet}:${signal.signature || signal.mint}:${signal.type}`;
  const list = (risk.tokenBuySignals[signal.mint] || [])
    .filter((item) => now - Number(item.time || 0) < windowMs)
    .filter((item, index, items) => index === items.findIndex((other) => other.id === item.id));

  if (!list.some((item) => item.id === id)) {
    list.push({ id, wallet: signal.wallet, time: now });
  }

  risk.tokenBuySignals[signal.mint] = list;
  const uniqueWallets = new Set(list.map((item) => item.wallet));
  return {
    uniqueWallets: uniqueWallets.size,
    required: config.confirmMinWallets ?? 2,
    windowMin: config.confirmWindowMin ?? 10,
    wallets: [...uniqueWallets]
  };
}

function rememberTokenSellSignal(config, state, signal) {
  const risk = ensureRiskState(state);
  const now = Date.now();
  const windowMs = (config.sellPressureWindowMin ?? 12) * 60000;
  const id = `${signal.wallet}:${signal.signature || signal.mint}:${signal.type}:${now}`;
  const list = (risk.tokenSellSignals[signal.mint] || [])
    .filter((item) => now - Number(item.time || 0) < windowMs)
    .filter((item, index, items) => index === items.findIndex((other) => other.id === item.id));
  list.push({ id, wallet: signal.wallet, time: now });
  risk.tokenSellSignals[signal.mint] = list;
  return list;
}

function tokenPressure(config, state, mint) {
  const risk = ensureRiskState(state);
  const now = Date.now();
  const buyWindowMs = (config.confirmWindowMin ?? 10) * 60000;
  const sellWindowMs = (config.sellPressureWindowMin ?? 12) * 60000;
  const buys = (risk.tokenBuySignals[mint] || []).filter((item) => now - Number(item.time || 0) < buyWindowMs);
  const sells = (risk.tokenSellSignals[mint] || []).filter((item) => now - Number(item.time || 0) < sellWindowMs);
  risk.tokenBuySignals[mint] = buys;
  risk.tokenSellSignals[mint] = sells;
  const buyWallets = new Set(buys.map((item) => item.wallet));
  const sellWallets = new Set(sells.map((item) => item.wallet));
  return {
    buyEvents: buys.length,
    sellEvents: sells.length,
    uniqueBuyers: buyWallets.size,
    uniqueSellers: sellWallets.size,
    buyWallets: [...buyWallets],
    sellWallets: [...sellWallets]
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function updateDailyGuard(config, state, equityTry) {
  const risk = ensureRiskState(state);
  const key = todayKey();
  if (risk.dailyGuard.date !== key) {
    risk.dailyGuard = {
      date: key,
      peakTry: equityTry,
      lowTry: equityTry,
      blockedUntil: null,
      lastEquityTry: equityTry
    };
  }

  risk.dailyGuard.peakTry = Math.max(Number(risk.dailyGuard.peakTry || equityTry), equityTry);
  risk.dailyGuard.lowTry = Math.min(Number(risk.dailyGuard.lowTry || equityTry), equityTry);
  risk.dailyGuard.lastEquityTry = equityTry;

  const dropTry = risk.dailyGuard.peakTry - equityTry;
  const dropPct = risk.dailyGuard.peakTry ? (dropTry / risk.dailyGuard.peakTry) * 100 : 0;
  const maxDropTry = config.maxDailyDrawdownTry ?? 0;
  const maxDropPct = config.maxDailyDrawdownPct ?? 0;
  const shouldBlock =
    (maxDropTry > 0 && dropTry >= maxDropTry) ||
    (maxDropPct > 0 && dropPct >= maxDropPct);

  if (shouldBlock) {
    const until = Date.now() + (config.dailyDrawdownCooldownMin ?? 60) * 60000;
    risk.dailyGuard.blockedUntil = new Date(until).toISOString();
    risk.dailyGuard.blockReason = `daily drawdown ${fmtTry(dropTry)} (${dropPct.toFixed(1)}%)`;
  }
  return risk.dailyGuard;
}

function tokenQualityGate(config, price) {
  const reasons = [];
  if ((config.rejectNoLiquidity ?? false) && !Number(price.liquidityUsd || 0)) {
    reasons.push("liquidity unknown");
  }
  const minLiquidityUsd = config.minLiquidityUsd ?? 0;
  if (minLiquidityUsd > 0 && Number(price.liquidityUsd || 0) > 0 && Number(price.liquidityUsd) < minLiquidityUsd) {
    reasons.push(`liquidity low $${Math.round(price.liquidityUsd)} < $${Math.round(minLiquidityUsd)}`);
  }
  const minVolume24hUsd = config.minVolume24hUsd ?? 0;
  if (minVolume24hUsd > 0 && Number(price.volume24h || 0) > 0 && Number(price.volume24h) < minVolume24hUsd) {
    reasons.push(`volume low $${Math.round(price.volume24h)} < $${Math.round(minVolume24hUsd)}`);
  }
  if ((config.minPairAgeSec ?? 0) > 0 && price.pairCreatedAt) {
    const ageSec = (Date.now() - Number(price.pairCreatedAt)) / 1000;
    if (ageSec < config.minPairAgeSec) reasons.push(`pair too new ${Math.round(ageSec)}s < ${config.minPairAgeSec}s`);
  }
  if ((config.maxPairAgeHours ?? 0) > 0 && price.pairCreatedAt) {
    const ageHours = (Date.now() - Number(price.pairCreatedAt)) / 3600000;
    if (ageHours > config.maxPairAgeHours) reasons.push(`pair too old ${ageHours.toFixed(1)}h > ${config.maxPairAgeHours}h`);
  }
  if ((config.minTxns5m ?? 0) > 0 && Number(price.txns5m || 0) < config.minTxns5m) {
    reasons.push(`5m tx low ${price.txns5m || 0} < ${config.minTxns5m}`);
  }
  return reasons.length ? reasons.join(" + ") : null;
}

async function tokenSafetyGate(config, mint) {
  if ((config.authorityRiskGate ?? false) === false) return null;
  const safety = await getMintSafety(config, mint);
  const reasons = [];
  if ((config.rejectMintAuthority ?? true) && safety.mintAuthority) reasons.push("mint authority active");
  if ((config.rejectFreezeAuthority ?? true) && safety.freezeAuthority) reasons.push("freeze authority active");
  if ((config.maxTopHolderPct ?? 0) > 0 && safety.top1Pct !== null && safety.top1Pct > config.maxTopHolderPct) {
    reasons.push(`top holder ${safety.top1Pct.toFixed(1)}% > ${config.maxTopHolderPct}%`);
  }
  if ((config.maxTop10HolderPct ?? 0) > 0 && safety.top10Pct !== null && safety.top10Pct > config.maxTop10HolderPct) {
    reasons.push(`top10 holders ${safety.top10Pct.toFixed(1)}% > ${config.maxTop10HolderPct}%`);
  }
  return reasons.length ? { skipped: reasons.join(" + "), safety } : { safety };
}

async function paidHypeGate(config, mint) {
  if ((config.rejectPaidDexOrders ?? false) === false) return null;
  const orders = await getDexPaidOrders(mint);
  const active = orders.filter((item) => ["processing", "approved", "on-hold"].includes(item.status));
  const risky = active.filter((item) => ["tokenAd", "trendingBarAd"].includes(item.type));
  if (!risky.length) return { orders };
  return {
    skipped: `paid hype ${risky.map((item) => item.type).join(",")}`,
    orders
  };
}

function updateGlobalAfterClose(config, state, position, pnlTry) {
  const risk = ensureRiskState(state);
  const global = risk.globalPerformance;
  global.closed = (global.closed || 0) + 1;
  global.realizedTry = Number(global.realizedTry || 0) + Number(pnlTry || 0);
  global.lastClosedAt = nowIso();
  if (pnlTry > 0) {
    global.wins = (global.wins || 0) + 1;
    global.consecutiveLosses = 0;
  } else {
    global.losses = (global.losses || 0) + 1;
    global.consecutiveLosses = (global.consecutiveLosses || 0) + 1;
  }

  if (
    (config.globalLossBrake ?? false) &&
    (config.maxConsecutiveLosses ?? 0) > 0 &&
    global.consecutiveLosses >= (config.maxConsecutiveLosses ?? 3)
  ) {
    global.blockedUntil = new Date(Date.now() + (config.globalLossBrakeCooldownMin ?? 90) * 60000).toISOString();
    global.blockReason = `consecutive losses ${global.consecutiveLosses}`;
  }

  const lossBlockTry = config.tokenLossBlockTry ?? 0;
  if (pnlTry <= -Math.abs(lossBlockTry) && lossBlockTry > 0 && position?.mint) {
    risk.tokenBlocklist[position.mint] = {
      blockedUntil: new Date(Date.now() + (config.tokenLossBlockMin ?? 240) * 60000).toISOString(),
      reason: `last paper loss ${fmtTry(pnlTry)}`
    };
  }
}

function dynamicLotDecision(config, state, signal, price, baseTradeTry) {
  const sourceSol = Math.abs(Number(signal.solDelta || 0));
  if ((config.sourceSizeGateEnabled ?? false) && sourceSol > 0) {
    const minSourceSol = config.minSourceBuySol ?? 0;
    const maxSourceSol = config.maxSourceBuySol ?? 0;
    if (minSourceSol > 0 && sourceSol < minSourceSol) {
      return {
        blocked: `source buy too small ${sourceSol.toFixed(4)} SOL < ${minSourceSol} SOL`,
        tradeTry: baseTradeTry,
        score: null,
        multiplier: 1,
        notes: []
      };
    }
    if (maxSourceSol > 0 && sourceSol > maxSourceSol) {
      return {
        blocked: `source buy too large ${sourceSol.toFixed(2)} SOL > ${maxSourceSol} SOL`,
        tradeTry: baseTradeTry,
        score: null,
        multiplier: 1,
        notes: []
      };
    }
  }

  if ((config.dynamicLotSizing ?? false) === false) {
    return { tradeTry: baseTradeTry, score: null, multiplier: 1, notes: [] };
  }

  const perf = walletPerformance(state, signal.wallet);
  const winRate = perf.closed ? (perf.wins / perf.closed) * 100 : null;
  const pressure = tokenPressure(config, state, signal.mint);
  const liquidity = Number(price.liquidityUsd || 0);
  const volume = Number(price.volume24h || 0);
  const walletScore = Number(signal.score || 50);

  let score = 45;
  score += Math.min(18, Math.max(-14, (walletScore - 55) / 1.8));
  if (winRate !== null) score += Math.min(16, Math.max(-18, (winRate - 45) / 2));
  score += Math.min(18, Math.max(0, Number(perf.realizedTry || 0) / 25));
  score -= Math.min(18, Math.max(0, -Number(perf.realizedTry || 0) / 20));
  score += Math.min(20, Math.max(0, (pressure.uniqueBuyers - 1) * 12));
  score -= Math.min(24, pressure.uniqueSellers * 12);
  score += liquidity >= (config.strongLiquidityUsd ?? 15000) ? 10 : liquidity >= (config.minLiquidityUsd ?? 0) ? 4 : -8;
  score += volume >= (config.strongVolume24hUsd ?? 75000) ? 8 : volume >= (config.minVolume24hUsd ?? 0) ? 3 : -6;
  if (signal.sourceType === "TRANSFER_IN") score -= 6;
  if (signal.moonshot) score += 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const minLot = config.dynamicMinTradeTry ?? Math.min(baseTradeTry, 50);
  const maxLot = config.dynamicMaxTradeTry ?? Math.max(baseTradeTry, config.highConfidenceTradeTry ?? baseTradeTry);
  const multiplier =
    score >= 82 ? (config.dynamicMaxMultiplier ?? 1.8) :
    score >= 68 ? 1.35 :
    score >= 52 ? 1 :
    score >= 38 ? 0.65 :
    0.35;
  const sourceScaledTry =
    (config.sourceScaleEnabled ?? false) && sourceSol > 0
      ? sourceSol * (config.tryPerSol || 4350) * (config.sourceScalePct ?? 0.2)
      : null;
  const rawTradeTry = sourceScaledTry !== null
    ? (baseTradeTry * 0.35 + sourceScaledTry * 0.65) * multiplier
    : baseTradeTry * multiplier;
  const tradeTry = Math.max(minLot, Math.min(maxLot, Math.round(rawTradeTry)));
  const notes = [
    `dinamik skor ${score}`,
    `x${multiplier}`,
    sourceSol > 0 ? `kaynak ${sourceSol.toFixed(4)} SOL` : null,
    sourceScaledTry !== null ? `source-scale ${fmtTry(sourceScaledTry)}` : null,
    winRate !== null ? `wallet WR ${winRate.toFixed(0)}%` : "wallet WR yok",
    `alici ${pressure.uniqueBuyers}`,
    `satici ${pressure.uniqueSellers}`
  ].filter(Boolean);
  return { tradeTry, score, multiplier, notes };
}

function riskGate(config, state, signal) {
  const risk = ensureRiskState(state);
  const wallet = signal.wallet;
  const perf = walletPerformance(state, wallet);
  const now = Date.now();
  const manualOverrideUntil = signal.manualOverrideUntil ? new Date(signal.manualOverrideUntil).getTime() : 0;
  const manualOverrideActive = Number.isFinite(manualOverrideUntil) && manualOverrideUntil > now;
  const reasons = [];

  const dailyGuard = risk.dailyGuard || {};
  if (dailyGuard.blockedUntil && now < new Date(dailyGuard.blockedUntil).getTime()) {
    reasons.push(`daily guard ${dailyGuard.blockedUntil.slice(11, 16)} (${dailyGuard.blockReason || "drawdown"})`);
  }

  const global = risk.globalPerformance || {};
  if (global.blockedUntil && now < new Date(global.blockedUntil).getTime()) {
    reasons.push(`global loss brake ${global.blockedUntil.slice(11, 16)} (${global.blockReason || "loss streak"})`);
  }

  const blockedToken = risk.tokenBlocklist?.[signal.mint];
  if (blockedToken?.blockedUntil && now < new Date(blockedToken.blockedUntil).getTime()) {
    reasons.push(`token memory block (${blockedToken.reason})`);
  }

  if (state.positions.length >= config.maxOpenPositions) {
    reasons.push(`max open positions (${config.maxOpenPositions})`);
  }

  const maxMoonshot = config.maxMoonshotOpenPositions ?? Math.ceil((config.maxOpenPositions ?? 6) / 2);
  const maxCore = config.maxCoreOpenPositions ?? Math.max(1, (config.maxOpenPositions ?? 6) - maxMoonshot);
  if (signal.moonshot && openCount(state, (p) => p.moonshot) >= maxMoonshot) {
    reasons.push(`moonshot slot full (${maxMoonshot})`);
  }
  if (!signal.moonshot && openCount(state, (p) => !p.moonshot) >= maxCore) {
    reasons.push(`core slot full (${maxCore})`);
  }

  const maxOpenPerWallet = config.maxOpenPerWallet ?? 2;
  if (openCount(state, (p) => p.wallet === wallet) >= maxOpenPerWallet) {
    reasons.push(`wallet open limit (${maxOpenPerWallet})`);
  }

  if (state.positions.some((position) => position.mint === signal.mint)) {
    reasons.push("position already open");
  }

  const walletCooldownSec = config.walletCooldownSec ?? 180;
  const lastWalletBuyAt = risk.walletLastBuyAt[wallet];
  if (lastWalletBuyAt && now - new Date(lastWalletBuyAt).getTime() < walletCooldownSec * 1000) {
    reasons.push(`wallet cooldown ${walletCooldownSec}s`);
  }

  const tokenCooldownMin = config.tokenCooldownMin ?? 60;
  const lastTokenBuyAt = risk.tokenLastBuyAt[signal.mint];
  if (lastTokenBuyAt && minutesSince(lastTokenBuyAt) < tokenCooldownMin) {
    reasons.push(`token cooldown ${tokenCooldownMin}m`);
  }

  const burstCount = rememberBuySignal(config, state, wallet);
  const maxBurst = config.maxWalletBuySignalsPerMinute ?? 8;
  if (burstCount > maxBurst) {
    reasons.push(`wallet too noisy (${burstCount}/min)`);
  }

  if (config.requireMultiWalletConfirm ?? false) {
    const confirmation = rememberTokenConfirmSignal(config, state, signal);
    if (confirmation.uniqueWallets < confirmation.required) {
      const scoutMode = config.singleWalletScoutMode ?? true;
      const scoutMinScore = config.singleWalletScoutMinScore ?? 78;
      const scoutClasses = new Set(config.singleWalletScoutClasses || ["AG", "A"]);
      const allowScout =
        scoutMode &&
        confirmation.uniqueWallets >= 1 &&
        (Number(signal.score || 0) >= scoutMinScore || scoutClasses.has(signal.class || "")) &&
        signal.sourceType !== "TRANSFER_IN";
      if (allowScout) {
        signal.scoutConfirmBypass = true;
        signal.scoutConfirmNote = `single-wallet scout: ${confirmation.uniqueWallets}/${confirmation.required} confirm, score ${signal.score || "-"}, class ${signal.class || "-"}`;
      } else {
        reasons.push(`needs ${confirmation.required} wallet confirm (${confirmation.uniqueWallets}/${confirmation.required}, ${confirmation.windowMin}m)`);
      }
    }
  }

  if (config.vetoBuyOnSellPressure ?? false) {
    const pressure = tokenPressure(config, state, signal.mint);
    const minSellers = config.sellPressureMinSellers ?? 2;
    const ratio = config.sellPressureVetoRatio ?? 1;
    if (
      pressure.uniqueSellers >= minSellers &&
      pressure.uniqueSellers >= Math.max(1, pressure.uniqueBuyers) * ratio
    ) {
      reasons.push(`sell pressure veto ${pressure.uniqueSellers} sellers / ${pressure.uniqueBuyers} buyers`);
    }
  }

  if (perf.blockedUntil && now < new Date(perf.blockedUntil).getTime()) {
    reasons.push(`wallet penalty until ${perf.blockedUntil.slice(11, 16)}`);
  }

  const minClosed = config.minClosedTradesForPenalty ?? 3;
  const winRate = perf.closed ? (perf.wins / perf.closed) * 100 : null;
  if (
    perf.closed >= minClosed &&
    winRate !== null &&
    winRate < (config.penaltyWinRatePct ?? 35) &&
    perf.realizedTry <= (config.penaltyRealizedTry ?? -50)
  ) {
    const cooldownMin = config.walletPenaltyCooldownMin ?? 30;
    perf.blockedUntil = new Date(now + cooldownMin * 60000).toISOString();
    reasons.push(`wallet penalty WR ${winRate.toFixed(0)}%`);
  }

  if ((config.autoDemoteLosers ?? false) && !manualOverrideActive) {
    const demoteMinClosed = config.autoDemoteMinClosed ?? 3;
    const demoteWr = config.autoDemoteWinRatePct ?? 30;
    const demoteRealizedTry = config.autoDemoteRealizedTry ?? -150;
    if (
      perf.closed >= demoteMinClosed &&
      winRate !== null &&
      winRate < demoteWr &&
      perf.realizedTry <= demoteRealizedTry
    ) {
      const cooldownMin = config.autoDemoteCooldownMin ?? 180;
      const blockedUntil = new Date(now + cooldownMin * 60000).toISOString();
      risk.autoDemoted[wallet] = {
        at: nowIso(),
        blockedUntil,
        reason: `auto demote WR ${winRate.toFixed(0)}%, pnl ${fmtTry(perf.realizedTry)}`
      };
    }
  }

  const demoted = risk.autoDemoted?.[wallet];
  if (!manualOverrideActive && demoted?.blockedUntil && now < new Date(demoted.blockedUntil).getTime()) {
    reasons.push(`auto demoted (${demoted.reason})`);
  }

  return reasons.length ? reasons.join(" + ") : null;
}

function walletByAddress(config) {
  const map = new Map();
  const deny = new Set((config.copyDenylist || []).map((item) => String(item).trim()).filter(Boolean));
  for (const wallet of config.wallets || []) {
    if (wallet.mode === "off" || wallet.enabled === false) continue;
    if (deny.has(wallet.name) || deny.has(wallet.address)) {
      wallet.mode = "off";
      wallet.tradeTry = 0;
      continue;
    }
    map.set(wallet.address, wallet);
    for (const address of wallet.relatedAddresses || []) map.set(address, wallet);
    for (const address of wallet.signerAddresses || []) map.set(address, wallet);
  }
  return map;
}

function applyDiscoveredRelated(config, state) {
  state.discoveredRelated ||= {};
  const autoTrackTransferTargets = config.autoTrackTransferTargets ?? false;
  const maxAutoRelatedPerWallet = config.maxAutoRelatedPerWallet ?? 8;
  for (const wallet of config.wallets || []) {
    const discovered = autoTrackTransferTargets
      ? (state.discoveredRelated[wallet.name] || []).slice(0, maxAutoRelatedPerWallet)
      : [];
    wallet.relatedAddresses = [...new Set([...(wallet.relatedAddresses || []), ...discovered])];
  }
}

function walletAddressByName(config) {
  return new Map(config.wallets.map((wallet) => [wallet.name, wallet]));
}

function uniqueWallets(wallets) {
  return [...new Set(wallets.values())];
}

function trackedAddresses(wallet) {
  return [...new Set([wallet.address, ...(wallet.relatedAddresses || []), ...(wallet.signerAddresses || [])])];
}

function tokenBalancesByOwner(balances, owner) {
  const map = new Map();
  for (const balance of balances || []) {
    if (balance.owner !== owner || balance.mint === WSOL) continue;
    map.set(balance.mint, Number(balance.uiTokenAmount?.uiAmountString || 0));
  }
  return map;
}

function tokenOwnersByMint(balances, mint) {
  const out = new Map();
  for (const balance of balances || []) {
    if (balance.mint !== mint || !balance.owner) continue;
    out.set(balance.owner, Number(balance.uiTokenAmount?.uiAmountString || 0));
  }
  return out;
}

function stableDeltaForOwner(tx, owner) {
  const pre = tokenBalancesByOwner(tx.meta.preTokenBalances, owner);
  const post = tokenBalancesByOwner(tx.meta.postTokenBalances, owner);
  let delta = 0;
  for (const mint of STABLE_MINTS) {
    delta += (post.get(mint) || 0) - (pre.get(mint) || 0);
  }
  return delta;
}

function solDeltaForOwner(tx, owner) {
  const keys = tx.transaction.message.accountKeys.map((key) =>
    typeof key === "string" ? { pubkey: key } : key
  );
  const index = keys.findIndex((key) => key.pubkey === owner);
  if (index < 0) return null;
  return (tx.meta.postBalances[index] - tx.meta.preBalances[index]) / 1e9;
}

function extractWalletEvents(tx, wallet) {
  const owners = [wallet.address, ...(wallet.relatedAddresses || [])];
  const events = [];

  for (const owner of owners) {
    const pre = tokenBalancesByOwner(tx.meta.preTokenBalances, owner);
    const post = tokenBalancesByOwner(tx.meta.postTokenBalances, owner);
    const mints = new Set([...pre.keys(), ...post.keys()]);
    const solDelta = solDeltaForOwner(tx, owner) || 0;
    const stableDelta = stableDeltaForOwner(tx, owner);

    for (const mint of mints) {
      if (STABLE_MINTS.has(mint)) continue;
      const delta = (post.get(mint) || 0) - (pre.get(mint) || 0);
      if (Math.abs(delta) <= 0) continue;

      const isBuy = delta > 0 && (solDelta < -0.003 || stableDelta < -1);
      const isSell = delta < 0 && (solDelta > 0.003 || stableDelta > 1);
      if (!isBuy && !isSell) {
        const event = {
          type: delta > 0 ? "TRANSFER_IN" : "TRANSFER_OUT",
          wallet: wallet.name,
          walletAddress: wallet.address,
          ownerAddress: owner,
          mint,
          tokenDelta: delta,
          solDelta,
          stableDelta
        };
        if (event.type === "TRANSFER_OUT") {
          const preOwners = tokenOwnersByMint(tx.meta.preTokenBalances, mint);
          const postOwners = tokenOwnersByMint(tx.meta.postTokenBalances, mint);
          for (const [candidateOwner, postAmount] of postOwners) {
            if (owners.includes(candidateOwner) || candidateOwner === owner) continue;
            const candidateDelta = postAmount - (preOwners.get(candidateOwner) || 0);
            if (candidateDelta > Math.abs(delta) * 0.25) {
              event.transferTarget = candidateOwner;
              break;
            }
          }
        }
        events.push(event);
        continue;
      }

      events.push({
        type: isBuy ? "BUY" : "SELL",
        wallet: wallet.name,
        walletAddress: wallet.address,
        ownerAddress: owner,
        mint,
        tokenDelta: delta,
        solDelta,
        stableDelta
      });
    }
  }

  return events;
}

function ensureDiscoveredRelated(state, walletName) {
  state.discoveredRelated ||= {};
  state.discoveredRelated[walletName] ||= [];
  return state.discoveredRelated[walletName];
}

function addDiscoveredRelated(config, state, wallet, address) {
  if ((config.autoTrackTransferTargets ?? false) === false) return false;
  if (!address || address === wallet.address) return false;
  if ((wallet.relatedAddresses || []).includes(address)) return false;
  if ((wallet.signerAddresses || []).includes(address)) return false;
  const list = ensureDiscoveredRelated(state, wallet.name);
  if (list.length >= (config.maxAutoRelatedPerWallet ?? 8)) return false;
  if (list.includes(address)) return false;
  list.push(address);
  return true;
}

async function paperBuy(config, state, signal, price) {
  if (price.inferred) {
    return { skipped: "inferred price watch only" };
  }

  const maxMarketCapUsd = config.maxBuyMarketCapUsd ?? null;
  if (maxMarketCapUsd && price.marketCap && Number(price.marketCap) > maxMarketCapUsd) {
    return { skipped: `mcap too high $${Math.round(price.marketCap).toLocaleString("en-US")} > $${Math.round(maxMarketCapUsd).toLocaleString("en-US")}`, gate: "risk" };
  }

  const qualityBlocked = tokenQualityGate(config, price);
  if (qualityBlocked) return { skipped: qualityBlocked, gate: "quality" };

  const safetyGate = await tokenSafetyGate(config, signal.mint);
  if (safetyGate?.skipped) return { skipped: safetyGate.skipped, gate: "safety", safety: safetyGate.safety };

  const paidGate = await paidHypeGate(config, signal.mint);
  if (paidGate?.skipped) return { skipped: paidGate.skipped, gate: "hype", orders: paidGate.orders };

  const blocked = riskGate(config, state, signal);
  if (blocked) return { skipped: blocked, gate: "risk" };

  const requestedTradeTry =
    signal.tradeTry || (signal.confidence === "high" ? config.highConfidenceTradeTry : config.normalTradeTry);
  const baseTradeTry = signal.scoutConfirmBypass
    ? Math.min(requestedTradeTry, config.singleWalletScoutTradeTry ?? config.dynamicMinTradeTry ?? 40)
    : requestedTradeTry;
  const lotDecision = dynamicLotDecision(config, state, signal, price, baseTradeTry);
  if (lotDecision.blocked) return { skipped: lotDecision.blocked, gate: "source-size" };
  const tradeTry = lotDecision.tradeTry;
  if (state.cashTry < tradeTry) return { skipped: "not enough paper cash" };

  const spotTry = price.usd * config.tryPerSol;
  const buyCostPct = (config.buySlippagePct ?? config.feeHaircutPct ?? 2) + (config.platformFeePct ?? 0);
  const entryTry = spotTry * (1 + buyCostPct / 100);
  const priorityFeeTry = config.priorityFeeTry ?? 0;
  const effectiveTry = Math.max(0, tradeTry - priorityFeeTry);
  const amount = effectiveTry / entryTry;
  const position = {
    id: `${Date.now()}-${signal.mint}`,
    openedAt: nowIso(),
    wallet: signal.wallet,
    walletAddress: signal.walletAddress,
    ownerAddress: signal.ownerAddress || signal.walletAddress,
    mint: signal.mint,
    symbol: price.symbol,
    entryTry,
    spotEntryTry: spotTry,
    amount,
    investedTry: tradeTry,
    priorityFeeTry,
    buyCostPct,
    sellCostPct: (config.sellSlippagePct ?? config.feeHaircutPct ?? 2) + (config.platformFeePct ?? 0),
    highestTry: entryTry,
    profitLockDone: false,
    tp1Done: false,
    tp2Done: false,
    url: price.url,
    walletClass: signal.class || "B",
    walletScore: signal.score ?? null,
    moonshot: Boolean(signal.moonshot),
    buyReason: [
      signal.ownerAddress && signal.ownerAddress !== signal.walletAddress ? `iliski adresi ${signal.ownerAddress.slice(0, 6)}...${signal.ownerAddress.slice(-4)}` : null,
      `${signal.wallet} cüzdanı alım yaptı`,
      `sınıf ${signal.class || "B"}`,
      signal.sourceType === "TRANSFER_IN" ? "transfer-in accumulation sinyali" : null,
      signal.moonshot ? "moonshot runner modu" : null,
      signal.scoutConfirmBypass ? signal.scoutConfirmNote || "tek guclu sinyal scout modu" : null,
      `lot ${fmtTry(tradeTry)}`,
      lotDecision.score !== null ? lotDecision.notes.join(" | ") : null,
      price.liquidityUsd ? `likidite $${Math.round(price.liquidityUsd).toLocaleString("en-US")}` : null,
      price.marketCap ? `mcap $${Math.round(price.marketCap).toLocaleString("en-US")}` : null,
      price.pairCreatedAt ? `pair age ${Math.round((Date.now() - Number(price.pairCreatedAt)) / 60000)}dk` : null,
      safetyGate?.safety?.top10Pct !== null && safetyGate?.safety?.top10Pct !== undefined ? `top10 ${safetyGate.safety.top10Pct.toFixed(1)}%` : null,
      price.inferred ? "fiyat SOL/token oranindan tahmini" : null
    ].filter(Boolean).join(" · "),
    tokenMeta: {
      liquidityUsd: price.liquidityUsd,
      marketCap: price.marketCap,
      volume24h: price.volume24h,
      pairCreatedAt: price.pairCreatedAt,
      txns5m: price.txns5m,
      txns1h: price.txns1h,
      priceChange5m: price.priceChange5m,
      priceChange1h: price.priceChange1h,
      boostsActive: price.boostsActive,
      safety: safetyGate?.safety || null,
      paidOrders: paidGate?.orders?.length || 0,
      inferredPrice: Boolean(price.inferred),
      dynamicLotScore: lotDecision.score,
      dynamicLotMultiplier: lotDecision.multiplier,
      baseTradeTry
    }
  };

  state.cashTry -= tradeTry;
  state.positions.push(position);
  const risk = ensureRiskState(state);
  risk.walletLastBuyAt[signal.wallet] = position.openedAt;
  risk.tokenLastBuyAt[signal.mint] = position.openedAt;
  return { position };
}

function closePosition(state, position, exitTry, reason, fraction = 1, config = {}) {
  state.exitDedupe ||= {};
  const positionKey = position.id || [position.wallet, position.mint, position.openedAt].join("|");
  const normalizedReason = String(reason || "").replace(/\s+\d+\/\d+$/, "").trim();
  const fullExit = fraction >= 0.999 || position.amount * fraction >= position.amount - 1e-12;
  const dedupeKey = [positionKey, normalizedReason, fullExit ? "full" : Number(fraction || 0).toFixed(4)].join("|");
  if (state.exitDedupe[dedupeKey]) {
    return null;
  }
  if (fullExit && state.exitDedupe[[positionKey, "FULL_CLOSED"].join("|")]) {
    return null;
  }

  const amountToSell = position.amount * fraction;
  const closedAt = nowIso();
  const sellCostPct = position.sellCostPct ?? 2;
  const priorityFeeTry = (position.priorityFeeTry || 0) * fraction;
  const proceedsTry = Math.max(0, amountToSell * exitTry * (1 - sellCostPct / 100) - priorityFeeTry);
  const costTry = position.investedTry * fraction;
  const pnlTry = proceedsTry - costTry;

  position.amount -= amountToSell;
  position.investedTry -= costTry;
  state.cashTry += proceedsTry;
  state.realizedTry += pnlTry;
  const perf = walletPerformance(state, position.wallet);
  perf.closed += 1;
  perf.realizedTry += pnlTry;
  if (pnlTry > 0) perf.wins += 1;
  else {
    perf.losses += 1;
    perf.lastLossAt = nowIso();
  }

  if (position.amount <= 1e-12 || fraction >= 0.999) {
    state.positions = state.positions.filter((item) => item.id !== position.id);
    state.exitDedupe[[positionKey, "FULL_CLOSED"].join("|")] = closedAt;
  }
  state.exitDedupe[dedupeKey] = closedAt;
  const dedupeEntries = Object.entries(state.exitDedupe).slice(-5000);
  state.exitDedupe = Object.fromEntries(dedupeEntries);

  updateGlobalAfterClose(config, state, position, pnlTry);

  state.closedTrades ||= [];
  state.closedTrades.unshift({
    time: closedAt,
    wallet: position.wallet,
    symbol: position.symbol,
    mint: position.mint,
    pnlTry,
    proceedsTry,
    reason,
    url: position.url,
    exitPriceTry: exitTry,
    entryTry: position.entryTry,
    investedTry: costTry,
    moonshot: Boolean(position.moonshot)
  });
  state.closedTrades = state.closedTrades.slice(0, 300);

  return { proceedsTry, pnlTry, reason };
}

async function paperSell(config, state, signal, price) {
  const position = state.positions.find((item) => item.mint === signal.mint);
  if (!position) return { skipped: "no open paper position" };
  if (!inferredPriceRiskAllowed(position)) {
    return { skipped: "inferred price exit disabled" };
  }
  return closePosition(state, position, price.usd * config.tryPerSol, "wallet sell", 1, config) || { skipped: "duplicate close ignored" };
}

async function applyRiskRules(config, state) {
  const walletsByName = walletAddressByName(config);
  let markedOpenValueTry = 0;
  const markedPositionIds = new Set();
  for (const position of [...state.positions]) {
    const price = await getTokenPriceUsd(position.mint);
    if (!price) continue;
    if (!inferredPriceRiskAllowed(position)) {
      position.priceGuard = "inferred entry; waiting real exit confirmation";
      continue;
    }
    const currentTry = price.usd * config.tryPerSol;
    position.highestTry = Math.max(position.highestTry, currentTry);
    const gainPct = pct(position.entryTry, currentTry);
    const trailPct = pct(position.highestTry, currentTry);

    const rules = position.moonshot
      ? {
          stopLossPct: config.moonshotStopLossPct ?? -40,
          takeProfit1Pct: config.moonshotTakeProfit1Pct ?? 200,
          takeProfit2Pct: config.moonshotTakeProfit2Pct ?? 500,
          trailingStopPct: config.moonshotTrailingStopPct ?? -45,
          tp1Fraction: config.moonshotTp1Fraction ?? 0.35,
          tp2Fraction: config.moonshotTp2Fraction ?? 0.25
        }
      : {
          stopLossPct: config.stopLossPct,
          takeProfit1Pct: config.takeProfit1Pct,
          takeProfit2Pct: config.takeProfit2Pct,
          trailingStopPct: config.trailingStopPct,
          tp1Fraction: 0.5,
          tp2Fraction: 0.5
        };

    let exit = null;
    const wallet = walletsByName.get(position.wallet);
    if (wallet && position.moonshot) {
      const heldAmount = await getClusterTokenAmount(config, wallet, position.mint);
      position.walletStillHolding = heldAmount > 0;
      position.lastHoldingCheckAt = nowIso();
      if (!position.walletStillHolding) {
        exit = closePosition(state, position, currentTry, "wallet exited", 1, config);
      }
    }

    const currentValueTry = position.amount * currentTry * (1 - (position.sellCostPct ?? 2) / 100) - (position.priorityFeeTry || 0);
    const unrealizedTry = currentValueTry - position.investedTry;
    const pressure = tokenPressure(config, state, position.mint);

    if (!exit && (config.exitOnSellPressure ?? false)) {
      const minSellers = config.exitSellPressureMinSellers ?? 2;
      const ratio = config.exitSellPressureRatio ?? 1;
      if (
        pressure.uniqueSellers >= minSellers &&
        pressure.uniqueSellers >= Math.max(1, pressure.uniqueBuyers) * ratio
      ) {
        const fraction = config.sellPressureExitFraction ?? 1;
        exit = closePosition(state, position, currentTry, `tracked sell pressure ${pressure.uniqueSellers}/${pressure.uniqueBuyers}`, fraction, config);
      }
    }

    if (!exit && !position.moonshot && !position.profitLockDone && unrealizedTry >= (config.coreProfitLockTry ?? 50)) {
      position.profitLockDone = true;
      exit = closePosition(state, position, currentTry, "core profit lock", config.coreProfitLockFraction ?? 0.5, config);
    } else if (!exit && gainPct <= rules.stopLossPct) {
      exit = closePosition(state, position, currentTry, "stop loss", 1, config);
    } else if (!exit && !position.tp1Done && gainPct >= rules.takeProfit1Pct) {
      position.tp1Done = true;
      exit = closePosition(state, position, currentTry, position.moonshot ? "moonshot tp1 cost-out" : "tp1 half", rules.tp1Fraction, config);
    } else if (!exit && !position.tp2Done && gainPct >= rules.takeProfit2Pct) {
      position.tp2Done = true;
      exit = closePosition(state, position, currentTry, position.moonshot ? "moonshot tp2 trim" : "tp2 half remainder", rules.tp2Fraction, config);
    } else if (!exit && position.tp1Done && trailPct <= rules.trailingStopPct) {
      exit = closePosition(state, position, currentTry, "trailing stop", 1, config);
    }

    if (exit) {
      await appendEvent({
        time: nowIso(),
        kind: "RISK_EXIT",
        wallet: position.wallet,
        symbol: position.symbol,
        mint: position.mint,
        url: position.url,
        priceUsd: currentTry / config.tryPerSol,
        reason: exit.reason,
        proceedsTry: exit.proceedsTry,
        pnlTry: exit.pnlTry,
        cashTry: state.cashTry,
        realizedTry: state.realizedTry
      });
      console.log(
        `[${nowIso()}] ${exit.reason.toUpperCase()} ${position.symbol} pnl=${fmtTry(exit.pnlTry)}`
      );
    } else if (state.positions.some((item) => item.id === position.id)) {
      markedOpenValueTry += currentValueTry;
      markedPositionIds.add(position.id);
    }
  }
  const unmarkedOpenCostTry = (state.positions || [])
    .filter((position) => !markedPositionIds.has(position.id))
    .reduce((sum, position) => sum + Number(position.investedTry || 0), 0);
  updateDailyGuard(config, state, Number(state.cashTry || 0) + markedOpenValueTry + unmarkedOpenCostTry);
}

async function processPendingPriceSignals(config, state) {
  const queue = ensurePendingSignals(state);
  const keep = [];
  const now = Date.now();

  for (const item of queue) {
    if (new Date(item.expiresAt).getTime() <= now) continue;
    if (new Date(item.nextRetryAt).getTime() > now) {
      keep.push(item);
      continue;
    }

    item.attempts += 1;
    const price = (await getTokenPriceUsd(item.signal.mint)) || inferTokenPriceFromSignal(config, item.signal);
    if (!price) {
      if (item.attempts < (config.noPriceRetryMaxAttempts ?? 5)) {
        item.nextRetryAt = new Date(now + (config.noPriceRetryDelaySec ?? 30) * 1000).toISOString();
        keep.push(item);
      }
      continue;
    }

    const paper = await paperBuy(config, state, item.signal, price);
    await appendEvent({
      time: nowIso(),
      signature: item.signal.signature,
      retry: true,
      ...item.signal,
      symbol: price.symbol,
        priceUsd: price.usd,
        priceSource: price.inferred ? "sol/token estimate" : "dexscreener",
      url: price.url,
      paper
    });
    console.log(
      `[${nowIso()}] PRICE RETRY ${item.signal.wallet} BUY ${price.symbol} ` +
      (paper.position ? `PAPER BUY ${fmtTry(paper.position.investedTry)}` : `(${paper.skipped})`)
    );
  }

  state.pendingPriceSignals = keep;
}

async function processSignature(config, state, wallets, signature) {
  if (inFlightSignatures.has(signature)) return;
  if (!rememberProcessedSignature(state, signature)) return;
  inFlightSignatures.add(signature);

  try {
    const tx = await getTransaction(config, signature).catch(() => null);
    if (!tx?.meta || tx.meta.err) return;

    const seenEvents = new Set();
    for (const wallet of uniqueWallets(wallets)) {
      const events = extractWalletEvents(tx, wallet);
      for (const event of events) {
      const eventKey = `${event.type}|${event.ownerAddress}|${event.mint}|${Math.sign(event.tokenDelta || 0)}`;
      if (seenEvents.has(eventKey)) continue;
      seenEvents.add(eventKey);

      const price = (await getTokenPriceUsd(event.mint)) || inferTokenPriceFromSignal(config, event);
      const signal = {
        ...event,
        confidence: wallet.confidence || "normal",
        mode: wallet.mode,
        class: wallet.class || "B",
        score: wallet.score ?? null,
        tradeTry: wallet.tradeTry ?? null,
        manualOverrideUntil: wallet.manualOverrideUntil || null,
        moonshot: Boolean(wallet.moonshot)
      };
      const base = {
        time: nowIso(),
        signature,
        ...signal,
        symbol: price?.symbol || event.mint.slice(0, 6),
        priceUsd: price?.usd ?? null,
        priceSource: price?.inferred ? "sol/token estimate" : (price ? "dexscreener" : null),
        url: price?.url ?? null
      };

      if (event.type === "SELL") {
        rememberTokenSellSignal(config, state, { ...signal, signature });
      }

      let paper = { skipped: "watched" };
      if (event.type === "TRANSFER_OUT" && event.transferTarget) {
        const added = addDiscoveredRelated(config, state, wallet, event.transferTarget);
        if (added) {
          wallet.relatedAddresses = [...new Set([...(wallet.relatedAddresses || []), event.transferTarget])];
        }
        paper = { skipped: added ? `tracked transfer target ${event.transferTarget.slice(0, 6)}...${event.transferTarget.slice(-4)}` : "transfer target already tracked" };
      }
      const hasOpenPaperPosition = state.positions.some(
        (position) => position.mint === event.mint && position.wallet === wallet.name
      );
      const copyTransferInAsBuy = config.copyTransferInAsBuy ?? true;
      const isCopyBuy =
        event.type === "BUY" ||
        (copyTransferInAsBuy && event.type === "TRANSFER_IN" && wallet.mode === "copy");
      const buySignal = isCopyBuy ? { ...signal, type: "BUY", sourceType: event.type } : signal;

      if (!price && wallet.mode === "copy" && isCopyBuy) {
        paper = queuePendingPriceSignal(config, state, { ...buySignal, signature }, base.symbol);
      } else if (price && wallet.mode === "copy" && isCopyBuy) {
        paper = await paperBuy(config, state, buySignal, price);
      } else if (price && event.type === "SELL" && (wallet.mode === "copy" || hasOpenPaperPosition)) {
        paper = await paperSell(config, state, signal, price);
      } else if (!price && event.type === "SELL" && (wallet.mode === "copy" || hasOpenPaperPosition)) {
        paper = { skipped: "exit price pending" };
      }

      await appendEvent({ ...base, paper });

      const action = paper.position
        ? `PAPER BUY ${paper.position.symbol} ${fmtTry(paper.position.investedTry)}`
        : paper.pnlTry !== undefined
          ? `PAPER SELL ${base.symbol} pnl=${fmtTry(paper.pnlTry)}`
          : `ALERT ${event.type} ${base.symbol} (${paper.skipped})`;

      await notify(
        config,
        `[${nowIso()}] ${wallet.name} ${event.type} ${base.symbol}\n${action}\n${base.url || ""}`
      );
      }
    }
  } finally {
    inFlightSignatures.delete(signature);
  }
}

async function pollRecentSignatures(config, state, wallets) {
  for (const wallet of uniqueWallets(wallets)) {
    for (const address of trackedAddresses(wallet)) {
      const signatures = await rpcCall(config, "getSignaturesForAddress", [
        address,
        { limit: 5 }
      ]).catch(() => []);
      for (const item of signatures.reverse()) {
        await processSignature(config, state, wallets, item.signature);
      }
    }
  }
}

async function seedRecentSignatures(config, state, wallets) {
  const seeded = [];
  for (const wallet of uniqueWallets(wallets)) {
    for (const address of trackedAddresses(wallet)) {
      const signatures = await rpcCall(config, "getSignaturesForAddress", [
        address,
        { limit: 10 }
      ]).catch(() => []);
      for (const item of signatures) seeded.push(item.signature);
    }
  }

  state.processedSignatures = [...new Set([...state.processedSignatures, ...seeded])].slice(-PROCESSED_SIGNATURE_LIMIT);
  return seeded.length;
}

async function seedNewWallets(config, state, wallets) {
  state.seededWallets ||= [];
  const seededWallets = new Set(state.seededWallets);
  let total = 0;
  for (const wallet of uniqueWallets(wallets)) {
    if (seededWallets.has(wallet.address)) continue;
    const signatures = [];
    for (const address of trackedAddresses(wallet)) {
      const walletSignatures = await rpcCall(config, "getSignaturesForAddress", [
        address,
        { limit: 10 }
      ]).catch(() => []);
      signatures.push(...walletSignatures);
    }
    for (const item of signatures) rememberProcessedSignature(state, item.signature);
    for (const address of trackedAddresses(wallet)) seededWallets.add(address);
    total += signatures.length;
  }
  state.seededWallets = [...seededWallets];
  trimProcessedSignatures(state);
  return total;
}

async function runWebSocket(config, state, wallets) {
  if (typeof WebSocket === "undefined") {
    throw new Error("This Node runtime does not expose WebSocket");
  }

  let nextId = 1;
  const ws = new WebSocket(config.rpcWs);

  ws.addEventListener("open", () => {
    console.log(`[${nowIso()}] websocket connected`);
    for (const wallet of uniqueWallets(wallets)) {
      for (const address of trackedAddresses(wallet)) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: nextId++,
            method: "logsSubscribe",
            params: [{ mentions: [address] }, { commitment: "confirmed" }]
          })
        );
      }
    }
  });

  ws.addEventListener("message", async (message) => {
    try {
      const data = JSON.parse(message.data);
      const signature = data?.params?.result?.value?.signature;
      if (signature) await processSignature(config, state, wallets, signature);
    } catch (error) {
      console.error("ws message error:", error.message);
    }
  });

  return new Promise((resolve) => {
    ws.addEventListener("close", resolve);
    ws.addEventListener("error", resolve);
  });
}

async function main() {
  await acquireBotLock();
  const config = await readJson(CONFIG_PATH);
  if (!config) {
    console.error("config.json yok. Once: Copy-Item config.example.json config.json");
    process.exit(1);
  }

  const state = (await readJson(STATE_PATH)) || initialState(config);
  applyDiscoveredRelated(config, state);
  const wallets = walletByAddress(config);
  await hydrateProcessedSignaturesFromEvents(state);

  if (!config.tradeHistoricalOnStartup && state.processedSignatures.length === 0) {
    const seeded = await seedRecentSignatures(config, state, wallets);
    console.log(`[${nowIso()}] seeded ${seeded} recent signatures; trading only new activity`);
  }

  if (!config.tradeHistoricalOnStartup) {
    const seeded = await seedNewWallets(config, state, wallets);
    if (seeded) {
      console.log(`[${nowIso()}] seeded ${seeded} signatures for newly tracked wallets`);
    }
  }

  await writeJson(STATE_PATH, state);

  await notify(
    config,
    `[${nowIso()}] Paper bot started. Wallets=${uniqueWallets(wallets).length}, cash=${fmtTry(state.cashTry)}`
  );

  setInterval(async () => {
    try {
      const nextConfig = await readJson(CONFIG_PATH);
      if (!nextConfig?.wallets) return;
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, nextConfig);
      applyDiscoveredRelated(config, state);
      const nextWallets = walletByAddress(config);
      wallets.clear();
      for (const [address, wallet] of nextWallets.entries()) wallets.set(address, wallet);
      if (!config.tradeHistoricalOnStartup) {
        const seeded = await seedNewWallets(config, state, wallets);
        if (seeded) console.log(`[${nowIso()}] hot config reload seeded ${seeded} signatures for new wallets`);
      }
      await writeJson(STATE_PATH, state);
    } catch (error) {
      console.error("config reload loop:", error.message);
    }
  }, 12000);

  setInterval(async () => {
    try {
      await processPendingPriceSignals(config, state);
      await applyRiskRules(config, state);
      await writeJson(STATE_PATH, state);
    } catch (error) {
      console.error("risk loop:", error.message);
    }
  }, 15000);

  setInterval(async () => {
    try {
      await pollRecentSignatures(config, state, wallets);
      await writeJson(STATE_PATH, state);
    } catch (error) {
      console.error("poll loop:", error.message);
    }
  }, 10000);

  while (true) {
    try {
      await runWebSocket(config, state, wallets);
    } catch (error) {
      console.error("websocket:", error.message);
    }
    console.log(`[${nowIso()}] websocket disconnected, reconnecting soon`);
    await sleep(5000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
