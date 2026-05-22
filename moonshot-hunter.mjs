const RPC = "https://solana-rpc.publicnode.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_TOKENS = 40;
const SIGS_PER_PAIR = 80;
const TX_SAMPLE_PER_WALLET = 90;

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
    const json = await res.json().catch(() => ({}));
    if (!json.error) return json.result;
    if (attempt === retries) return null;
    await sleep(250 + attempt * 400);
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

async function boostedAndMovingTokens() {
  const [profiles, boosts] = await Promise.all([
    getJson("https://api.dexscreener.com/token-profiles/latest/v1").catch(() => []),
    getJson("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
  ]);
  const unique = [...new Set([...profiles, ...boosts]
    .filter((item) => item.chainId === "solana" && item.tokenAddress)
    .map((item) => item.tokenAddress))].slice(0, 120);

  const tokens = [];
  for (const mint of unique) {
    const data = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
    const pair = (data?.pairs || [])
      .filter((p) => p.chainId === "solana" && p.pairAddress)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    if (!pair) continue;
    const volume24 = pair.volume?.h24 || 0;
    const buys24 = pair.txns?.h24?.buys || 0;
    const fdv = pair.fdv || pair.marketCap || 0;
    const change24 = pair.priceChange?.h24 ?? 0;
    if (volume24 < 8000 || buys24 < 60 || fdv > 2_000_000) continue;
    tokens.push({
      mint,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken?.symbol || mint.slice(0, 6),
      volume24,
      buys24,
      change24,
      liquidityUsd: pair.liquidity?.usd || 0,
      fdv,
      url: pair.url,
    });
    if (tokens.length >= MAX_TOKENS) break;
    await sleep(70);
  }
  return tokens.sort((a, b) => Math.abs(b.change24 || 0) - Math.abs(a.change24 || 0));
}

async function earlyBuyers(token) {
  const sigs = await rpc("getSignaturesForAddress", [token.pairAddress, { limit: SIGS_PER_PAIR }]) || [];
  const buyers = [];
  for (const sig of sigs.reverse()) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    for (const delta of tokenDeltasByOwner(tx)) {
      if (delta.mint !== token.mint || delta.delta <= 0) continue;
      const spentSol = -solDelta(tx, delta.owner);
      if (spentSol >= 0.02) {
        buyers.push({
          wallet: delta.owner,
          token: token.symbol,
          mint: token.mint,
          spentSol,
          time: tx.blockTime,
          sig: sig.signature,
          change24: token.change24,
          fdv: token.fdv,
          url: token.url,
        });
      }
    }
    await sleep(35);
  }
  return buyers;
}

async function walletMoonshotProfile(wallet) {
  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: TX_SAMPLE_PER_WALLET }]) || [];
  const lots = new Map();
  const trades = [];
  let buys = 0;
  let sells = 0;

  for (const sig of sigs.reverse()) {
    const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta || tx.meta.err) continue;
    const sDelta = solDelta(tx, wallet);
    for (const delta of tokenDeltasByOwner(tx).filter((item) => item.owner === wallet)) {
      const lot = lots.get(delta.mint) || { qty: 0, cost: 0 };
      if (delta.delta > 0 && sDelta < -0.006) {
        buys += 1;
        lot.qty += delta.delta;
        lot.cost += -sDelta;
      } else if (delta.delta < 0 && sDelta > 0.006) {
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
    await sleep(25);
  }

  const closed = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const pnlSol = trades.reduce((sum, t) => sum + t.pnl, 0);
  const best = [...trades].sort((a, b) => b.roi - a.roi).slice(0, 5);
  const worst = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 3);
  const maxRoi = best[0]?.roi ?? 0;
  const threeX = trades.filter((t) => t.roi >= 2).length;
  const fiveX = trades.filter((t) => t.roi >= 4).length;
  const tenX = trades.filter((t) => t.roi >= 9).length;
  const moonScore =
    Math.min(45, Math.max(0, maxRoi) * 4) +
    tenX * 18 + fiveX * 10 + threeX * 5 +
    Math.min(20, Math.max(0, pnlSol) * 2) +
    Math.min(15, closed) -
    Math.max(0, buys - 50) * 0.5 -
    Math.abs(Math.min(0, worst[0]?.pnl || 0)) * 2;

  return {
    wallet,
    buys,
    sells,
    closed,
    winRate: closed ? Number(((wins / closed) * 100).toFixed(1)) : null,
    pnlSol: Number(pnlSol.toFixed(4)),
    maxRoiX: Number((1 + maxRoi).toFixed(2)),
    threeX,
    fiveX,
    tenX,
    biggestLossSol: Number((worst[0]?.pnl || 0).toFixed(4)),
    moonScore: Number(moonScore.toFixed(1)),
    best: best.map((t) => ({ mint: t.mint, pnlSol: Number(t.pnl.toFixed(4)), roiX: Number((1 + t.roi).toFixed(2)) })),
    worst: worst.map((t) => ({ mint: t.mint, pnlSol: Number(t.pnl.toFixed(4)), roiX: Number((1 + t.roi).toFixed(2)) })),
  };
}

const tokens = await boostedAndMovingTokens();
console.error(`tokens=${tokens.length}`);
const walletHits = new Map();
for (const token of tokens) {
  const buyers = await earlyBuyers(token);
  console.error(`${token.symbol} buyers=${buyers.length} change=${token.change24}`);
  for (const buyer of buyers) {
    const item = walletHits.get(buyer.wallet) || { wallet: buyer.wallet, hits: 0, spentSol: 0, tokens: new Set(), examples: [] };
    item.hits += 1;
    item.spentSol += buyer.spentSol;
    item.tokens.add(buyer.token);
    if (item.examples.length < 5) item.examples.push(buyer);
    walletHits.set(buyer.wallet, item);
  }
}

const candidates = [...walletHits.values()]
  .map((x) => ({ ...x, spentSol: Number(x.spentSol.toFixed(3)), tokens: [...x.tokens] }))
  .filter((x) => x.hits >= 2 || x.spentSol >= 0.7)
  .sort((a, b) => b.hits - a.hits || b.spentSol - a.spentSol)
  .slice(0, 35);

const analyzed = [];
for (const c of candidates) {
  const profile = await walletMoonshotProfile(c.wallet);
  analyzed.push({ ...c, ...profile });
  console.error(`${c.wallet.slice(0, 6)} hits=${c.hits} closed=${profile.closed} max=${profile.maxRoiX}x tenX=${profile.tenX} score=${profile.moonScore}`);
}

const ranked = analyzed
  .filter((x) => x.closed >= 3 && x.maxRoiX >= 3)
  .sort((a, b) => b.moonScore - a.moonScore);

console.log(JSON.stringify({ scannedAt: new Date().toISOString(), tokens, ranked }, null, 2));
