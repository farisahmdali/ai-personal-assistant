// End-to-end test of the Activity Ingest and Coding Session Builder SQL with
// the real Code-node logic in between, on PGlite (real Postgres in WASM).
// The AI call is replaced by canned replies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { load } from "../test/helpers.mjs";

const n8nDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = readFileSync(join(n8nDir, "db", "schema.sql"), "utf8");
const node = (workflow, name) =>
    JSON.parse(readFileSync(join(n8nDir, "workflow-templates", workflow + ".json"), "utf8"))
        .nodes.find(n => n.name === name).parameters.query;

const SQL = {
    store: node("activity-ingest", "Store Raw Events"),
    loadUnassigned: node("coding-session-builder", "Load Unassigned Events"),
    apply: node("coding-session-builder", "Apply Sessions"),
    claim: node("coding-session-builder", "Claim Sessions"),
    save: node("coding-session-builder", "Save Memory And Session"),
    browserSave: node("memory-builder", "Save Memory And Clean Up")
};

const lib = load(
    ["../../cursor-activity/lib/redact.js", "activity/normalize.js", "coding/sessionize.js", "coding/evidence.js", "coding/summary.js"],
    ["normalizeBatch", "sessionize", "buildEvidence", "parseCodingSummary"]
);

const CONFIG = { idleMinutes: 20, interimMinutes: 30, rawRetentionDays: 3 };
const ROOT_A = "c:/code/employee-management";
const ROOT_B = "c:/code/billing-api";
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString();
let seq = 0;

function ev(type, root, minAgo, data = {}, source = "cursor-ext") {
    return {
        id: `t-${type}-${seq++}`,
        ts: minutesAgo(minAgo),
        source,
        type,
        project: root ? { root, name: root.split("/").pop() } : null,
        data
    };
}

async function ingest(db, events) {
    const { rows, invalid } = lib.normalizeBatch({ events });
    return (await db.query(SQL.store, [JSON.stringify(rows), invalid])).rows[0];
}

// Mirrors the Coding Session Builder workflow; `ai` returns a reply per session.
async function runBuilder(db, ai) {
    const loaded = (await db.query(SQL.loadUnassigned)).rows[0].data;
    const plan = lib.sessionize(loaded.events, loaded.sessions, CONFIG.idleMinutes);
    await db.query(SQL.apply, [JSON.stringify(plan)]);

    const claimed = (await db.query(SQL.claim, [CONFIG.idleMinutes, CONFIG.interimMinutes, CONFIG.rawRetentionDays])).rows;
    const results = [];

    for (const row of claimed) {
        const built = lib.buildEvidence(row, { sendDiffs: true, timezone: "Asia/Kolkata" });
        const reply = ai(row, built);
        const parsed = lib.parseCodingSummary(reply, {
            attempts: row.attempts,
            evidenceIds: built.items.map(i => i.id),
            facts: built.facts,
            currentMemoryId: row.memory_id ? Number(row.memory_id) : null,
            openTaskIds: (row.open_tasks || []).map(t => Number(t.id))
        });
        const m = parsed.memory;
        const memory = m ? {
            sessionId: row.session_id, projectRoot: row.project_root, projectName: row.project_name,
            startedAt: new Date(row.started_at).toISOString(), endedAt: new Date(row.last_event_at).toISOString(),
            title: m.title, taskKey: m.taskKey, summary: m.summary, status: m.status,
            details: m.observedChanges.map(c => c.text), entities: [{ type: "project", name: row.project_name }],
            files: m.files, evidence: { nextSteps: m.nextSteps, blockers: m.blockers, items: built.items },
            pendingTask: m.pendingTask || "", confidence: m.confidence, importance: m.importance,
            targetMemoryId: m.targetMemoryId, relatedMemoryId: m.relatedMemoryId
        } : {};

        const saved = (await db.query(SQL.save, [row.session_id, parsed.action, row.final ? "true" : "false", JSON.stringify(memory), built.processedUntil])).rows[0];
        results.push({ row, built, parsed, saved });
    }
    return results;
}

const reply = obj => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

