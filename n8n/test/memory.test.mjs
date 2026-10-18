import { test } from "node:test";
import assert from "node:assert/strict";
import { load, runNode } from "./helpers.mjs";

const lib = load(["memory.js"], ["buildActivity", "buildRequest", "parseMemory"]);

const row = {
    activity_id: "abc123",
    website: "github.com",
    page_title: "Create a New Repository",
    started_at: "2026-10-08T03:35:00.000Z",
    last_event_at: "2026-10-08T03:40:00.000Z",
    attempts: 1,
    events: [
        { at: "2026-10-08T03:35:00.000Z", kind: "navigation", text: 'Opened "Create a New Repository" (github.com/new)' },
        { at: "2026-10-08T03:36:10.000Z", kind: "input", text: 'Entered "personal-assistant" into "Repository name"' }
    ]
};

const reply = content => ({ choices: [{ message: { content } }] });

test("activity is grouped with local times", () => {
    const activity = lib.buildActivity(row, "Asia/Kolkata");
    assert.equal(activity.sessionId, "abc123");
    assert.deepEqual(activity.timeRange, { start: "2026-10-08 09:05:00", end: "2026-10-08 09:10:00" });
    assert.equal(activity.events[1], '09:06:10 Entered "personal-assistant" into "Repository name"');
});

test("long activities are capped", () => {
    const many = { ...row, events: Array.from({ length: 400 }, (_, i) => ({ at: row.started_at, text: "event " + i })) };
    const activity = lib.buildActivity(many, "UTC");
    assert.equal(activity.events.length, 151);
    assert.equal(activity.events.at(-1), "(250 more events omitted)");
});

test("request carries model and system prompt", () => {
    const body = lib.buildRequest({ events: [] }, "some/model");
    assert.equal(body.model, "some/model");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /shouldStore/);
});

test("memory reply is parsed, even inside code fences", () => {
    const r = lib.parseMemory(reply('```json\n{"shouldStore": true, "summary": "Created a repo.", "details": ["a", 3], "entities": [{"type": "project", "name": "AI Personal Assistant"}], "pendingTask": null, "importance": 1.4}\n```'), 1);
    assert.equal(r.action, "store");
    assert.equal(r.memory.summary, "Created a repo.");
    assert.deepEqual(r.memory.details, ["a"]);
    assert.equal(r.memory.importance, 1);
    assert.equal(r.memory.memoryType, "activity");
    assert.equal(r.memory.pendingTask, null);
});

test("insignificant activity is discarded", () => {
    assert.deepEqual(lib.parseMemory(reply('{"shouldStore": false}'), 1), { action: "discard" });
});

test("failures retry, then drop", () => {
    assert.equal(lib.parseMemory({ error: { message: "rate limited" } }, 1).action, "retry");
    assert.equal(lib.parseMemory(reply("not json"), 2).action, "retry");
    assert.equal(lib.parseMemory(reply("not json"), 3).action, "drop");
});

test("Code nodes run with n8n-style globals", () => {
    const built = runNode("nodes/build-activity.js", {
        input: [{ json: row }],
        nodes: { Config: [{ json: { model: "m", timezone: "Asia/Kolkata" } }] }
    });
    assert.equal(built[0].json.activityId, "abc123");
    assert.equal(built[0].json.requestBody.model, "m");

    const parsed = runNode("nodes/parse-memory.js", {
        input: [{ json: reply('{"shouldStore": true, "summary": "Did a thing."}') }],
        nodes: { "Build Activity": built }
    });
    assert.equal(parsed[0].json.action, "store");
    assert.equal(parsed[0].json.summary, "Did a thing.");
    assert.equal(parsed[0].json.details, "[]");
    assert.equal(parsed[0].json.pendingTask, "");
});
