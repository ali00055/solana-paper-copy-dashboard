const RPC = "https://solana-rpc.publicnode.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_TOKENS = 18;
const SIGS_PER_PAIR = 30;
const TX_SAMPLE_PER_WALLET = 55;
const MIN_BUY_SOL = 0.05;
const MIN_CLOSED_TRADES = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function rpc(method, params, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
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

async function tokenUniverse() {
  const [profiles, boosts] = await Promise.all([
    getJson("https://api.dexscreener.com/token-profiles/latest/v1").catch(() => []),
    getJson("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
  ]);
  const unique = [...new Set([...profiles, ...boosts]
    .filter((item) => item.chainId === "solana" && item.tokenAddress)
    .map((item) => item.tokenAddress))].slice(0, 60);

  const enriched = [];
  for (const mint of unique) {
    const data = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
    const pair = (data?.pairs || [])
      .filter((p) => p.chainId === "solana" && p.pairAddress)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    if (!pair) continue;
    const volume24 = pair.volume?.h24 || 0;
    const buys24 = pair.txns?.h24?.buys || 0;
    const fdv = pair.fdv || pair.marketCap || 0;
    if (volume24 < 10000 || buys24 < 80 || fdv > 1_500_000) continue;
    enriched.push({
      mint,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken?.symbol || mint.slice(0, 6),
      volume24,
      buys24,
      change24: pair.priceChange?.h24 ?? null,
      liquidityUsd: pair.liquidity?.usd || 0,
      fdv,
    });
    if (enriched.length >= MAX_TOKENS) break;
    await sleep(80);
  }
  return enriched;
}

async function earlyBuyersForToken(token) {
  const signatures = await rpc("getSignaturesForAddress", [token.pairAddress, { limit: SIGS_PER_PAIR }]) || [];
  const buyers = [];
  for (const sig of signatures.reverse()) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    for (const delta of tokenDeltasByOwner(tx)) {
      if (delta.mint !== token.mint || delta.delta <= 0) continue;
      const spentSol = -solDelta(tx, delta.owner);
      if (spentSol >= MIN_BUY_SOL) {
        buyers.push({ wallet: delta.owner, token: token.symbol, mint: token.mint, spentSol, sig: sig.signature });
      }
    }
    await sleep(45);
  }
  return buyers;
}

async function analyzeWallet(wallet) {
  const signatures = await rpc("getSignaturesForAddress", [wallet, { limit: TX_SAMPLE_PER_WALLET }]) || [];
  const lots = new Map();
  const trades = [];
  let buys = 0;
  let sells = 0;

  for (const sig of signatures.reverse()) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    const sDelta = solDelta(tx, wallet);
    for (const delta of tokenDeltasByOwner(tx).filter((item) => item.owner === wallet)) {
      const lot = lots.get(delta.mint) || { qty: 0, cost: 0 };
      if (delta.delta > 0 && sDelta < -0.01) {
        buys += 1;
        lot.qty += delta.delta;
        lot.cost += -sDelta;
      } else if (delta.delta < 0 && sDelta > 0.01) {
        sells += 1;
        const sellQty = -delta.delta;
        const basis = lot.qty > 0 ? lot.cost * Math.min(1, sellQty / lot.qty) : 0;
        if (basis > 0) trades.push({ mint: delta.mint, pnl: sDelta - basis, roi: (sDelta - basis) / basis });
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
    await sleep(35);
  }

  const closed = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const pnlSol = trades.reduce((sum, t) => sum + t.pnl, 0);
  const biggestLossSol = Math.min(0, ...trades.map((t) => t.pnl));
  const best = [...trades].sort((a, b) => b.roi - a.roi).slice(0, 3);
  const threeX = trades.filter((t) => t.roi >= 2).length;
  const fiveX = trades.filter((t) => t.roi >= 4).length;
  const noisePenalty = Math.max(0, buys - 35) * 0.7;
  const lossPenalty = Math.abs(biggestLossSol) * 5;
  const score =
    Math.min(25, closed * 2) +
    (closed ? (wins / closed) * 25 : 0) +
    Math.min(30, Math.max(-20, pnlSol * 4)) +
    threeX * 8 +
    fiveX * 10 -
    noisePenalty -
    lossPenalty;

  return {
    wallet,
    txSample: signatures.length,
    buys,
    sells,
    closed,
    winRate: closed ? Number(((wins / closed) * 100).toFixed(1)) : null,
    pnlSol: Number(pnlSol.toFixed(4)),
    biggestLossSol: Number(biggestLossSol.toFixed(4)),
    threeX,
    fiveX,
    score: Number(score.toFixed(1)),
    best: best.map((t) => ({ mint: t.mint, pnlSol: Number(t.pnl.toFixed(4)), roiPct: Number((t.roi * 100).toFixed(1)) })),
  };
}

const tokens = await tokenUniverse();
console.error(`tokens=${tokens.length}`);
const excluded = new Set(tokens.flatMap((t) => [t.mint, t.pairAddress]));
const map = new Map();
for (const token of tokens) {
  const buyers = await earlyBuyersForToken(token);
  console.error(`${token.symbol} buyers=${buyers.length}`);
  for (const buyer of buyers) {
    if (excluded.has(buyer.wallet)) continue;
    const entry = map.get(buyer.wallet) || { wallet: buyer.wallet, hits: 0, spentSol: 0, tokens: new Set() };
    entry.hits += 1;
    entry.spentSol += buyer.spentSol;
    entry.tokens.add(buyer.token);
    map.set(buyer.wallet, entry);
  }
}

const candidates = [...map.values()]
  .map((x) => ({ ...x, tokens: [...x.tokens], spentSol: Number(x.spentSol.toFixed(3)) }))
  .filter((x) => x.hits >= 2 || x.spentSol >= 1)
  .sort((a, b) => b.hits - a.hits || b.spentSol - a.spentSol)
  .slice(0, 30);

const analyzed = [];
for (const candidate of candidates) {
  const stats = await analyzeWallet(candidate.wallet);
  const item = { ...candidate, ...stats };
  analyzed.push(item);
  console.error(`${item.wallet} closed=${item.closed} wr=${item.winRate} pnl=${item.pnlSol} x=${item.threeX}/${item.fiveX} score=${item.score}`);
}

const ranked = analyzed
  .filter((x) => x.closed >= MIN_CLOSED_TRADES)
  .sort((a, b) => b.score - a.score || b.pnlSol - a.pnlSol);

console.log(JSON.stringify({ scannedAt: new Date().toISOString(), tokens, candidates, ranked }, null, 2));
