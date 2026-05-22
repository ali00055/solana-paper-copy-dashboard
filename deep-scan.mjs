const RPC = "https://solana-rpc.publicnode.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_TOKENS = 28;
const SIGS_PER_PAIR = 45;
const TX_SAMPLE_PER_WALLET = 90;
const MIN_BUY_SOL = 0.03;
const MIN_CLOSED_TRADES = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function rpc(method, params, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (!json.error) return json.result;
    if (attempt === retries) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    await sleep(350 + attempt * 500);
  }
}

function keyString(key) {
  if (typeof key === "string") return key;
  return key.pubkey?.toString?.() || key.pubkey || key.toString?.();
}

function tokenOwnerMap(balances) {
  const map = new Map();
  for (const bal of balances || []) {
    if (!bal.owner || !bal.mint) continue;
    const amount = Number(bal.uiTokenAmount?.uiAmountString ?? bal.uiTokenAmount?.uiAmount ?? 0);
    const key = `${bal.owner}:${bal.mint}`;
    map.set(key, (map.get(key) || 0) + amount);
  }
  return map;
}

function ownerTokenDelta(tx, owner, mint) {
  const pre = tokenOwnerMap(tx.meta?.preTokenBalances);
  const post = tokenOwnerMap(tx.meta?.postTokenBalances);
  return (post.get(`${owner}:${mint}`) || 0) - (pre.get(`${owner}:${mint}`) || 0);
}

function solDelta(tx, owner) {
  const keys = tx.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((key) => keyString(key) === owner);
  if (index < 0) return 0;
  return ((tx.meta?.postBalances?.[index] || 0) - (tx.meta?.preBalances?.[index] || 0)) / 1e9;
}

function tokenDeltasByOwner(tx) {
  const pre = tokenOwnerMap(tx.meta?.preTokenBalances);
  const post = tokenOwnerMap(tx.meta?.postTokenBalances);
  const keys = new Set([...pre.keys(), ...post.keys()]);
  const out = [];
  for (const key of keys) {
    const [owner, mint] = key.split(":");
    if (mint === SOL_MINT) continue;
    const delta = (post.get(key) || 0) - (pre.get(key) || 0);
    if (Math.abs(delta) > 1e-9) out.push({ owner, mint, delta });
  }
  return out;
}

