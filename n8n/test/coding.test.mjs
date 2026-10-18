import { test } from "node:test";
import assert from "node:assert/strict";
import { load, runNode } from "./helpers.mjs";

const REDACT = "../../cursor-activity/lib/redact.js";
const lib = load(
    [REDACT, "activity/normalize.js", "coding/sessionize.js", "coding/evidence.js", "coding/summary.js"],
    ["normalizeBatch", "sessionize", "buildEvidence", "parseCodingSummary", "buildCodingRequest"]
);

const ROOT_A = "c:/code/employee-management";
const ROOT_B = "c:/code/billing-api";
const at = (min, sec = 0) => new Date(Date.UTC(2026, 9, 11, 4, min, sec)).toISOString(); // 09:30 IST + min

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test("normalizes envelopes, legacy events and rejects junk", () => {
    const { rows, invalid } = lib.normalizeBatch({
        events: [
            { id: "e1", ts: at(1), source: "cursor-ext", type: "edit_summary", project: { root: "C:\\Code\\Employee-Management\\", name: "employee-management" }, data: { file: "a.ts", diff: "+const k = 'sk-live-abcdefghijklmnopqrstuv';" } },
            { id: "e1", ts: at(1), source: "cursor-ext", type: "edit_summary", data: {} },
            { source: "chrome", type: "page_loaded", url: "https://example.com", title: "Example", timestamp: 1791348367 },
            { type: "" },
            "nonsense",
            { id: "future", type: "x", ts: "2999-01-01T00:00:00Z" }
        ]
    }, "2026-10-11T04:00:00.000Z");

    assert.equal(invalid, 2);
    assert.deepEqual(rows.map(r => r.event_id.startsWith("legacy-") ? "legacy" : r.event_id), ["e1", "legacy", "future"]);
    assert.equal(rows[0].project_root, "c:/Code/Employee-Management");
    assert.ok(!rows[0].data.diff.includes("sk-live"), "second-pass redaction");
    assert.deepEqual(rows[1].data, { url: "https://example.com", title: "Example" });
    assert.equal(rows[1].ts, "2026-10-07T04:46:07.000Z");
    assert.equal(rows[2].ts, "2026-10-11T04:00:00.000Z", "future timestamps are clamped");
});

