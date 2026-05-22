import fs from "node:fs/promises";

const RPC = "https://solana-rpc.publicnode.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_TOKENS = Number(process.env.ALPHA_MAX_TOKENS || 10);
const SIGS_PER_PAIR = Number(process.env.ALPHA_SIGS_PER_PAIR || 32);
const TX_SAMPLE_PER_WALLET = Number(process.env.ALPHA_TX_SAMPLE_PER_WALLET || 45);
const MAX_PROFILED_WALLETS = Number(process.env.ALPHA_MAX_PROFILED_WALLETS || 18);
const MIN_SPEND_SOL = 0.015;
const TREND_QUERIES = ["ai", "meme", "cat", "dog", "sol", "pump", "cto", "bonk", "trenches", "viral", "moon", "usa"];
const FUNDER_LOOKBACK_SIGNATURES = Number(process.env.ALPHA_FUNDER_SIGS || 18);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeStatus(patch) {
  const previous = await readJson("free-alpha-radar-status.json", {});
  await fs.writeFile("free-alpha-radar-status.json", JSON.stringify({
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  }, null, 2)).catch(() => {});
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function rpc(method, params, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const json = await res.json().catch(() => ({}));
    if (!json.error) return json.result;
    if (attempt === retries) return null;
    await sleep(250 + attempt * 350);
  }
}

function keyString(key) {
  if (typeof key === "string") return key;
  return key.pubkey?.toString?.() || key.pubkey || key.toString?.();
}

function tokenOwnerMap(balances) {
  const map = new Map();
  for (const bal of balances || []) {
    if (!bal.owner || !bal.mint || bal.mint === SOL_MINT) continue;
    const amount = Number(bal.uiTokenAmount?.uiAmountString ?? bal.uiTokenAmount?.uiAmount ?? 0);
    map.set(`${bal.owner}:${bal.mint}`, (map.get(`${bal.owner}:${bal.mint}`) || 0) + amount);
  }
  return map;
}

function solDelta(tx, owner) {
  const keys = tx.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((key) => keyString(key) === owner);
  if (index < 0) return 0;
  return ((tx.meta?.postBalances?.[index] || 0) - (tx.meta?.preBalances?.[index] || 0)) / 1e9;
}

function lamportDelta(tx, owner) {
  const keys = tx.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((key) => keyString(key) === owner);
  if (index < 0) return 0;
  return ((tx.meta?.postBalances?.[index] || 0) - (tx.meta?.preBalances?.[index] || 0)) / 1e9;
}

function tokenDeltasByOwner(tx) {
  const pre = tokenOwnerMap(tx.meta?.preTokenBalances);
  const post = tokenOwnerMap(tx.meta?.postTokenBalances);
  const out = [];
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    const [owner, mint] = key.split(":");
    const delta = (post.get(key) || 0) - (pre.get(key) || 0);
    if (Math.abs(delta) > 1e-9) out.push({ owner, mint, delta });
  }
  return out;
}