test("raw events → sessions → memories, without mixing projects or duplicating", async () => {
    const db = new PGlite();
    await db.exec(schema);
    await db.exec(schema); // rerunnable

    // Project A: manual edits + failing test. Project B: one edit. Monitor context.
    const batch = [
        ev("window_focus", null, 40, { category: "coding", application: "Cursor.exe" }, "monitor"),
        ev("workspace_opened", ROOT_A, 40),
        ev("edit_summary", ROOT_A, 38, { file: "src/AddEmployee.tsx", linesAdded: 3, linesRemoved: 8, diff: "-fax\n+email" }),
        ev("edit_summary", ROOT_A, 36, { file: "src/employee.service.ts", linesAdded: 5, linesRemoved: 0, diff: "+validateEmail()" }),
        ev("terminal_command", ROOT_A, 34, { command: "npm test", exitCode: 1, tests: { passed: 9, failed: 1 }, errorLines: ["expected 400 got 201"] }),
        ev("edit_summary", ROOT_B, 33, { file: "src/invoice.ts", linesAdded: 1, linesRemoved: 1 })
    ];

    assert.deepEqual(await ingest(db, batch), { received: 6, accepted: 6, invalid: 0 });
    // Retried delivery of the same batch: nothing new stored.
    assert.deepEqual(await ingest(db, batch), { received: 6, accepted: 0, invalid: 0 });

    const results = await runBuilder(db, row => row.project_root === ROOT_A
        ? reply({
            shouldStore: true, taskKey: "employee-email-validation", title: "Employee email validation",
            summary: "Replacing the fax field with a required email on the employee form and service.",
            status: "completed", observedChanges: [{ text: "Removed fax input", evidence: ["E1"] }],
            blockers: ["npm test: expected 400 got 201"], nextSteps: ["Fix API validation", "Rerun npm test"], confidence: 0.75
        })
        : reply({ shouldStore: false }));

    assert.equal(results.length, 2, "one session per project");
    const a = results.find(r => r.row.project_root === ROOT_A);
    const b = results.find(r => r.row.project_root === ROOT_B);
    assert.equal(a.row.final, true);
    assert.equal(a.row.events.length, 4);
    assert.ok(a.row.context.length >= 1, "monitor context is attached by time");
    assert.ok(!a.row.events.some(e => e.data.file === "src/invoice.ts"), "project B events are not in project A");
    assert.equal(a.parsed.memory.status, "in_progress", "failing tests: not completed");
    assert.ok(a.saved.memory_id);
    assert.equal(a.saved.session_status, "closed");
    assert.equal(b.saved.memory_id, null);
    assert.equal(b.saved.session_status, "closed");

    let memories = (await db.query("SELECT * FROM memories")).rows;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].project, "employee-management");
    assert.equal(memories[0].memory_type, "coding_task");
    assert.equal(memories[0].pending_task, "Blocked: npm test: expected 400 got 201 — next: Fix API validation");
    assert.deepEqual(memories[0].files.sort(), ["src/AddEmployee.tsx", "src/employee.service.ts"]);

    const unprocessed = (await db.query("SELECT count(*)::int AS n FROM activity_events WHERE project_root IS NOT NULL AND processed_at IS NULL")).rows[0].n;
    assert.equal(unprocessed, 0);

    // Nothing left to do: a second run claims nothing.
    assert.equal((await runBuilder(db, () => { throw new Error("should not be called"); })).length, 0);

    // Later the user continues the same task in project A (new session).
    const firstId = Number(memories[0].id);
    await ingest(db, [
        ev("edit_summary", ROOT_A, 25, { file: "src/api/validation.ts", linesAdded: 4, linesRemoved: 1, diff: "+if (!dto.email) throw" }),
        ev("terminal_command", ROOT_A, 22, { command: "npm test", exitCode: 0, tests: { passed: 10, failed: 0 } }),
        ev("git_commit", ROOT_A, 21, { hash: "a1b2c3d4", branch: "feature/email", message: "Require employee email" })
    ]);

    const second = await runBuilder(db, (row, built) => {
        assert.equal(row.memory_id, null);
        assert.deepEqual(row.open_tasks.map(t => Number(t.id)), [firstId]);
        assert.ok(built.facts.hasPassingTest && built.facts.hasCommit);
        return reply({
            shouldStore: true, title: "Employee email validation", summary: "Email is now required; tests pass and the change is committed.",
            status: "completed", continuesMemoryId: firstId, nextSteps: []
        });
    });

    assert.equal(second.length, 1);
    memories = (await db.query("SELECT * FROM memories")).rows;
    assert.equal(memories.length, 1, "continued task updates the existing memory");
    assert.equal(Number(second[0].saved.memory_id), firstId);
    assert.equal(memories[0].status, "completed");
    assert.equal(memories[0].pending_task, null);
    assert.ok(memories[0].files.includes("src/api/validation.ts") && memories[0].files.includes("src/AddEmployee.tsx"), "files merged");
    assert.ok(memories[0].updated_at);
});

