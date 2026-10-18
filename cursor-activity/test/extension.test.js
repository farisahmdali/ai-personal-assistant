// Runs extension.js against a fake `vscode` module: typing, saving, switching
// files and projects, terminal commands.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// fake vscode
// ---------------------------------------------------------------------------

function emitter() {
    const listeners = [];
    const event = fn => {
        listeners.push(fn);
        return { dispose() {} };
    };
    event.fire = arg => listeners.forEach(fn => fn(arg));
    return event;
}

function createFakeVscode(folders) {
    const ev = {
        open: emitter(), change: emitter(), save: emitter(), close: emitter(), active: emitter(),
        folders: emitter(), rename: emitter(), create: emitter(), del: emitter(),
        termStart: emitter(), termEnd: emitter()
    };

    const vscode = {
        _ev: ev,
        TextDocumentChangeReason: { Undo: 1, Redo: 2 },
        workspace: {
            workspaceFolders: folders.map(f => ({ uri: { fsPath: f, scheme: "file" } })),
            textDocuments: [],
            onDidOpenTextDocument: ev.open,
            onDidChangeTextDocument: ev.change,
            onDidSaveTextDocument: ev.save,
            onDidCloseTextDocument: ev.close,
            onDidChangeWorkspaceFolders: ev.folders,
            onDidRenameFiles: ev.rename,
            createFileSystemWatcher: () => ({ onDidCreate: ev.create, onDidDelete: ev.del, dispose() {} })
        },
        window: {
            activeTextEditor: undefined,
            createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
            showInformationMessage() {},
            onDidChangeActiveTextEditor: ev.active,
            onDidStartTerminalShellExecution: ev.termStart,
            onDidEndTerminalShellExecution: ev.termEnd
        },
        commands: { registerCommand: () => ({ dispose() {} }) },
        extensions: { getExtension: () => undefined }
    };
    return vscode;
}

function fakeDocument(fsPath, text, languageId = "typescript") {
    const doc = {
        uri: { fsPath, scheme: "file", toString: () => "file:///" + fsPath.replace(/\\/g, "/") },
        languageId,
        text,
        getText: () => doc.text
    };
    return doc;
}

// ---------------------------------------------------------------------------

function loadExtension(vscode) {
    const original = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "vscode") return vscode;
        return original.call(this, request, ...rest);
    };
    try {
        const file = require.resolve("../extension.js");
        delete require.cache[file];
        return require(file);
    } finally {
        Module._load = original;
    }
}

function readSpool(home) {
    const dir = path.join(home, "spool");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort()
        .flatMap(f => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse));
}