function ageHours(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

function walletDecision(wallet) {
  const riskFlags = [];
  const openLotCount = Number(wallet.openLotCount || 0);
  const closed = Number(wallet.closed || 0);
  const winRate = Number(wallet.winRate || 0);
  const pnlSol = Number(wallet.pnlSol || 0);
  const biggestLoss = Math.abs(Math.min(0, Number(wallet.biggestLossSol || 0)));
  const maxX = Number(wallet.maxX || 1);
  const noiseRatio = Number(wallet.noiseRatio || 0);
  const activeHours = ageHours(wallet.lastSeenAt);
  const totalSpendSol = Number(wallet.spentSol || 0);
  const profileSpendSol = Number(wallet.totalBuySol || 0);
  const maxBuySol = Math.max(Number(wallet.maxBuySol || 0), Number(wallet.maxEarlyBuySol || 0));
  const avgBuySol = Number(wallet.avgBuySol || 0);
  const medianBuySol = Number(wallet.medianBuySol || 0);
  const earliestSec = Number(wallet.earliestSec ?? 999999);
  const convictionScore = Math.max(0, Math.min(100, Number((
    Math.min(28, Math.log2(1 + totalSpendSol) * 10) +
    Math.min(26, Math.log2(1 + profileSpendSol) * 7) +
    Math.min(24, Math.log2(1 + maxBuySol) * 15) +
    Math.min(12, Math.log2(1 + avgBuySol) * 12) +
    (medianBuySol >= 0.25 ? 8 : medianBuySol >= 0.1 ? 4 : 0)
  ).toFixed(1))));
  const funding = wallet.funding || null;
  const fundedSmall = funding && Number(funding.receivedSol || 0) >= 0.08 && Number(funding.receivedSol || 0) <= 3;
  const isDustSniper = maxBuySol < 0.08 && avgBuySol < 0.035 && totalSpendSol < 0.25;
  const oneHitWonder = maxX >= 8 && closed < 5;
  const noRealizedProof = closed < 3 && pnlSol <= 0;
  const copyCrowdingRisk = noiseRatio > 6 || openLotCount > 24;

  if (closed < 3) riskFlags.push("az kapanis");
  if (noiseRatio > 4 && winRate < 55) riskFlags.push("her seye atliyor");
  if (biggestLoss > 1.5) riskFlags.push("buyuk zarar izi");
  if (openLotCount > 18) riskFlags.push("cok fazla acik token");
  if (activeHours !== null && activeHours > 72) riskFlags.push("son aktivite zayif");
  if (wallet.spentSol > 2 && closed < 2) riskFlags.push("kar/zarar belirsiz");
  if (isDustSniper) riskFlags.push("kucuk para sniper");
  if (oneHitWonder) riskFlags.push("one-hit-wonder riski");
  if (copyCrowdingRisk) riskFlags.push("copy crowding/noise riski");
  if (noRealizedProof) riskFlags.push("realized proof yok");

  const repeatabilityScore = Math.max(0, Math.min(100, Number((
    Math.min(28, Number(wallet.hits || 0) * 10) +
    Math.min(24, Number(wallet.earlyHits || 0) * 12) +
    (fundedSmall ? 8 : 0) +
    Math.min(22, closed * 3) +
    (closed >= 10 ? 12 : closed >= 5 ? 7 : 0) +
    (winRate >= 60 ? 10 : winRate >= 50 ? 5 : 0) -
    (oneHitWonder ? 18 : 0)
  ).toFixed(1))));
  const timingScore = Math.max(0, Math.min(100, Number((
    Math.min(34, Math.max(0, 420 - earliestSec) / 8) +
    Math.min(24, Number(wallet.earlyHits || 0) * 12) +
    (activeHours !== null && activeHours <= 12 ? 14 : activeHours !== null && activeHours <= 36 ? 8 : 0) +
    (fundedSmall ? 8 : 0) +
    Math.min(10, Math.max(0, Number(wallet.avgEarlyBuySol || 0)) * 16)
  ).toFixed(1))));
  const survivalScore = Math.max(0, Math.min(100, Number((
    70 +
    (pnlSol > 0 ? Math.min(12, pnlSol * 3) : Math.max(-18, pnlSol * 6)) +
    (winRate >= 60 ? 8 : winRate < 40 && closed >= 4 ? -14 : 0) -
    Math.min(22, biggestLoss * 8) -
    Math.min(18, Math.max(0, noiseRatio - 2) * 4) -
    Math.min(16, Math.max(0, openLotCount - 8) * 1.4) -
    riskFlags.length * 4
  ).toFixed(1))));
  const copySafetyScore = Math.max(0, Math.min(100, Number((
    survivalScore * 0.45 +
    repeatabilityScore * 0.24 +
    convictionScore * 0.18 +
    (closed >= 8 ? 10 : closed >= 4 ? 5 : 0) -
    (copyCrowdingRisk ? 18 : 0) -
    (noRealizedProof ? 16 : 0)
  ).toFixed(1))));
  const proofScore = Math.max(0, Math.min(100, Number((
    Math.min(35, closed * 5) +
    Math.min(20, Math.max(0, pnlSol) * 5) +
    (winRate ? Math.max(0, winRate - 45) * 0.65 : 0) +
    Math.min(16, Math.log2(Math.max(1, maxX)) * 6) -
    (oneHitWonder ? 18 : 0)
  ).toFixed(1))));

  const insiderLike =
    Math.min(22, Number(wallet.earlyHits || 0) * 8) +
    Math.min(18, Number(wallet.hits || 0) * 4) +
    Math.min(22, convictionScore * 0.28) +
    Math.min(12, Math.log2(1 + maxBuySol) * 8) +
    Math.min(14, Math.max(0, maxX - 1) * 2.5) +
    (activeHours !== null && activeHours <= 24 ? 8 : 0) -
    (isDustSniper ? 18 : 0) -
    riskFlags.length * 6;

  const alphaScore =
    Number(wallet.quality || 0) * 0.44 +
    Math.min(22, Number(wallet.earlyHits || 0) * 8) +
    Math.min(16, Number(wallet.hits || 0) * 3.5) +
    Math.min(18, convictionScore * 0.22) +
    Math.min(18, repeatabilityScore * 0.2) +
    Math.min(14, survivalScore * 0.16) +
    Math.min(16, Math.log2(Math.max(1, maxX)) * 8) -
    Math.min(18, biggestLoss * 5) -
    riskFlags.length * 5;

  const edgeScore = Math.max(0, Math.min(100, Number(alphaScore.toFixed(1))));
  const insiderScore = Math.max(0, Math.min(100, Number(insiderLike.toFixed(1))));
  const sniperScore = Math.max(0, Math.min(100, Number((
    Math.min(35, Number(wallet.earlyHits || 0) * 16) +
    Math.min(18, Number(wallet.hits || 0) * 5) +
    Math.min(18, Math.max(0, 360 - earliestSec) / 12) +
    Math.min(12, timingScore * 0.16) +
    Math.min(10, convictionScore * 0.12) -
    (isDustSniper ? 12 : 0) +
    (activeHours !== null && activeHours <= 24 ? 8 : 0) -
    riskFlags.length * 7
  ).toFixed(1))));
  const archetypes = [];
  if (sniperScore >= 45) archetypes.push("SNIPER");
  if (insiderScore >= 45 && convictionScore >= 34 && (Number(wallet.earlyHits || 0) >= 1 || maxX >= 5)) archetypes.push("INSIDER-BENZERI");
  if (edgeScore >= 55 && convictionScore >= 30 && pnlSol > 0 && riskFlags.length <= 1 && proofScore >= 35) archetypes.push("SMART WALLET");
  if (convictionScore >= 55 && pnlSol >= 0) archetypes.push("BUYUK PARA");
  const profile =
    edgeScore >= 72 && insiderScore >= 42 && convictionScore >= 38 && copySafetyScore >= 58 && proofScore >= 36 && riskFlags.length <= 1 ? "PIR ADAYI" :
    fundedSmall && insiderScore >= 45 && timingScore >= 35 && riskFlags.length <= 3 ? "FONLANMIS CLUSTER ADAYI" :
    edgeScore >= 58 && convictionScore >= 30 && copySafetyScore >= 48 && pnlSol >= 0 && riskFlags.length <= 2 ? "IZLE + MINI" :
    maxX >= 6 && riskFlags.length <= 2 ? "MOONSHOT RADAR" :
    riskFlags.length >= 3 ? "RISKLI" :
    "BEKLE";
  const action =
    profile === "PIR ADAYI" ? "simde mini lot, ikinci cüzdan onayında büyüt" :
    profile === "IZLE + MINI" ? "alarm kur, yalnizca taze token/ikinci onayda al" :
    profile === "MOONSHOT RADAR" ? "normal copy yok; sadece küçük asimetrik risk" :
    profile === "RISKLI" ? "copy kapali, sadece veri topla" :
    "takipte tut, sinyal gelirse tekrar puanla";
  const lotTry =
    profile === "PIR ADAYI" ? 120 :
    profile === "IZLE + MINI" ? 70 :
    profile === "MOONSHOT RADAR" ? 40 :
    0;

  return {
    alphaScore: edgeScore,
    insiderScore,
    sniperScore,
    convictionScore,
    repeatabilityScore,
    timingScore,
    survivalScore,
    copySafetyScore,
    proofScore,
    funding,
    maxBuySol: Number(maxBuySol.toFixed(4)),
    avgBuySol: Number(avgBuySol.toFixed(4)),
    medianBuySol: Number(medianBuySol.toFixed(4)),
    totalBuySol: Number(profileSpendSol.toFixed(4)),
    dustSniper: isDustSniper,
    archetypes,
    profile,
    action,
    lotTry,
    riskFlags,
    reasons: [
      `${wallet.hits} token yakaladi`,
      `${wallet.earlyHits} erken giris`,
      `ilk giris ${earliestSec === 999999 ? "-" : `${earliestSec}s`}`,
      `WR ${wallet.winRate ?? "-"}%`,
      `PnL ${wallet.pnlSol} SOL`,
      `max ${wallet.maxX}x`,
      `max buy ${maxBuySol.toFixed(2)} SOL`,
      `avg buy ${avgBuySol.toFixed(2)} SOL`,
      `conviction ${convictionScore}`,
      `proof ${proofScore}`,
      `repeat ${repeatabilityScore}`,
      `survival ${survivalScore}`,
      `copySafety ${copySafetyScore}`,
      funding ? `funder ${funding.funder.slice(0, 6)} ${funding.receivedSol} SOL` : "funder yok",
      `noise ${noiseRatio.toFixed(1)}`
    ]
  };
}

async function tokenUniverse() {
  const [profiles, boosts, topBoosts, ctos, ads] = await Promise.all([
    getJson("https://api.dexscreener.com/token-profiles/latest/v1").catch(() => []),
    getJson("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
    getJson("https://api.dexscreener.com/token-boosts/top/v1").catch(() => []),
    getJson("https://api.dexscreener.com/community-takeovers/latest/v1").catch(() => []),
    getJson("https://api.dexscreener.com/ads/latest/v1").catch(() => [])
  ]);
  const localDiscover = await readJson("oracle-discovery-result.json", { rows: [] });
  const localEventsText = await fs.readFile("paper-events.ndjson", "utf8").catch(() => "");
  const localEventMints = localEventsText
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-500)
    .map((line) => {
      try { return JSON.parse(line).mint; } catch { return null; }
    })
    .filter(Boolean);
  const searchPairs = [];
  for (const query of TREND_QUERIES) {
    const data = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`).catch(() => ({ pairs: [] }));
    searchPairs.push(...(data?.pairs || []).filter((pair) => pair.chainId === "solana" && pair.baseToken?.address));
    await sleep(80);
  }
  const unique = [...new Set([
    ...[...profiles, ...boosts, ...topBoosts, ...ctos, ...ads]
      .filter((item) => item.chainId === "solana" && item.tokenAddress)
      .map((item) => item.tokenAddress),
    ...(localDiscover.rows || []).map((row) => row.mint).filter(Boolean),
    ...localEventMints,
    ...searchPairs.map((pair) => pair.baseToken.address)
  ])].slice(0, 220);

  const tokens = [];
  for (const mint of unique) {
    const data = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
    const pair = (data?.pairs || [])
      .filter((p) => p.chainId === "solana" && p.pairAddress)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    if (!pair) continue;
    const volume24 = pair.volume?.h24 || 0;
    const buys24 = pair.txns?.h24?.buys || 0;
    const liquidityUsd = pair.liquidity?.usd || 0;
    const fdv = pair.fdv || pair.marketCap || 0;
    const change24 = pair.priceChange?.h24 ?? 0;
    const sourceWeight =
      (localEventMints.includes(mint) ? 2 : 0) +
      ((localDiscover.rows || []).some((row) => row.mint === mint) ? 2 : 0) +
      (searchPairs.some((pair) => pair.baseToken?.address === mint) ? 1 : 0);
    if (volume24 < 3500 && sourceWeight < 2) continue;
    if (buys24 < 20 && sourceWeight < 2) continue;
    if (liquidityUsd < 900 && sourceWeight < 2) continue;
    tokens.push({
      mint,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken?.symbol || mint.slice(0, 6),
      volume24,
      buys24,
      sells24: pair.txns?.h24?.sells || 0,
      liquidityUsd,
      fdv,
      change24,
      url: pair.url,
      sourceWeight
    });
    if (tokens.length >= MAX_TOKENS) break;
    await sleep(70);
  }
  return tokens.sort((a, b) => (b.change24 || 0) - (a.change24 || 0));
}

async function earlyBuyers(token) {
  const sigs = await rpc("getSignaturesForAddress", [token.pairAddress, { limit: SIGS_PER_PAIR }]) || [];
  const buyers = [];
  let firstBlockTime = null;
  for (const sig of sigs.reverse()) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    firstBlockTime ??= tx.blockTime;
    for (const delta of tokenDeltasByOwner(tx)) {
      if (delta.mint !== token.mint || delta.delta <= 0) continue;
      const spentSol = -solDelta(tx, delta.owner);
      if (spentSol >= MIN_SPEND_SOL) {
        buyers.push({
          wallet: delta.owner,
          spentSol,
          time: tx.blockTime,
          earlySec: firstBlockTime ? tx.blockTime - firstBlockTime : null,
          signature: sig.signature
        });
      }
    }
    await sleep(35);
  }
  return buyers;
}

async function walletProfile(wallet) {
  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: TX_SAMPLE_PER_WALLET }]) || [];
  const lots = new Map();
  const trades = [];
  const buySizes = [];
  let buys = 0;
  let sells = 0;
  let totalBuySol = 0;
  let maxBuySol = 0;

  for (const sig of sigs.reverse()) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    const sDelta = solDelta(tx, wallet);
    for (const delta of tokenDeltasByOwner(tx).filter((item) => item.owner === wallet)) {
      const lot = lots.get(delta.mint) || { qty: 0, cost: 0 };
      if (delta.delta > 0 && sDelta < -0.006) {
        const buySol = -sDelta;
        buys += 1;
        totalBuySol += buySol;
        maxBuySol = Math.max(maxBuySol, buySol);
        buySizes.push(buySol);
        lot.qty += delta.delta;
        lot.cost += buySol;
      } else if (delta.delta < 0 && sDelta > 0.006) {
        sells += 1;
        const sellQty = -delta.delta;
        const basis = lot.qty > 0 ? lot.cost * Math.min(1, sellQty / lot.qty) : 0;
        if (basis > 0) trades.push({ pnl: sDelta - basis, roi: (sDelta - basis) / basis });
        if (lot.qty > 0) {
          lot.qty -= sellQty;
          lot.cost -= basis;
          if (lot.qty < 1e-9) {
            lot.qty = 0;
            lot.cost = 0;
          }
        }
      }
      lots.set(delta.mint, lot);
    }
    await sleep(25);
  }

  const closed = trades.length;
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const pnlSol = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const biggestLossSol = Math.min(0, ...trades.map((trade) => trade.pnl));
  const bestRoi = Math.max(0, ...trades.map((trade) => trade.roi));
  const threeX = trades.filter((trade) => trade.roi >= 2).length;
  const fiveX = trades.filter((trade) => trade.roi >= 4).length;
  const openLots = [...lots.values()].filter((lot) => lot.qty > 1e-9);
  const openCostSol = openLots.reduce((sum, lot) => sum + lot.cost, 0);
  const noiseRatio = buys / Math.max(1, sells);
  const sortedBuySizes = [...buySizes].sort((a, b) => a - b);
  const medianBuySol = sortedBuySizes.length ? sortedBuySizes[Math.floor(sortedBuySizes.length / 2)] : 0;
  const quality =
    Math.min(25, closed * 1.5) +
    (closed ? (wins / closed) * 25 : 0) +
    Math.min(30, Math.max(0, pnlSol) * 4) +
    Math.min(18, Math.log2(1 + bestRoi) * 7) -
    Math.abs(biggestLossSol) * 4 -
    Math.max(0, buys - 50) * 0.4;

  return {
    wallet,
    buys,
    sells,
    closed,
    winRate: closed ? Number(((wins / closed) * 100).toFixed(1)) : null,
    pnlSol: Number(pnlSol.toFixed(4)),
    biggestLossSol: Number(biggestLossSol.toFixed(4)),
    maxX: Number((1 + bestRoi).toFixed(2)),
    threeX,
    fiveX,
    openLotCount: openLots.length,
    openCostSol: Number(openCostSol.toFixed(4)),
    totalBuySol: Number(totalBuySol.toFixed(4)),
    maxBuySol: Number(maxBuySol.toFixed(4)),
    avgBuySol: buys ? Number((totalBuySol / buys).toFixed(4)) : 0,
    medianBuySol: Number(medianBuySol.toFixed(4)),
    noiseRatio: Number(noiseRatio.toFixed(2)),
    lastSeenAt: sigs?.[0]?.blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null,
    quality: Number(Math.max(0, Math.min(100, quality)).toFixed(1))
  };
}

async function fundingSource(wallet) {
  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: FUNDER_LOOKBACK_SIGNATURES }]) || [];
  for (const sig of sigs) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    const receivedSol = lamportDelta(tx, wallet);
    if (receivedSol < 0.08) continue;
    const keys = tx.transaction?.message?.accountKeys || [];
    const funders = keys
      .map((key) => keyString(key))
      .filter((address) => address && address !== wallet)
      .map((address) => ({ address, delta: lamportDelta(tx, address) }))
      .filter((item) => item.delta < -0.06)
      .sort((a, b) => a.delta - b.delta);
    const funder = funders[0];
    if (funder) {
      return {
        funder: funder.address,
        receivedSol: Number(receivedSol.toFixed(4)),
        signature: sig.signature,
        time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null
      };
    }
    await sleep(20);
  }
  return null;
}

const tokens = await tokenUniverse();
await writeStatus({ stage: "token-universe", tokens: tokens.length });
console.error(`tokens=${tokens.length}`);
const walletHits = new Map();
const tokenClusters = [];

for (const token of tokens) {
  const buyers = await earlyBuyers(token);
  await writeStatus({ stage: "early-buyers", token: token.symbol, buyers: buyers.length, walletHits: walletHits.size });
  const uniqueBuyers = [];
  const seen = new Set();
  for (const buyer of buyers) {
    if (seen.has(buyer.wallet)) continue;
    seen.add(buyer.wallet);
    uniqueBuyers.push(buyer);
    const hit = walletHits.get(buyer.wallet) || { wallet: buyer.wallet, hits: 0, spentSol: 0, tokens: new Set(), earlyHits: 0, earliestSec: null, earlySecSum: 0, maxEarlyBuySol: 0, earlyBuySizes: [] };
    hit.hits += 1;
    hit.spentSol += buyer.spentSol;
    hit.maxEarlyBuySol = Math.max(Number(hit.maxEarlyBuySol || 0), Number(buyer.spentSol || 0));
    hit.earlyBuySizes.push(Number(buyer.spentSol || 0));
    hit.tokens.add(token.symbol);
    if ((buyer.earlySec ?? 999999) <= 300) hit.earlyHits += 1;
    if (buyer.earlySec !== null && buyer.earlySec !== undefined) {
      hit.earliestSec = hit.earliestSec === null ? buyer.earlySec : Math.min(hit.earliestSec, buyer.earlySec);
      hit.earlySecSum += buyer.earlySec;
    }
    walletHits.set(buyer.wallet, hit);
  }
  tokenClusters.push({ token, buyers: uniqueBuyers.slice(0, 15) });
  console.error(`${token.symbol} buyers=${uniqueBuyers.length}`);
}

const candidateWallets = [...walletHits.values()]
  .filter((hit) => hit.hits >= 2 || hit.earlyHits >= 1 || hit.spentSol >= 0.8)
  .sort((a, b) => b.earlyHits - a.earlyHits || b.hits - a.hits || b.spentSol - a.spentSol)
  .slice(0, MAX_PROFILED_WALLETS);
await writeStatus({ stage: "candidate-wallets", candidates: candidateWallets.length, walletHits: walletHits.size });

const profiles = new Map();
for (const hit of candidateWallets) {
  const [profile, funding] = await Promise.all([
    walletProfile(hit.wallet),
    fundingSource(hit.wallet).catch(() => null)
  ]);
  profiles.set(hit.wallet, { ...hit, tokens: [...hit.tokens], ...profile, funding });
  await writeStatus({ stage: "profile-wallet", wallet: hit.wallet, profiles: profiles.size, candidates: candidateWallets.length });
  console.error(`${hit.wallet.slice(0, 6)} q=${profile.quality} closed=${profile.closed} pnl=${profile.pnlSol} max=${profile.maxX}x`);
}

const walletScores = [...profiles.values()]
  .map((wallet) => {
    const decision = walletDecision(wallet);
    return {
      ...wallet,
      avgEarlySec: wallet.hits ? Number((Number(wallet.earlySecSum || 0) / wallet.hits).toFixed(1)) : null,
      avgEarlyBuySol: wallet.earlyBuySizes?.length ? Number((wallet.earlyBuySizes.reduce((sum, value) => sum + Number(value || 0), 0) / wallet.earlyBuySizes.length).toFixed(4)) : 0,
      ...decision
    };
  })
  .sort((a, b) => b.alphaScore - a.alphaScore);

const sniperWallets = walletScores
  .filter((wallet) => (wallet.sniperScore >= 45 || wallet.earlyHits >= 2) && !wallet.dustSniper)
  .sort((a, b) => b.sniperScore - a.sniperScore || b.convictionScore - a.convictionScore || b.earlyHits - a.earlyHits)
  .slice(0, 12);

const insiderLikeWallets = walletScores
  .filter((wallet) => wallet.insiderScore >= 40 && wallet.convictionScore >= 30 && (wallet.earlyHits >= 1 || wallet.maxX >= 5))
  .sort((a, b) => b.insiderScore - a.insiderScore || b.convictionScore - a.convictionScore || b.maxX - a.maxX)
  .slice(0, 12);

const smartWallets = walletScores
  .filter((wallet) => wallet.alphaScore >= 50 && wallet.convictionScore >= 30 && wallet.pnlSol > 0 && (wallet.riskFlags || []).length <= 1)
  .sort((a, b) => b.alphaScore - a.alphaScore || b.convictionScore - a.convictionScore || b.pnlSol - a.pnlSol)
  .slice(0, 12);

const suggestedWatchlist = [...new Map([...smartWallets, ...insiderLikeWallets, ...sniperWallets]
  .map((wallet) => [wallet.wallet, wallet])).values()]
  .sort((a, b) => (b.alphaScore + b.insiderScore + b.sniperScore) - (a.alphaScore + a.insiderScore + a.sniperScore))
  .slice(0, 18);

const clusters = tokenClusters.map(({ token, buyers }) => {
  const enriched = buyers.map((buyer) => ({
    ...buyer,
    profile: profiles.get(buyer.wallet) || null
  }));
  const smartBuyers = enriched.filter((buyer) => (buyer.profile?.alphaScore || 0) >= 45);
  const strongBuyers = enriched.filter((buyer) => (buyer.profile?.profile || "") === "PIR ADAYI");
  const riskyBuyers = enriched.filter((buyer) => (buyer.profile?.riskFlags || []).length >= 3);
  const qualitySum = smartBuyers.reduce((sum, buyer) => sum + (buyer.profile?.alphaScore || 0), 0);
  const funderGroups = new Map();
  for (const buyer of enriched) {
    const funder = buyer.profile?.funding?.funder;
    if (!funder) continue;
    const group = funderGroups.get(funder) || { funder, buyers: [], totalSpentSol: 0, firstSec: null, lastSec: null };
    group.buyers.push(buyer.wallet);
    group.totalSpentSol += Number(buyer.spentSol || 0);
    if (buyer.earlySec !== null && buyer.earlySec !== undefined) {
      group.firstSec = group.firstSec === null ? buyer.earlySec : Math.min(group.firstSec, buyer.earlySec);
      group.lastSec = group.lastSec === null ? buyer.earlySec : Math.max(group.lastSec, buyer.earlySec);
    }
    funderGroups.set(funder, group);
  }
  const fundingClusters = [...funderGroups.values()]
    .map((group) => ({
      ...group,
      buyerCount: group.buyers.length,
      windowSec: group.firstSec === null || group.lastSec === null ? null : group.lastSec - group.firstSec,
      coordinationScore: Math.min(100, group.buyers.length * 28 + Math.log2(1 + group.totalSpentSol) * 12 - Math.max(0, (group.windowSec || 0) - 180) / 12)
    }))
    .filter((group) => group.buyerCount >= 2)
    .sort((a, b) => b.coordinationScore - a.coordinationScore)
    .slice(0, 5);
  const fundingBonus = fundingClusters.reduce((sum, group) => sum + Math.min(18, group.coordinationScore / 6), 0);
  const earlyBonus = enriched.filter((buyer) => (buyer.earlySec ?? 999999) <= 300).length * 4;
  const liquidityScore = token.liquidityUsd >= 10000 ? 10 : token.liquidityUsd >= 4000 ? 6 : 2;
  const mcapScore = token.fdv && token.fdv < 200000 ? 10 : token.fdv < 1000000 ? 6 : 2;
  const clusterScore = Math.min(100, qualitySum / 2.7 + smartBuyers.length * 8 + strongBuyers.length * 10 + earlyBonus + fundingBonus + liquidityScore + mcapScore - riskyBuyers.length * 5);
  const action =
    clusterScore >= 78 && strongBuyers.length >= 1 ? "PIR ONAYI: sim mini lot" :
    clusterScore >= 70 && smartBuyers.length >= 2 ? "GUCLU SINYAL: ikinci onayi bekle" :
    clusterScore >= 55 && smartBuyers.length >= 1 ? "IZLE/ALARM: yalniz mini risk" :
    "GURULTU: sadece kaydet";
  return {
    symbol: token.symbol,
    mint: token.mint,
    url: token.url,
    change24: token.change24,
    liquidityUsd: token.liquidityUsd,
    fdv: token.fdv,
    buyers: enriched.slice(0, 8).map((buyer) => ({
      wallet: buyer.wallet,
      spentSol: Number(buyer.spentSol.toFixed(4)),
      earlySec: buyer.earlySec,
      alphaScore: buyer.profile?.alphaScore || 0,
      insiderScore: buyer.profile?.insiderScore || 0,
      sniperScore: buyer.profile?.sniperScore || 0,
      profile: buyer.profile?.profile || "-",
      archetypes: buyer.profile?.archetypes || [],
      quality: buyer.profile?.quality || 0,
      riskFlags: buyer.profile?.riskFlags || []
    })),
    smartCount: smartBuyers.length,
    strongCount: strongBuyers.length,
    riskyCount: riskyBuyers.length,
    fundingClusters,
    clusterScore: Number(clusterScore.toFixed(1)),
    action
  };
}).sort((a, b) => b.clusterScore - a.clusterScore);

await fs.writeFile("free-alpha-radar-result.json", JSON.stringify({
  createdAt: new Date().toISOString(),
  tokens,
  wallets: walletScores.slice(0, 30),
  clusters: clusters.slice(0, 30),
  hunter: {
    sniperWallets,
    insiderLikeWallets,
    smartWallets,
    suggestedWatchlist,
    rules: [
      "Sniper: ayni taramada erken alici olarak gorunen ve hiz puani yuksek cuzdan.",
      "Insider-benzeri: erkenlik + tekrar + yuksek carpan izi olan cuzdan; kimlik iddiasi degildir.",
      "Smart wallet: PnL, win rate, zarar kontrolu ve tekrar sinyal kalitesi daha temiz cuzdan.",
      "Hiçbiri otomatik gercek emir sebebi degil; once simulasyon ve ikinci cuzdan onayi."
    ]
  }
}, null, 2));
await writeStatus({ stage: "done", wallets: walletScores.length, clusters: clusters.length });

console.table(clusters.slice(0, 12).map((item) => ({
  token: item.symbol,
  smart: item.smartCount,
  score: item.clusterScore,
  liq: Math.round(item.liquidityUsd),
  fdv: Math.round(item.fdv),
  action: item.action
})));
