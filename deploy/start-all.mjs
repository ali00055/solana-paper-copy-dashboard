import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : "";
const filesToPersist = [
  "config.json",
  "paper-state.json",
  "paper-events.ndjson",
  "oracle-watchlist.json",
  "free-alpha-radar-result.json",
  "oracle-discovery-result.json",
  "social-radar-result.json",
  "trend-map-result.json",
  "codex-mobile-chat.json"
];

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensurePersistentFile(name) {
  if (!dataDir) return;
  await fs.mkdir(dataDir, { recursive: true });
  const source = path.join(root, name);
  const target = path.join(dataDir, name);
  if (!(await pathExists(target)) && (await pathExists(source))) {
    await fs.copyFile(source, target);
  }
  if (existsSync(source)) {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) return;
    await fs.rm(source, { force: true });
  }
  await fs.symlink(target, source).catch(async () => {
    if (!(await pathExists(source))) await fs.copyFile(target, source).catch(() => {});
  });
}

async function jsonCount(file, key) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(value?.[key]) ? value[key].length : 0;
  } catch {
    return 0;
  }
}

async function lineCount(file) {
  try {
    return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function restoreRicherSeed(name, seedName, kind) {
  const source = path.join(root, name);
  const target = dataDir ? path.join(dataDir, name) : source;
  const seed = path.join(root, seedName);
  if (!(await pathExists(seed))) return;
  if (kind === "state") {
    const seedScore = await jsonCount(seed, "closedTrades") + await jsonCount(seed, "processedSignatures");
    const currentScore = await jsonCount(target, "closedTrades") + await jsonCount(target, "processedSignatures");
    if (seedScore > currentScore) await fs.copyFile(seed, target);
    return;
  }
  if (kind === "events") {
    if ((await lineCount(seed)) > (await lineCount(target))) await fs.copyFile(seed, target);
  }
}

async function prepareDataDir() {
  if (!(await pathExists(path.join(root, "config.json")))) {
    if (await pathExists(path.join(root, "config.seed.json"))) {
      await fs.copyFile(path.join(root, "config.seed.json"), path.join(root, "config.json"));
    } else if (await pathExists(path.join(root, "config.example.json"))) {
      await fs.copyFile(path.join(root, "config.example.json"), path.join(root, "config.json"));
    }
  }
  if (!(await pathExists(path.join(root, "paper-state.json"))) && (await pathExists(path.join(root, "paper-state.seed.json")))) {
    await fs.copyFile(path.join(root, "paper-state.seed.json"), path.join(root, "paper-state.json"));
  }
  if (!(await pathExists(path.join(root, "paper-events.ndjson"))) && (await pathExists(path.join(root, "paper-events.seed.ndjson")))) {
    await fs.copyFile(path.join(root, "paper-events.seed.ndjson"), path.join(root, "paper-events.ndjson"));
  }
  if (!(await pathExists(path.join(root, "free-alpha-radar-result.json"))) && (await pathExists(path.join(root, "free-alpha-radar-result.seed.json")))) {
    await fs.copyFile(path.join(root, "free-alpha-radar-result.seed.json"), path.join(root, "free-alpha-radar-result.json"));
  }
  if (!dataDir) return;
  for (const file of filesToPersist) await ensurePersistentFile(file);
  if ((await pathExists(path.join(root, "config.seed.json")))) {
    const seedWallets = await jsonCount(path.join(root, "config.seed.json"), "wallets");
    const currentWallets = await jsonCount(path.join(dataDir, "config.json"), "wallets");
    if (seedWallets > currentWallets) await fs.copyFile(path.join(root, "config.seed.json"), path.join(dataDir, "config.json"));
  }
  await restoreRicherSeed("paper-state.json", "paper-state.seed.json", "state");
  await restoreRicherSeed("paper-events.ndjson", "paper-events.seed.ndjson", "events");
  if (!(await pathExists(path.join(dataDir, "free-alpha-radar-result.json"))) && (await pathExists(path.join(root, "free-alpha-radar-result.seed.json")))) {
    await fs.copyFile(path.join(root, "free-alpha-radar-result.seed.json"), path.join(dataDir, "free-alpha-radar-result.json"));
  }
}

function start(name, script) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.error(`[${name}] exited code=${code} signal=${signal}`);
    process.exitCode = code || 1;
    shutdown();
  });
  return child;
}

const children = [];
let stopping = false;

async function writeManagedPid(name, pid) {
  await fs.writeFile(path.join(root, `${name}.pid`), String(pid), "utf8").catch(() => {});
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(process.exitCode || 0), 2500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await prepareDataDir();
if (process.env.START_BOT !== "false") {
  const bot = start("bot", "bot.mjs");
  children.push(bot);
  await writeManagedPid("bot", bot.pid);
}
if (process.env.START_PANEL !== "false") {
  const panel = start("panel", "server.mjs");
  children.push(panel);
  await writeManagedPid("server", panel.pid);
}
if (!children.length) {
  console.error("START_BOT=false and START_PANEL=false; nothing to run.");
  process.exit(1);
}
