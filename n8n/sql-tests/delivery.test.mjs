// Real delivery path: Cursor hook script + extension spool writer →
// personal-monitor.exe (forwarder) → a stand-in for n8n's Activity Ingest
// webhook that runs the workflow's own normalize code and SQL on PGlite.
//
// Checks that queued events survive n8n being down and the monitor being
// killed, and are delivered exactly once afterwards.
// Requires `cargo build` in personal-monitor (skipped otherwise).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { load } from "../test/helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const MONITOR = join(root, "personal-monitor", "target", "debug", "personal-monitor.exe");
const HOOK = join(root, "cursor-activity", "hooks", "cursor-hook.js");
const require = createRequire(import.meta.url);

const storeSql = JSON.parse(readFileSync(join(here, "..", "workflow-templates", "activity-ingest.json"), "utf8"))
    .nodes.find(n => n.name === "Store Raw Events").parameters.query;
const { normalizeBatch } = load(["../../cursor-activity/lib/redact.js", "activity/normalize.js"], ["normalizeBatch"]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function spoolFiles(home) {
    const dir = join(home, "spool");
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".jsonl")) : [];
}

async function waitFor(fn, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await fn()) return true;
        await sleep(250);
    }
    return false;
}

test("events survive n8n outage and monitor restart, then arrive once", { skip: !existsSync(MONITOR) && "personal-monitor not built" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "ai-delivery-"));
    const port = 40000 + Math.floor(Math.random() * 10000);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ n8nUrl: `http://127.0.0.1:${port}`, idleSeconds: 3600 }));
    const env = { ...process.env, AI_ASSISTANT_HOME: home };

    // A repo for the hook to resolve.
    const repo = join(home, "employee-management");
    mkdirSync(join(repo, ".git"), { recursive: true });

    // 1. Cursor agent hook events.
    const hook = (event, payload) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(payload), env, encoding: "utf8" });
    hook("beforeSubmitPrompt", { workspace_roots: ["/" + repo.replace(/\\/g, "/")], prompt: "Make email required" });
    hook("afterShellExecution", { workspace_roots: ["/" + repo.replace(/\\/g, "/")], cwd: repo, command: "npm test", output: "ℹ pass 2\nℹ fail 1\nError: boom" });

    // 2. Extension events (same spool writer the extension uses).
    process.env.AI_ASSISTANT_HOME = home;
    const { makeEvent, writeSpool } = require(join(root, "cursor-activity", "lib", "events.js"));
    writeSpool([
        makeEvent("cursor-ext", "edit_summary", { root: repo, name: "employee-management" }, { file: "src/a.ts", linesAdded: 2, linesRemoved: 0 }),
        makeEvent("cursor-ext", "terminal_command", { root: repo, name: "employee-management" }, { command: "npm test", exitCode: 1 })
    ], "cursor-ext");
    delete process.env.AI_ASSISTANT_HOME;
    assert.equal(spoolFiles(home).length, 3);

    // 3. Monitor runs while n8n is down, then is killed: nothing may be lost.
    let monitor = spawn(MONITOR, ["run"], { env, stdio: "ignore" });
    await sleep(2500);
    monitor.kill();
    await sleep(300);
    assert.ok(spoolFiles(home).length >= 3, "queued files kept while n8n is unreachable");
    const log = readFileSync(join(home, "logs", "monitor.log"), "utf8");
    assert.match(log, /delivery_failed/);

    // 4. n8n comes up (stand-in running the real ingest code + SQL).
    const db = new PGlite();
    await db.exec(readFileSync(join(here, "..", "db", "schema.sql"), "utf8"));
    const requests = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", async () => {
            if (req.url !== "/webhook/activity") { res.writeHead(404).end(); return; }
            const { rows, invalid } = normalizeBatch(JSON.parse(body));
            const result = (await db.query(storeSql, [JSON.stringify(rows), invalid])).rows[0];
            requests.push(result);
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        });
    });
    await new Promise(r => server.listen(port, "127.0.0.1", r));

    monitor = spawn(MONITOR, ["run"], { env, stdio: "ignore" });
    const drained = await waitFor(() => spoolFiles(home).length === 0, 20000);
    monitor.kill();
    server.close();
    assert.ok(drained, "spool drained after n8n came back");

    const stored = (await db.query("SELECT source, type, project_name FROM activity_events ORDER BY source, type")).rows;
    const coding = stored.filter(r => r.source !== "monitor");
    assert.deepEqual(coding.map(r => `${r.source}:${r.type}`), [
        "cursor-ext:edit_summary", "cursor-ext:terminal_command", "cursor-hook:agent_prompt", "cursor-hook:agent_shell"
    ]);
    assert.ok(coding.every(r => r.project_name === "employee-management"));
    assert.ok(stored.some(r => r.source === "monitor" && r.type === "window_focus"), "monitor's own window events delivered too");
    const total = requests.reduce((n, r) => n + r.received, 0);
    const accepted = requests.reduce((n, r) => n + r.accepted, 0);
    assert.equal(accepted, stored.length);
    assert.ok(total >= accepted);

    const status = spawnSync(MONITOR, ["status"], { env, encoding: "utf8" }).stdout;
    assert.match(status, /queued:\s+0 files/);
    assert.match(status, /lastDeliveryAt/);
    rmSync(home, { recursive: true, force: true });
});
