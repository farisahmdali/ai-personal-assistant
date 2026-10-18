const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { redact } = require("../lib/redact");
const { createExcluder } = require("../lib/exclude");
const { DEFAULT_EXCLUDES } = require("../lib/config");
const { lineDiff, countLineChanges } = require("../lib/diff");
const { EditAggregator } = require("../lib/aggregate");
const { parseTests, errorLines, stripAnsi } = require("../lib/terminal");
const { resolveProject } = require("../lib/project");

test("redacts secrets but keeps ordinary code readable", () => {
    const input = [
        'const key = "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";',
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234567890",
        "DB_PASSWORD=hunter2hunter2x9",
        "password: 'pa55word'",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
        "postgres://app:s3cretPass@localhost:5432/db",
        "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "const password = getPassword();",
        "function validateToken(token: string) {}"
    ].join("\n");

    const out = redact(input);
    for (const secret of ["d04a8919", "sk-proj-abc", "hunter2hunter2x9", "pa55word", "abcdefghijklmnopqrstuvwxyz012345", "s3cretPass", "ghp_abc", "MIIEow"]) {
        assert.ok(!out.includes(secret), `leaked ${secret}\n${out}`);
    }
    assert.ok(out.includes("const password = getPassword();"));
    assert.ok(out.includes("function validateToken(token: string) {}"));
    assert.ok(out.includes("postgres://app:[REDACTED]@localhost:5432/db"));
});

test("excludes sensitive and generated files", () => {
    const isExcluded = createExcluder([...DEFAULT_EXCLUDES, "private/**"]);
    for (const p of [".env", ".env.local", "config/.env.production", "certs/server.pem", "node_modules/x/index.js",
        "packages/a/node_modules/b.js", "dist/app.js", "secrets/db.json", "target/debug/app", "private/notes.md"]) {
        assert.ok(isExcluded(p), p);
    }
    for (const p of ["src/app.ts", "README.md", "src/environment.ts", "envoy.yaml"]) {
        assert.ok(!isExcluded(p), p);
    }
});

test("line diff reports only the changed lines", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "C", "d", "e", "f", "g", "h"].join("\n");
    const d = lineDiff(before, after);
    assert.equal(d.linesAdded, 2);
    assert.equal(d.linesRemoved, 1);
    assert.equal(d.startLine, 3);
    assert.match(d.hunk, /^-c$/m);
    assert.match(d.hunk, /^\+C$/m);
    assert.match(d.hunk, /^\+h$/m);
    assert.equal(lineDiff("same", "same"), null);
});

test("line diff caps huge changes", () => {
    const before = "";
    const after = Array.from({ length: 500 }, (_, i) => "line " + i).join("\n");
    const d = lineDiff(before, after, { maxLines: 80 });
    assert.equal(d.truncated, true);
    assert.ok(d.hunk.split("\n").length <= 81);
});

test("agent edit line counts", () => {
    assert.deepEqual(countLineChanges("a\nb", "a\nb\nc"), { linesAdded: 1, linesRemoved: 0 });
    assert.deepEqual(countLineChanges("", "x"), { linesAdded: 1, linesRemoved: 0 });
});

test("aggregator: one summary per burst, saves don't duplicate, undo cancels", () => {
    const agg = new EditAggregator({ quietMs: 1000, maxMs: 10000 });
    agg.track("f", "one\n");

    agg.change("f", { now: 0 });
    agg.change("f", { now: 200 });
    assert.deepEqual(agg.due(500), []);
    assert.deepEqual(agg.due(1300), ["f"]);

    const s = agg.flush("f", "one\ntwo\n", { reason: "save" });
    assert.equal(s.linesAdded, 1);
    assert.equal(s.changeCount, 2);
    assert.match(s.diff, /\+two/);

    // Saving again with no edits produces nothing.
    assert.equal(agg.flush("f", "one\ntwo\n", { reason: "save" }), null);

    // Typed then undone: no net change, no event.
    agg.change("f", { now: 2000 });
    agg.change("f", { now: 2100, undoRedo: true });
    assert.equal(agg.flush("f", "one\ntwo\n", { reason: "save" }), null);
});

test("aggregator: continuous editing is flushed after maxMs", () => {
    const agg = new EditAggregator({ quietMs: 1000, maxMs: 5000 });
    agg.track("f", "");
    for (let t = 0; t <= 6000; t += 500) agg.change("f", { now: t });
    assert.deepEqual(agg.due(6000), ["f"]);
});

test("terminal output: tests and error lines", () => {
    assert.deepEqual(parseTests("ℹ tests 5\nℹ pass 4\nℹ fail 1\n"), { passed: 4, failed: 1 });
    assert.deepEqual(parseTests("Tests:       2 failed, 10 passed, 12 total"), { passed: 10, failed: 2 });
    assert.deepEqual(parseTests("test result: FAILED. 3 passed; 1 failed; 0 ignored"), { passed: 3, failed: 1 });
    assert.deepEqual(parseTests("==== 7 passed in 0.12s ===="), { passed: 7, failed: 0 });
    assert.equal(parseTests("hello world"), null);

    const lines = errorLines("\u001b[31mError: Cannot find module 'x'\u001b[0m\nok\nTypeError: a is undefined");
    assert.equal(lines.length, 2);
    assert.equal(stripAnsi("\u001b[32mgreen\u001b[0m"), "green");
});

test("project resolution prefers the git root inside the workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    const repo = path.join(tmp, "employee-management");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const file = path.join(repo, "src", "AddEmployee.tsx");
    fs.writeFileSync(file, "x");

    const p = resolveProject(file, [repo]);
    assert.equal(p.name, "employee-management");
    assert.equal(p.relativePath, "src/AddEmployee.tsx");
    assert.match(p.root, /employee-management$/);
    assert.ok(!p.root.includes("\\"));

    const noGit = path.join(tmp, "scratch");
    fs.mkdirSync(noGit);
    assert.equal(resolveProject(path.join(noGit, "a.js"), [noGit]).name, "scratch");
    fs.rmSync(tmp, { recursive: true, force: true });
});