test("long sessions get interim updates; failed AI calls are retried", async () => {
    const db = new PGlite();
    await db.exec(schema);

    // Active for 40 minutes and still going: interim summary, session stays open.
    await ingest(db, [40, 30, 20, 10, 1].map((m, i) => ev("edit_summary", ROOT_A, m, { file: i % 2 ? "b.ts" : "a.ts", linesAdded: 1 })));

    const interim = await runBuilder(db, () => reply({ shouldStore: true, summary: "Working on a and b.", status: "in_progress", nextSteps: ["continue"] }));
    assert.equal(interim.length, 1);
    assert.equal(interim[0].row.final, false);
    assert.equal(interim[0].saved.session_status, "open");

    // New events join the same session and update the same memory later.
    await ingest(db, [ev("edit_summary", ROOT_A, 0, { file: "c.ts", linesAdded: 2 })]);
    await db.exec("UPDATE work_sessions SET last_summarized_at = now() - interval '31 minutes'");
    const update = await runBuilder(db, row => {
        assert.ok(row.current_memory && row.current_memory.summary === "Working on a and b.");
        assert.equal(row.events.length, 1, "only new events are sent");
        return reply({ shouldStore: true, summary: "Working on a, b and c.", status: "in_progress" });
    });
    assert.equal(update[0].saved.memory_id, interim[0].saved.memory_id);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM memories")).rows[0].n, 1);

    // AI failure: session reopens, events stay unprocessed, retried next run.
    await ingest(db, [ev("edit_summary", ROOT_B, 30, { file: "x.ts", linesAdded: 1 })]);
    const failed = await runBuilder(db, row => row.project_root === ROOT_B ? { error: { message: "rate limited" } } : reply({ shouldStore: false }));
    const b = failed.find(r => r.row.project_root === ROOT_B);
    assert.equal(b.parsed.action, "retry");
    assert.equal(b.saved.session_status, "open");
    const pending = (await db.query("SELECT count(*)::int AS n FROM activity_events WHERE project_root = $1 AND processed_at IS NULL", [ROOT_B])).rows[0].n;
    assert.equal(pending, 1);
});

test("retention removes old raw data; browser memory pipeline still works", async () => {
    const db = new PGlite();
    await db.exec(schema);

    await ingest(db, [ev("window_focus", null, 60 * 24 * 5, { category: "browser" }, "monitor"), ev("window_focus", null, 5, { category: "coding" }, "monitor")]);
    await db.exec("INSERT INTO activity_events (event_id, ts, source, type, project_root, data, processed_at) VALUES ('old', now() - interval '6 days', 'cursor-ext', 'edit_summary', 'c:/x', '{}', now() - interval '5 days')");
    await runBuilder(db, () => reply({ shouldStore: false }));
    const left = (await db.query("SELECT event_id FROM activity_events")).rows.map(r => r.event_id);
    assert.equal(left.length, 1, "only the recent monitor event remains");

    // The existing browser Memory Builder insert still works with the new columns.
    const now = new Date().toISOString();
    await db.exec("INSERT INTO tmp_activities (activity_id, tab_id, website) VALUES ('b1', '7', 'github.com')");
    const saved = (await db.query(SQL.browserSave, ["b1", "store", now, now, "github.com", "New repo", "activity", "Created a repo.", "[]", "[]", "", 0.8])).rows[0];
    assert.ok(saved.memory_id);
    const browser = (await db.query("SELECT memory_type, project, status FROM memories")).rows[0];
    assert.deepEqual(browser, { memory_type: "activity", project: null, status: null });
});