async function tokenUniverse() {
  const [profiles, boosts] = await Promise.all([
    getJson("https://api.dexscreener.com/token-profiles/latest/v1").catch(() => []),
    getJson("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
  ]);

  const records = [...profiles, ...boosts]
    .filter((item) => item.chainId === "solana" && item.tokenAddress)
    .map((item) => item.tokenAddress);

  const unique = [...new Set(records)].slice(0, 80);
  const enriched = [];
  for (const mint of unique) {
    const data = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
    const pairs = (data?.pairs || [])
      .filter((pair) => pair.chainId === "solana" && pair.pairAddress)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    const pair = pairs[0];
    if (!pair) continue;
    if ((pair.volume?.h24 || 0) < 1000 && (pair.txns?.h24?.buys || 0) < 20) continue;
    enriched.push({
      mint,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken?.symbol || mint.slice(0, 6),
      volume24: pair.volume?.h24 || 0,
      buys24: pair.txns?.h24?.buys || 0,
      change24: pair.priceChange?.h24 ?? null,
      liquidityUsd: pair.liquidity?.usd || 0,
      fdv: pair.fdv || pair.marketCap || 0,
    });
    await sleep(120);
    if (enriched.length >= MAX_TOKENS) break;
  }
  return enriched;
}

async function earlyBuyersForToken(token) {
  const signatures = await rpc("getSignaturesForAddress", [token.pairAddress, { limit: SIGS_PER_PAIR }]).catch(() => []);
  const buyers = [];
  for (const sig of signatures.reverse()) {
    const tx = await rpc("getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]).catch(() => null);
    if (!tx?.meta || tx.meta.err) continue;

    for (const delta of tokenDeltasByOwner(tx)) {
      if (delta.mint !== token.mint || delta.delta <= 0) continue;
      const spentSol = -solDelta(tx, delta.owner);
      if (spentSol >= MIN_BUY_SOL && delta.owner !== token.pairAddress && delta.owner !== token.mint) {
        buyers.push({
          wallet: delta.owner,
          token: token.symbol,
          mint: token.mint,
          spentSol,
          time: tx.blockTime,
          sig: sig.signature,
        });
      }
    }
    await sleep(90);
  }
  return buyers;
}

async function analyzeWallet(wallet) {
  const signatures = await rpc("getSignaturesForAddress", [wallet, { limit: TX_SAMPLE_PER_WALLET }]).catch(() => []);
  const lots = new Map();
  const trades = [];
  let buys = 0;
  let sells = 0;

  for (const sig of signatures.reverse()) {
    const tx = await rpc("getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]).catch(() => null);
    if (!tx?.meta || tx.meta.err) continue;
    const sDelta = solDelta(tx, wallet);
    for (const delta of tokenDeltasByOwner(tx).filter((item) => item.owner === wallet)) {
      const lot = lots.get(delta.mint) || { qty: 0, cost: 0, buys: 0, sells: 0 };
      if (delta.delta > 0 && sDelta < -0.005) {
        buys += 1;
        lot.qty += delta.delta;
        lot.cost += -sDelta;
        lot.buys += 1;
      } else if (delta.delta < 0 && sDelta > 0.005) {
        sells += 1;
        const sellQty = -delta.delta;
        const basis = lot.qty > 0 ? lot.cost * Math.min(1, sellQty / lot.qty) : 0;
        if (basis > 0) {
          trades.push({
            mint: delta.mint,
            pnl: sDelta - basis,
            roi: (sDelta - basis) / basis,
            basis,
            proceeds: sDelta,
            time: tx.blockTime,
          });
        }
        if (lot.qty > 0) {
          lot.qty -= sellQty;
          lot.cost -= basis;
          if (lot.qty < 1e-9) {
            lot.qty = 0;
            lot.cost = 0;
          }
        }
        lot.sells += 1;
      }
      lots.set(delta.mint, lot);
    }
    await sleep(80);
  }

  const closed = trades.length;
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const pnlSol = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const losses = closed - wins;
  const worst = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 3);
  const best = [...trades].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const biggestLossSol = worst[0]?.pnl || 0;
  const score =
    (closed >= MIN_CLOSED_TRADES ? 20 : closed * 2) +
    Math.min(35, (closed ? (wins / closed) * 35 : 0)) +
    Math.max(-20, Math.min(35, pnlSol * 3.5)) +
    Math.max(-12, biggestLossSol * 8);

  return {
    wallet,
    txSample: signatures.length,
    buys,
    sells,
    closed,
    wins,
    losses,
    winRate: closed ? Number(((wins / closed) * 100).toFixed(1)) : null,
    pnlSol: Number(pnlSol.toFixed(4)),
    biggestLossSol: Number(biggestLossSol.toFixed(4)),
    openLots: [...lots.values()].filter((lot) => lot.qty > 1e-9).length,
    score: Number(score.toFixed(1)),
    best: best.map((trade) => ({
      mint: trade.mint,
      pnlSol: Number(trade.pnl.toFixed(4)),
      roiPct: Number((trade.roi * 100).toFixed(1)),
    })),
    worst: worst.map((trade) => ({
      mint: trade.mint,
      pnlSol: Number(trade.pnl.toFixed(4)),
      roiPct: Number((trade.roi * 100).toFixed(1)),
    })),
  };
}

const tokens = await tokenUniverse();
const excludedAddresses = new Set(tokens.flatMap((token) => [token.pairAddress, token.mint]));
console.error(`tokens=${tokens.length}`);

const buyerMap = new Map();
for (const token of tokens) {
  const buyers = await earlyBuyersForToken(token);
  console.error(`${token.symbol} buyers=${buyers.length}`);
  for (const buyer of buyers) {
    if (excludedAddresses.has(buyer.wallet)) continue;
    const entry = buyerMap.get(buyer.wallet) || { wallet: buyer.wallet, hits: 0, spentSol: 0, tokens: new Set() };
    entry.hits += 1;
    entry.spentSol += buyer.spentSol;
    entry.tokens.add(buyer.token);
    buyerMap.set(buyer.wallet, entry);
  }
}

const buyerCandidates = [...buyerMap.values()]
  .map((entry) => ({ ...entry, tokens: [...entry.tokens] }))
  .filter((entry) => entry.hits >= 2 || entry.spentSol >= 1.5)
  .sort((a, b) => b.hits - a.hits || b.spentSol - a.spentSol)
  .slice(0, 45);

console.error(`candidateWallets=${buyerCandidates.length}`);
const analyzed = [];
for (const candidate of buyerCandidates) {
  const stats = await analyzeWallet(candidate.wallet);
  analyzed.push({ ...candidate, ...stats });
  console.error(`${candidate.wallet.slice(0, 6)} closed=${stats.closed} wr=${stats.winRate} pnl=${stats.pnlSol}`);
}

const ranked = analyzed
  .filter((item) => item.closed >= 4 && !excludedAddresses.has(item.wallet))
  .sort((a, b) => b.score - a.score || b.pnlSol - a.pnlSol);

const result = { scannedAt: new Date().toISOString(), tokens, ranked };
console.log(JSON.stringify(result, null, 2));
