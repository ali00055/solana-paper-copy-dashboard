import fs from "node:fs/promises";

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const state = await readJson("paper-state.json");
if (!state) {
  console.log("No paper-state.json yet. Bot has not started or has not written state.");
  process.exit(0);
}

let events = [];
try {
  const text = await fs.readFile("paper-events.ndjson", "utf8");
  events = text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-20)
    .map((line) => JSON.parse(line));
} catch {
  events = [];
}

console.log(`Started: ${state.startedAt}`);
console.log(`Cash: ${state.cashTry.toFixed(2)} TL`);
console.log(`Realized PnL: ${state.realizedTry.toFixed(2)} TL`);
console.log(`Open positions: ${state.positions.length}`);

for (const position of state.positions) {
  console.log(
    `- ${position.symbol} ${position.mint} wallet=${position.wallet} invested=${position.investedTry.toFixed(2)} TL entry=${position.entryTry}`
  );
}

console.log("\nLast events:");
for (const event of events.slice(-8)) {
  const symbol = event.symbol || event.mint?.slice(0, 6) || "unknown";
  const detail = event.paper?.position
    ? `PAPER BUY ${event.paper.position.investedTry} TL`
    : event.paper?.pnlTry !== undefined
      ? `PAPER SELL pnl=${event.paper.pnlTry.toFixed(2)} TL`
      : event.paper?.skipped || event.reason || "";
  console.log(`${event.time} ${event.wallet || event.kind} ${event.type || ""} ${symbol} ${detail}`);
}
