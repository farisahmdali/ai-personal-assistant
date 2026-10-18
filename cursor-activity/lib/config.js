// Shared local settings for all activity collectors, stored in
// %LOCALAPPDATA%\ai-assistant (override with AI_ASSISTANT_HOME):
//   config.json   settings (created by `personal-monitor init`)
//   spool\        events waiting to be delivered to n8n
//   paused        if this file exists, nothing is captured
//   logs\         diagnostics

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_EXCLUDES = [
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
    "**/secrets/**", "**/.secrets/**", "**/node_modules/**", "**/.git/**",
    "**/dist/**", "**/build/**", "**/target/**", "**/.next/**", "**/out/**"
];

const DEFAULTS = {
    n8nUrl: "http://localhost:5678",
    excludeGlobs: [],
    captureWindowTitles: true,
    idleSeconds: 120,
    outputTailLines: 40
};

function dataDir() {
    if (process.env.AI_ASSISTANT_HOME) return process.env.AI_ASSISTANT_HOME;
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "ai-assistant");
}

function spoolDir() {
    return path.join(dataDir(), "spool");
}

function logsDir() {
    return path.join(dataDir(), "logs");
}

function loadConfig() {
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(path.join(dataDir(), "config.json"), "utf8"));
    } catch {}

    const config = { ...DEFAULTS, ...user };
    config.excludeGlobs = [...DEFAULT_EXCLUDES, ...(Array.isArray(user.excludeGlobs) ? user.excludeGlobs : [])];
    return config;
}

function isPaused() {
    return fs.existsSync(path.join(dataDir(), "paused"));
}

function setPaused(paused) {
    const file = path.join(dataDir(), "paused");
    fs.mkdirSync(dataDir(), { recursive: true });
    if (paused) fs.writeFileSync(file, new Date().toISOString());
    else fs.rmSync(file, { force: true });
}

function logError(name, err) {
    try {
        fs.mkdirSync(logsDir(), { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), level: "error", message: String(err && err.stack || err) });
        fs.appendFileSync(path.join(logsDir(), name), line + "\n");
    } catch {}
}

module.exports = { DEFAULTS, DEFAULT_EXCLUDES, dataDir, spoolDir, logsDir, loadConfig, isPaused, setPaused, logError };