test("oversized event data is capped", () => {
    const { rows } = lib.normalizeBatch([{ id: "big", type: "terminal_command", data: { outputTail: "x".repeat(100000), command: "npm test" } }]);
    assert.ok(JSON.stringify(rows[0].data).length <= 30000);
    assert.equal(rows[0].data.command, "npm test");
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

test("sessions: per project, split by inactivity, join open sessions", () => {
    const events = [
        { event_id: "a1", project_root: ROOT_A, project_name: "employee-management", ts: at(0) },
        { event_id: "b1", project_root: ROOT_B, project_name: "billing-api", ts: at(2) },
        { event_id: "a2", project_root: ROOT_A, project_name: "employee-management", ts: at(10) },
        { event_id: "a3", project_root: ROOT_A, project_name: "employee-management", ts: at(55) } // > 20 min gap
    ];
    const plan = lib.sessionize(events, [], 20);

    const sessionOf = id => plan.assignments.find(a => a.event_id === id).session_id;
    assert.equal(sessionOf("a1"), sessionOf("a2"));
    assert.notEqual(sessionOf("a1"), sessionOf("b1"), "projects are never mixed");
    assert.notEqual(sessionOf("a2"), sessionOf("a3"), "inactivity starts a new session");
    assert.equal(plan.sessions.length, 3);

    // Deterministic ids: same input, same plan.
    assert.deepEqual(lib.sessionize(events, [], 20), plan);

    // A later event joins the existing open session.
    const open = plan.sessions.filter(s => s.session_id === sessionOf("a3"));
    const next = lib.sessionize([{ event_id: "a4", project_root: ROOT_A, project_name: "employee-management", ts: at(60) }], open, 20);
    assert.equal(next.assignments[0].session_id, sessionOf("a3"));
    assert.equal(next.sessions[0].last_event_at, at(60));
});

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

function sessionRow(overrides = {}) {
    return {
        session_id: "ws-1",
        project_root: ROOT_A,
        project_name: "employee-management",
        started_at: at(0),
        last_event_at: at(30),
        attempts: 1,
        memory_id: null,
        final: true,
        events: [
            { id: "1", ts: at(0), source: "cursor-ext", type: "workspace_opened", data: {} },
            { id: "2", ts: at(1), source: "cursor-ext", type: "editor_focus", data: { file: "src/README.md" } },
            { id: "3", ts: at(5), source: "cursor-ext", type: "edit_summary", data: { file: "src/AddEmployee.tsx", language: "typescriptreact", firstChangeAt: at(3), lastChangeAt: at(5), linesAdded: 4, linesRemoved: 9, diff: "-  <input name=\"fax\" />\n+  if (!email) setError('Email required')" } },
            { id: "4", ts: at(8), source: "cursor-hook", type: "agent_prompt", data: { prompt: "Update employee.service.ts validation to require email" } },
            { id: "5", ts: at(9), source: "cursor-hook", type: "agent_file_edit", data: { file: "src/employee.service.ts", linesAdded: 6, linesRemoved: 1, excerpt: "validateEmail(dto.email)" } },
            { id: "6", ts: at(9, 2), source: "cursor-ext", type: "edit_summary", data: { file: "src/employee.service.ts", firstChangeAt: at(9), lastChangeAt: at(9, 1), linesAdded: 6, linesRemoved: 1, diff: "+validateEmail(dto.email)" } },
            { id: "7", ts: at(12), source: "cursor-ext", type: "terminal_command", data: { command: "npm test", exitCode: 1, tests: { passed: 11, failed: 1 }, errorLines: ["AssertionError: expected 400, received 201"] } },
            { id: "8", ts: at(13), source: "cursor-ext", type: "git_state", data: { branch: "feature/employee-form" } }
        ],
        context: [
            { ts: at(0), type: "window_focus", data: { category: "coding" } },
            { ts: at(14), type: "window_focus", data: { category: "browser" } },
            { ts: at(20), type: "window_focus", data: { category: "coding" } },
            { ts: at(25), type: "idle_end", data: { idleSeconds: 300 } }
        ],
        research: [{ start: at(15), website: "stackoverflow.com", summary: "Researched express-validator email validation." }],
        current_memory: null,
        open_tasks: [{ id: 41, title: "Employee form cleanup", summary: "Removing obsolete fields", status: "in_progress" }],
        ...overrides
    };
}

test("evidence separates manual and AI edits and records tests", () => {
    const e = lib.buildEvidence(sessionRow(), { sendDiffs: true, timezone: "Asia/Kolkata" });
    const texts = e.items.map(i => i.text);

    assert.ok(texts.some(t => t.startsWith("src/AddEmployee.tsx (typescriptreact): manual +4 −9")));
    assert.ok(texts.some(t => t.startsWith("src/employee.service.ts: AI agent +6 −1")), texts.join("\n"));
    assert.ok(!texts.some(t => t.includes("employee.service.ts") && t.includes("manual")), "agent edit not counted as manual");
    assert.ok(texts.some(t => t.includes("npm test → exit 1, tests 11 passed / 1 failed") && t.includes("expected 400")));
    assert.ok(texts.some(t => t === "Opened without changing: src/README.md"));
    assert.ok(texts.some(t => t === "Branch: feature/employee-form"));
    assert.ok(texts.some(t => t.includes("stackoverflow.com")));
    assert.ok(e.items[0].detail.includes("Email required"));

    assert.deepEqual(e.facts.filesChanged, ["src/AddEmployee.tsx", "src/employee.service.ts"]);
    assert.equal(e.facts.hasFailingTest, true);
    assert.equal(e.facts.hasPassingTest, false);
    assert.equal(e.facts.lastTestPassed, false);
    assert.deepEqual(e.appTime.minutesByCategory, { coding: 24, browser: 6 });
    assert.equal(e.appTime.contextSwitches, 2);
    assert.equal(e.appTime.idleMinutes, 5);
    assert.equal(e.processedUntil, at(13));
    assert.equal(e.payload.otherOpenTasksInThisProject[0].id, 41);
});

test("sendDiffs=false keeps code out of the AI request", () => {
    const e = lib.buildEvidence(sessionRow(), { sendDiffs: false, timezone: "UTC" });
    assert.ok(e.items.every(i => !i.detail));
    const body = JSON.stringify(lib.buildCodingRequest(e.payload, "m"));
    assert.ok(!body.includes("Email required"));
    assert.ok(body.includes("src/AddEmployee.tsx"));
});

// ---------------------------------------------------------------------------
// summary validation
// ---------------------------------------------------------------------------

const reply = obj => ({ choices: [{ message: { content: "```json\n" + JSON.stringify(obj) + "\n```" } }] });
const ctx = (facts, extra = {}) => ({ attempts: 1, evidenceIds: ["E1", "E2", "E3"], facts, currentMemoryId: null, openTaskIds: [41], ...extra });

test("facts need evidence; completion needs proof", () => {
    const r = lib.parseCodingSummary(reply({
        shouldStore: true, taskKey: "Employee Form Validation!", title: "Employee form validation",
        summary: "Making email required on the employee form and API.", status: "completed",
        observedChanges: [{ text: "Removed fax field", evidence: ["E1"] }, { text: "Fixed the bug", evidence: ["E99"] }],
        inferences: [{ text: "Part of GDPR cleanup", confidence: 2, evidence: ["E2"] }],
        blockers: ["API test expects 400 but gets 201"], nextSteps: ["Fix validation", "Rerun npm test"],
        continuesMemoryId: 41, confidence: 0.8
    }), ctx({ filesChanged: ["src/AddEmployee.tsx"], hasPassingTest: false, lastTestPassed: false, hasCommit: false }));

    assert.equal(r.action, "store");
    const m = r.memory;
    assert.equal(m.taskKey, "employee-form-validation");
    assert.equal(m.status, "in_progress", "edited files alone do not make it complete");
    assert.deepEqual(m.observedChanges, [{ text: "Removed fax field", evidence: ["E1"] }]);
    assert.ok(m.inferences.some(i => i.text === "Fixed the bug" && i.note));
    assert.equal(m.inferences.find(i => i.text === "Part of GDPR cleanup").confidence, 1);
    assert.equal(m.targetMemoryId, 41, "continues the open task instead of duplicating it");
    assert.equal(m.pendingTask, "Blocked: API test expects 400 but gets 201 — next: Fix validation");
    assert.deepEqual(m.files, ["src/AddEmployee.tsx"]);
});

test("completion is accepted with a passing test run or commit", () => {
    const done = { shouldStore: true, summary: "Done.", status: "completed" };
    assert.equal(lib.parseCodingSummary(reply(done), ctx({ hasPassingTest: true, lastTestPassed: true })).memory.status, "completed");
    assert.equal(lib.parseCodingSummary(reply(done), ctx({ hasCommit: true })).memory.status, "completed");
    assert.equal(lib.parseCodingSummary(reply(done), ctx({ hasPassingTest: true, lastTestPassed: false, hasCommit: true })).memory.status, "blocked");
});

test("unknown task ids are ignored, session memory wins, failures retry then drop", () => {
    const r = lib.parseCodingSummary(reply({ shouldStore: true, summary: "x", continuesMemoryId: 999 }), ctx({}));
    assert.equal(r.memory.targetMemoryId, null);

    const s = lib.parseCodingSummary(reply({ shouldStore: true, summary: "x", continuesMemoryId: 41 }), ctx({}, { currentMemoryId: 50 }));
    assert.equal(s.memory.targetMemoryId, 50);
    assert.equal(s.memory.relatedMemoryId, 41);

    assert.deepEqual(lib.parseCodingSummary(reply({ shouldStore: false }), ctx({})), { action: "discard" });
    assert.equal(lib.parseCodingSummary({ error: { message: "429" } }, ctx({})).action, "retry");
    assert.equal(lib.parseCodingSummary({ choices: [{ message: { content: "nope" } }] }, ctx({}, { attempts: 3 })).action, "drop");
});

// ---------------------------------------------------------------------------
// Code nodes
// ---------------------------------------------------------------------------

test("Code nodes run end to end with n8n-style globals", () => {
    const normalized = runNode("nodes/normalize-activity.js", {
        nodes: { "Activity Webhook": [{ json: { body: { events: [{ id: "x1", type: "edit_summary", project: { root: ROOT_A } }] } } }] }
    });
    assert.equal(normalized[0].json.count, 1);

    const config = [{ json: { model: "m", timezone: "Asia/Kolkata", idleMinutes: 20, sendDiffs: true } }];
    const plan = runNode("nodes/sessionize-events.js", {
        input: [{ json: { data: { events: [{ event_id: "x1", project_root: ROOT_A, ts: at(0) }], sessions: [] } } }],
        nodes: { Config: config }
    });
    assert.equal(JSON.parse(plan[0].json.plan).assignments.length, 1);

    const built = runNode("nodes/build-coding-evidence.js", { input: [{ json: sessionRow() }], nodes: { Config: config } });
    assert.equal(built[0].json.requestBody.model, "m");
    assert.deepEqual(built[0].json.openTaskIds, [41]);

    const parsed = runNode("nodes/parse-coding-summary.js", {
        input: [{ json: reply({ shouldStore: true, title: "Employee validation", summary: "Requiring email.", status: "blocked", observedChanges: [{ text: "Removed fax input", evidence: ["E1"] }], blockers: ["npm test fails"], nextSteps: ["fix"] }) }],
        nodes: { "Build Evidence": built }
    });
    const memory = JSON.parse(parsed[0].json.memory);
    assert.equal(parsed[0].json.action, "store");
    assert.equal(parsed[0].json.final, "true");
    assert.equal(memory.projectRoot, ROOT_A);
    assert.equal(memory.status, "blocked");
    assert.ok(memory.details.includes("Removed fax input [E1]"));
    assert.deepEqual(memory.entities[0], { type: "project", name: "employee-management" });
    assert.ok(memory.evidence.items.length > 5);
});
