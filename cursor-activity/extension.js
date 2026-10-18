// Cursor / VS Code extension that records coding activity for the personal
// assistant: which project and file you work in, what changed (manual and AI
// edits alike, as redacted diffs), file operations, terminal commands with exit
// codes and test results, and git branch/commits.
//
// Events are written to the local spool; the Rust personal-monitor forwards
// them to n8n. Nothing here reads files from disk or records keystrokes.

const vscode = require("vscode");
const path = require("node:path");
const { loadConfig, isPaused, setPaused, logError, spoolDir } = require("./lib/config");
const { createExcluder } = require("./lib/exclude");
const { EditAggregator } = require("./lib/aggregate");
const { resolveProject } = require("./lib/project");
const { summarizeOutput } = require("./lib/terminal");
const { redact } = require("./lib/redact");
const { makeEvent, writeSpool } = require("./lib/events");

const SOURCE = "cursor-ext";
const SPOOL_INTERVAL_MS = 3000;
const TICK_MS = 5000;
const MAX_OUTPUT_CHARS = 64000;

let output;
let config;
let isExcluded;
let queue = [];
let pausedCache = { value: false, at: 0 };
const aggregator = new EditAggregator({ quietMs: 30000, maxMs: 300000 });
const lastFocus = { file: null, at: 0 };
const pendingFileOps = new Map(); // project root -> { project, created:Set, deleted:Set }
const gitState = new Map();       // repo root -> { branch, commit }


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(message) {
    output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function paused() {
    const now = Date.now();
    if (now - pausedCache.at > 5000) pausedCache = { value: isPaused(), at: now };
    return pausedCache.value;
}

function workspaceFolderPaths() {
    return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

function projectFor(fsPath) {
    return resolveProject(fsPath, workspaceFolderPaths());
}

function envelopeProject(project) {
    return project ? { root: project.root, name: project.name } : null;
}

function emit(type, project, data) {
    if (paused()) return;
    queue.push(makeEvent(SOURCE, type, envelopeProject(project), data));
}

function flushQueue() {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    try {
        writeSpool(events, SOURCE);
    } catch (err) {
        queue = events.concat(queue); // try again next interval
        logError("cursor-extension.log", err);
        log("spool write failed: " + err.message);
    }
}

function trackable(doc) {
    if (!doc || doc.uri.scheme !== "file") return null;
    const project = projectFor(doc.uri.fsPath);
    if (!project) return null;
    if (isExcluded(project.relativePath)) return null;
    return project;
}


// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------

function trackDocument(doc) {
    if (trackable(doc)) aggregator.track(doc.uri.toString(), doc.getText());
}

function flushDocument(doc, reason) {
    const key = doc.uri.toString();
    if (!aggregator.isDirty(key)) return;

    const project = trackable(doc);
    if (!project) {
        aggregator.untrack(key);
        return;
    }

    const summary = aggregator.flush(key, doc.getText(), { reason });
    if (summary) {
        emit("edit_summary", project, {
            file: project.relativePath,
            language: doc.languageId,
            ...summary
        });
    }
}

function onDidChangeTextDocument(event) {
    const doc = event.document;
    if (!event.contentChanges.length || !trackable(doc)) return;

    const key = doc.uri.toString();
    if (!aggregator.isTracked(key)) {
        // Opened before we could take a baseline: start from now.
        aggregator.track(key, doc.getText());
        return;
    }

    const undoRedo = event.reason === vscode.TextDocumentChangeReason?.Undo ||
        event.reason === vscode.TextDocumentChangeReason?.Redo;
    aggregator.change(key, { undoRedo, count: event.contentChanges.length });
}

function findDocument(key) {
    return vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
}

function tick() {
    for (const key of aggregator.due()) {
        const doc = findDocument(key);
        if (doc) flushDocument(doc, "quiet");
        else aggregator.untrack(key);
    }
    flushFileOps();
}


// ---------------------------------------------------------------------------
// focus, workspace, files
// ---------------------------------------------------------------------------

function onDidChangeActiveTextEditor(editor) {
    // Leaving a file ends its burst of edits.
    for (const key of aggregator.dirtyKeys()) {
        if (!editor || editor.document.uri.toString() !== key) {
            const doc = findDocument(key);
            if (doc) flushDocument(doc, "switch");
        }
    }

    if (!editor) return;
    const doc = editor.document;
    const project = trackable(doc);
    if (!project) return;

    trackDocument(doc);
    const now = Date.now();
    if (lastFocus.file === doc.uri.fsPath && now - lastFocus.at < 60000) return;
    lastFocus.file = doc.uri.fsPath;
    lastFocus.at = now;
    emit("editor_focus", project, { file: project.relativePath, language: doc.languageId });
}

function emitWorkspaceOpened(folders) {
    for (const folder of folders) {
        const project = projectFor(folder.uri.fsPath);
        if (project) emit("workspace_opened", project, { folder: folder.uri.fsPath.replace(/\\/g, "/") });
    }
}

function noteFileOp(uri, kind) {
    if (uri.scheme !== "file") return;
    const project = projectFor(uri.fsPath);
    if (!project || isExcluded(project.relativePath)) return;

    let pending = pendingFileOps.get(project.root);
    if (!pending) {
        pending = { project, created: new Set(), deleted: new Set() };
        pendingFileOps.set(project.root, pending);
    }
    pending[kind].add(project.relativePath);
}

function flushFileOps() {
    for (const { project, created, deleted } of pendingFileOps.values()) {
        // A file created and deleted in the same window (temp files) is noise.
        const both = [...created].filter(f => deleted.has(f));
        both.forEach(f => { created.delete(f); deleted.delete(f); });
        if (created.size || deleted.size) {
            emit("file_changes", project, {
                created: [...created].slice(0, 50),
                deleted: [...deleted].slice(0, 50),
                createdCount: created.size,
                deletedCount: deleted.size
            });
        }
    }
    pendingFileOps.clear();
}

function onDidRenameFiles(event) {
    for (const { oldUri, newUri } of event.files) {
        const project = projectFor(newUri.fsPath);
        if (!project || isExcluded(project.relativePath)) continue;
        const oldRel = projectFor(oldUri.fsPath)?.relativePath || path.basename(oldUri.fsPath);
        emit("file_renamed", project, { from: oldRel, to: project.relativePath });
    }
}


// ---------------------------------------------------------------------------
// terminal (shell integration)
// ---------------------------------------------------------------------------

const executions = new WeakMap(); // execution -> { startedAt, output }

function onDidStartTerminalShellExecution(event) {
    const state = { startedAt: Date.now(), output: "" };
    executions.set(event.execution, state);

    (async () => {
        try {
            for await (const chunk of event.execution.read()) {
                state.output += chunk;
                if (state.output.length > MAX_OUTPUT_CHARS) {
                    state.output = state.output.slice(-MAX_OUTPUT_CHARS);
                }
            }
        } catch {}
    })();
}

function onDidEndTerminalShellExecution(event) {
    const execution = event.execution;
    const state = executions.get(execution) || { startedAt: Date.now(), output: "" };
    executions.delete(execution);

    const commandLine = execution.commandLine?.value || "";
    if (!commandLine.trim()) return;

    const cwd = execution.cwd?.fsPath || workspaceFolderPaths()[0];
    const project = cwd ? projectFor(cwd) : null;

    // Give the output stream a moment to drain before summarising.
    setTimeout(() => {
        emit("terminal_command", project, {
            command: redact(commandLine.slice(0, 1000)),
            cwd: project ? project.relativePath : null,
            exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
            durationMs: Date.now() - state.startedAt,
            ...summarizeOutput(state.output, config.outputTailLines)
        });
    }, 300);
}


// ---------------------------------------------------------------------------
// git (built-in git extension API)
// ---------------------------------------------------------------------------

function watchRepository(repo, disposables) {
    const root = repo.rootUri.fsPath;
    const project = projectFor(root);
    if (!project) return;

    const snapshot = () => ({
        branch: repo.state.HEAD?.name || null,
        commit: repo.state.HEAD?.commit || null,
        changes: repo.state.workingTreeChanges.length + repo.state.indexChanges.length
    });

    const initial = snapshot();
    gitState.set(root, initial);
    emit("git_state", project, { branch: initial.branch, changedFiles: initial.changes });

    disposables.push(repo.state.onDidChange(async () => {
        const prev = gitState.get(root) || {};
        const now = snapshot();
        gitState.set(root, now);

        if (now.branch !== prev.branch) {
            emit("git_state", project, { branch: now.branch, previousBranch: prev.branch || null, changedFiles: now.changes });
        } else if (now.commit && prev.commit && now.commit !== prev.commit) {
            let message = null;
            try {
                const [entry] = await repo.log({ maxEntries: 1 });
                if (entry && entry.hash === now.commit) message = entry.message;
            } catch {}
            emit("git_commit", project, {
                branch: now.branch,
                hash: now.commit.slice(0, 10),
                message: message ? redact(message.slice(0, 500)) : null,
                changedFilesAfter: now.changes
            });
        }
    }));
}

async function setupGit(context) {
    try {
        const ext = vscode.extensions.getExtension("vscode.git");
        if (!ext) return;
        const git = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
        git.repositories.forEach(r => watchRepository(r, context.subscriptions));
        context.subscriptions.push(git.onDidOpenRepository(r => watchRepository(r, context.subscriptions)));
    } catch (err) {
        log("git integration unavailable: " + err.message);
    }
}


// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

function reloadConfig() {
    config = loadConfig();
    isExcluded = createExcluder(config.excludeGlobs);
}

function activate(context) {
    output = vscode.window.createOutputChannel("AI Assistant Activity");
    reloadConfig();
    log(`activated; spool: ${spoolDir()}${paused() ? " (paused)" : ""}`);

    vscode.workspace.textDocuments.forEach(trackDocument);
    emitWorkspaceOpened(vscode.workspace.workspaceFolders || []);
    if (vscode.window.activeTextEditor) onDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);

    context.subscriptions.push(
        output,
        watcher,
        vscode.workspace.onDidOpenTextDocument(trackDocument),
        vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
        vscode.workspace.onDidSaveTextDocument(doc => flushDocument(doc, "save")),
        vscode.workspace.onDidCloseTextDocument(doc => {
            flushDocument(doc, "close");
            aggregator.untrack(doc.uri.toString());
        }),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        vscode.workspace.onDidChangeWorkspaceFolders(e => emitWorkspaceOpened(e.added)),
        vscode.workspace.onDidRenameFiles(onDidRenameFiles),
        watcher.onDidCreate(uri => noteFileOp(uri, "created")),
        watcher.onDidDelete(uri => noteFileOp(uri, "deleted")),
        vscode.commands.registerCommand("aiAssistantActivity.pause", () => {
            setPaused(true);
            pausedCache.at = 0;
            vscode.window.showInformationMessage("Activity capture paused.");
        }),
        vscode.commands.registerCommand("aiAssistantActivity.resume", () => {
            setPaused(false);
            pausedCache.at = 0;
            vscode.window.showInformationMessage("Activity capture resumed.");
        }),
        vscode.commands.registerCommand("aiAssistantActivity.showLog", () => output.show())
    );

    if (vscode.window.onDidEndTerminalShellExecution) {
        context.subscriptions.push(
            vscode.window.onDidStartTerminalShellExecution(onDidStartTerminalShellExecution),
            vscode.window.onDidEndTerminalShellExecution(onDidEndTerminalShellExecution)
        );
    } else {
        log("terminal shell integration API not available; terminal commands are not captured");
    }

    setupGit(context);

    const spoolTimer = setInterval(flushQueue, SPOOL_INTERVAL_MS);
    const tickTimer = setInterval(tick, TICK_MS);
    const configTimer = setInterval(reloadConfig, 60000);
    context.subscriptions.push({ dispose: () => { clearInterval(spoolTimer); clearInterval(tickTimer); clearInterval(configTimer); } });
}

function deactivate() {
    for (const key of aggregator.dirtyKeys()) {
        const doc = findDocument(key);
        if (doc) flushDocument(doc, "shutdown");
    }
    flushFileOps();
    flushQueue();
}

module.exports = { activate, deactivate };
