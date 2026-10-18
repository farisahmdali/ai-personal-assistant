// Runs hooks/cursor-hook.js as Cursor would (JSON on stdin) and checks the
// spool output, the reply, and redaction.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "hooks", "cursor-hook.js");

function setup() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-home-"));
    const repo = path.join(home, "employee-management");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    return { home, repo };
}

function runHook(home, event, payload) {
    const r = spawnSync(process.execPath, [HOOK, event], {
        input: JSON.stringify(payload),
        env: { ...process.env, AI_ASSISTANT_HOME: home },
        encoding: "utf8",
        timeout: 10000
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

function spooled(home) {
    const dir = path.join(home, "spool");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .flatMap(f => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse));
}

const common = { conversation_id: "c1", generation_id: "g1", model: "claude" };

test("every verified hook event becomes a redacted activity event", () => {
    const { home, repo } = setup();
    // Cursor sends workspace roots as URI paths, e.g. "/c:/Users/me/app".
    const uriPath = "/" + repo.replace(/\\/g, "/");
    const roots = { workspace_roots: [uriPath], hook_event_name: "x", cursor_version: "3.17.8", user_email: "me@example.com" };

    assert.deepEqual(runHook(home, "beforeSubmitPrompt", {
        ...common, ...roots,
        prompt: "Fix the validation in AddEmployee. My key is sk-or-v1-0123456789abcdefghijklmnop",
        attachments: [{ type: "file", file_path: path.join(repo, "src", "AddEmployee.tsx") }],
        composer_mode: "agent"
    }), { continue: true });

    assert.deepEqual(runHook(home, "afterFileEdit", {
        ...common, ...roots,
        file_path: path.join(repo, "src", "employee.service.ts"),
        edits: [{ old_string: "validate(a)", new_string: "validate(a)\nvalidateEmail(a.email)" }]
    }), {});

    runHook(home, "afterShellExecution", {
        ...common, ...roots, cwd: repo,
        command: "npm test", duration: 2100,
        output: "ℹ pass 4\nℹ fail 1\nError: expected 400 got 200 (token=abcd1234efgh5678)"
    });

    runHook(home, "afterAgentResponse", { ...common, ...roots, text: "I updated the validation.", output_tokens: 120 });
    runHook(home, "postToolUseFailure", { ...common, ...roots, tool_name: "edit_file", error: "file locked" });
    runHook(home, "stop", { ...common, ...roots, status: "completed" });

    // Excluded file: no event.
    runHook(home, "afterFileEdit", { ...common, ...roots, file_path: path.join(repo, ".env"), edits: [{ old_string: "", new_string: "A=1" }] });

    const events = spooled(home);
    assert.deepEqual(events.map(e => e.type), ["agent_prompt", "agent_file_edit", "agent_shell", "agent_response", "agent_tool_failure", "agent_stop"]);
    assert.ok(events.every(e => e.source === "cursor-hook" && e.project.name === "employee-management" && e.id && e.ts));

    const [prompt, edit, shell] = events;
    assert.ok(!prompt.data.prompt.includes("0123456789abcdef"));
    assert.deepEqual(prompt.data.attachments, ["src/AddEmployee.tsx"]);
    assert.equal(edit.data.file, "src/employee.service.ts");
    assert.equal(edit.data.linesAdded, 1);
    assert.deepEqual(shell.data.tests, { passed: 4, failed: 1 });
    assert.ok(shell.data.errorLines.some(l => l.includes("expected 400 got 200")));
    assert.ok(!JSON.stringify(shell).includes("abcd1234efgh5678"));
    assert.ok(!JSON.stringify(events).includes("me@example.com"), "user email must not be stored");

    fs.rmSync(home, { recursive: true, force: true });
});

test("paused: replies but records nothing; bad input never fails", () => {
    const { home } = setup();
    fs.writeFileSync(path.join(home, "paused"), "");
    assert.deepEqual(runHook(home, "beforeSubmitPrompt", { prompt: "hi" }), { continue: true });
    assert.equal(spooled(home).length, 0);

    fs.rmSync(path.join(home, "paused"));
    const r = spawnSync(process.execPath, [HOOK, "afterFileEdit"], {
        input: "not json", env: { ...process.env, AI_ASSISTANT_HOME: home }, encoding: "utf8"
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "{}");
    assert.ok(fs.existsSync(path.join(home, "logs", "cursor-hook.log")));
    fs.rmSync(home, { recursive: true, force: true });
});

test("install script merges into existing hooks without touching others", async () => {
    const { updateHooks, HOOK_EVENTS } = await import("../scripts/install-hooks.mjs");
    const existing = { version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }] } };

    const installed = updateHooks(existing, "C:/x/cursor-hook.js");
    assert.deepEqual(installed.hooks.afterFileEdit, [
        { command: "./format.sh" },
        { command: 'node "C:/x/cursor-hook.js" afterFileEdit' }
    ]);
    assert.equal(Object.keys(installed.hooks).length, HOOK_EVENTS.length);

    // Reinstalling does not duplicate; removing restores the original.
    assert.deepEqual(updateHooks(installed, "C:/x/cursor-hook.js"), installed);
    assert.deepEqual(updateHooks(installed, "C:/x/cursor-hook.js", true), existing);
});
