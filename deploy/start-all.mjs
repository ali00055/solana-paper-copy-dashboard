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

async function prepareDataDir() {
  if (!(await pathExists(path.join(root, "config.json"))) && (await pathExists(path.join(root, "config.example.json")))) {
    await fs.copyFile(path.join(root, "config.example.json"), path.join(root, "config.json"));
  }
  if (!dataDir) return;
  for (const file of filesToPersist) await ensurePersistentFile(file);
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
if (process.env.START_BOT !== "false") children.push(start("bot", "bot.mjs"));
if (process.env.START_PANEL !== "false") children.push(start("panel", "server.mjs"));
if (!children.length) {
  console.error("START_BOT=false and START_PANEL=false; nothing to run.");
  process.exit(1);
}
