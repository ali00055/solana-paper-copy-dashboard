import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const intervalMs = 10000;

function log(message) {
  fs.appendFileSync(path.join(cwd, "watchdog.log"), `[${new Date().toISOString()}] ${message}\n`);
}

function pidFile(script) {
  return path.join(cwd, script.replace(/\.mjs$/i, ".pid"));
}

function readPid(script) {
  try {
    const value = Number(fs.readFileSync(pidFile(script), "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startScript(script, outFile, errFile) {
  const out = fs.openSync(path.join(cwd, outFile), "a");
  const err = fs.openSync(path.join(cwd, errFile), "a");
  const child = spawn(process.execPath, [script], {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err]
  });
  child.unref();
  fs.writeFileSync(pidFile(script), String(child.pid));
  log(`started ${script} pid=${child.pid}`);
}

async function httpOk(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function tick() {
  const hasServer = isRunning(readPid("server.mjs"));
  const hasBot = isRunning(readPid("bot.mjs"));

  if (!hasServer) {
    startScript("server.mjs", "dashboard.out.log", "dashboard.err.log");
  } else if (!(await httpOk("http://localhost:8787/api/health"))) {
    log("server process exists but health check failed");
  }

  if (!hasBot) {
    startScript("bot.mjs", "bot.out.log", "bot.err.log");
  }
}

log("watchdog started");
fs.writeFileSync(pidFile("watchdog.mjs"), String(process.pid));
await tick();
setInterval(() => tick().catch((error) => log(`tick error: ${error.message}`)), intervalMs);