function makeRepo(home, name) {
    const repo = path.join(home, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    return repo;
}

test("manual typing, saves, focus and two projects", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ext-"));
    process.env.AI_ASSISTANT_HOME = home;

    const repoA = makeRepo(home, "employee-management");
    const repoB = makeRepo(home, "billing-api");
    const vscode = createFakeVscode([repoA, repoB]);
    const ext = loadExtension(vscode);

    const form = fakeDocument(path.join(repoA, "src", "AddEmployee.tsx"), "export function AddEmployee() {\n  return null;\n}\n", "typescriptreact");
    const service = fakeDocument(path.join(repoA, "src", "employee.service.ts"), "export const create = () => {};\n");
    const invoice = fakeDocument(path.join(repoB, "src", "invoice.ts"), "export const total = 0;\n");
    const secrets = fakeDocument(path.join(repoA, ".env"), "API_KEY=1\n", "dotenv");
    vscode.workspace.textDocuments.push(form, service, invoice, secrets);

    const context = { subscriptions: [] };
    ext.activate(context);

    // Focus and type in the form: three keystrokes = three change events.
    vscode._ev.active.fire({ document: form });
    for (const next of [
        "export function AddEmployee() {\n  const [name, setName] = useState('');\n  return null;\n}\n",
        "export function AddEmployee() {\n  const [name, setName] = useState('');\n  if (!name) return null;\n  return null;\n}\n"
    ]) {
        form.text = next;
        vscode._ev.change.fire({ document: form, contentChanges: [{}], reason: undefined });
    }

    // Save three times: only one edit_summary.
    vscode._ev.save.fire(form);
    vscode._ev.save.fire(form);
    vscode._ev.save.fire(form);

    // Edit the service, then switch to the other project: switching flushes.
    vscode._ev.active.fire({ document: service });
    service.text = "export const create = (e) => { validate(e); };\n";
    vscode._ev.change.fire({ document: service, contentChanges: [{}] });
    vscode._ev.active.fire({ document: invoice });
    invoice.text = "export const total = (items) => items.reduce((a, b) => a + b, 0);\n";
    vscode._ev.change.fire({ document: invoice, contentChanges: [{}] });
    vscode._ev.save.fire(invoice);

    // Excluded file edits are ignored.
    secrets.text = "API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz\n";
    vscode._ev.change.fire({ document: secrets, contentChanges: [{}] });
    vscode._ev.save.fire(secrets);

    // A failing test run in project A.
    const execution = {
        commandLine: { value: "npm test" },
        cwd: { fsPath: repoA },
        read: async function* () { yield "ℹ pass 3\nℹ fail 1\nAssertionError: expected 400, received 200\n"; }
    };
    vscode._ev.termStart.fire({ execution });
    await new Promise(r => setTimeout(r, 20));
    vscode._ev.termEnd.fire({ execution, exitCode: 1 });
    await new Promise(r => setTimeout(r, 400));

    ext.deactivate();
    context.subscriptions.forEach(d => d.dispose());

    const events = readSpool(home);
    const byType = t => events.filter(e => e.type === t);

    assert.deepEqual(byType("workspace_opened").map(e => e.project.name).sort(), ["billing-api", "employee-management"]);

    const edits = byType("edit_summary");
    assert.deepEqual(edits.map(e => [e.project.name, e.data.file, e.data.reason]), [
        ["employee-management", "src/AddEmployee.tsx", "save"],
        ["employee-management", "src/employee.service.ts", "switch"],
        ["billing-api", "src/invoice.ts", "save"]
    ]);
    assert.equal(edits[0].data.changeCount, 2);
    assert.equal(edits[0].data.linesAdded, 2);
    assert.match(edits[0].data.diff, /\+  const \[name, setName\]/);
    assert.ok(!events.some(e => JSON.stringify(e).includes(".env")));
    assert.ok(!events.some(e => JSON.stringify(e).includes("sk-live")));

    const [cmd] = byType("terminal_command");
    assert.equal(cmd.project.name, "employee-management");
    assert.equal(cmd.data.exitCode, 1);
    assert.deepEqual(cmd.data.tests, { passed: 3, failed: 1 });
    assert.ok(cmd.data.errorLines.some(l => l.includes("expected 400")));

    assert.deepEqual(byType("editor_focus").map(e => e.data.file), ["src/AddEmployee.tsx", "src/employee.service.ts", "src/invoice.ts"]);
    assert.ok(events.every(e => e.source === "cursor-ext" && e.id));

    delete process.env.AI_ASSISTANT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
});

test("paused: nothing is captured", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ext-"));
    process.env.AI_ASSISTANT_HOME = home;
    fs.writeFileSync(path.join(home, "paused"), "");

    const repo = makeRepo(home, "app");
    const vscode = createFakeVscode([repo]);
    const ext = loadExtension(vscode);
    const doc = fakeDocument(path.join(repo, "src", "a.ts"), "a\n");
    vscode.workspace.textDocuments.push(doc);

    const context = { subscriptions: [] };
    ext.activate(context);
    doc.text = "a\nb\n";
    vscode._ev.change.fire({ document: doc, contentChanges: [{}] });
    vscode._ev.save.fire(doc);
    ext.deactivate();
    context.subscriptions.forEach(d => d.dispose());

    assert.equal(readSpool(home).length, 0);
    delete process.env.AI_ASSISTANT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
});
