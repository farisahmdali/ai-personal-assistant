// Turns one work session's raw events into a compact evidence package for the
// AI: what changed in which files (manual vs AI-assisted), commands and their
// results, tests, git, agent conversation, app/idle time and browser research.
// Every item gets an id (E1, E2, …) so the AI's claims can cite evidence.

const MAX_ITEM_TEXT = 400;
const MAX_FILE_DIFF = 1500;
const MAX_TOTAL_DIFF = 8000;
const AI_EDIT_WINDOW_MS = 5000;
const TEST_COMMAND = /\b(test|tests|jest|vitest|mocha|pytest|cargo test|go test|npm t\b|phpunit|rspec|dotnet test|gradle test|mvn test)\b/i;

function clipText(value, max) {
    const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function ms(ts) {
    return new Date(ts).getTime();
}

function localTime(ts, timeZone, withDate) {
    const s = new Date(ts).toLocaleString("sv-SE", { timeZone, hour12: false });
    return withDate ? s.slice(0, 16) : s.slice(11, 16);
}

function sameFile(a, b) {
    if (!a || !b) return false;
    const x = String(a).replace(/\\/g, "/").toLowerCase();
    const y = String(b).replace(/\\/g, "/").toLowerCase();
    return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
}

function appTime(context, startMs, endMs) {
    const minutes = {};
    let switches = 0;
    let idleSeconds = 0;
    let previousCategory = null;

    const focus = (context || []).filter(e => e.type === "window_focus").sort((a, b) => ms(a.ts) - ms(b.ts));
    focus.forEach((e, i) => {
        const from = Math.max(ms(e.ts), startMs);
        const next = focus[i + 1] ? ms(focus[i + 1].ts) : endMs;
        const to = Math.min(next, endMs, ms(e.ts) + 15 * 60000);
        const category = (e.data && e.data.category) || "other";
        if (to > from) minutes[category] = (minutes[category] || 0) + (to - from) / 60000;
        if (previousCategory && previousCategory !== category) switches++;
        previousCategory = category;
    });

    for (const e of context || []) {
        if (e.type === "idle_end" && e.data && e.data.idleSeconds) idleSeconds += e.data.idleSeconds;
    }

    const rounded = {};
    for (const [k, v] of Object.entries(minutes)) rounded[k] = Math.round(v);
    return { minutesByCategory: rounded, contextSwitches: switches, idleMinutes: Math.round(idleSeconds / 60) };
}

function isPassing(cmd) {
    if (cmd.tests) return cmd.tests.failed === 0 && cmd.tests.passed > 0;
    return cmd.exitCode === 0 && TEST_COMMAND.test(cmd.command || "");
}

function isFailingTest(cmd) {
    if (cmd.tests) return cmd.tests.failed > 0;
    return typeof cmd.exitCode === "number" && cmd.exitCode !== 0 && TEST_COMMAND.test(cmd.command || "");
}

// row: claimed session from "Claim Sessions"; options: { sendDiffs, timezone }
function buildEvidence(row, options) {
    const timeZone = options.timezone || "UTC";
    const events = [...(row.events || [])].sort((a, b) => ms(a.ts) - ms(b.ts));
    const startMs = ms(row.started_at);
    const endMs = ms(row.last_event_at);
    const items = [];
    const add = (kind, text, detail) => {
        const item = { id: "E" + (items.length + 1), kind, text: clipText(text, MAX_ITEM_TEXT) };
        if (detail) item.detail = detail;
        items.push(item);
        return item;
    };

    // ---- files -----------------------------------------------------------
    const agentEdits = events.filter(e => e.type === "agent_file_edit");
    const files = new Map();
    const fileEntry = (file, language) => {
        if (!files.has(file)) {
            files.set(file, { file, language: language || null, manual: { bursts: 0, added: 0, removed: 0 }, ai: { edits: 0, added: 0, removed: 0 }, diffs: [] });
        }
        const f = files.get(file);
        if (language && !f.language) f.language = language;
        return f;
    };

    for (const e of events) {
        const d = e.data || {};
        if (e.type === "edit_summary" && d.file) {
            const f = fileEntry(d.file, d.language);
            const from = ms(d.firstChangeAt || e.ts) - AI_EDIT_WINDOW_MS;
            const to = ms(d.lastChangeAt || e.ts) + AI_EDIT_WINDOW_MS;
            const byAgent = agentEdits.some(a => sameFile(a.data && a.data.file, d.file) && ms(a.ts) >= from && ms(a.ts) <= to);
            if (!byAgent) {
                f.manual.bursts++;
                f.manual.added += d.linesAdded || 0;
                f.manual.removed += d.linesRemoved || 0;
            }
            if (d.diff) f.diffs.push((byAgent ? "[AI-assisted]\n" : "") + d.diff);
        } else if (e.type === "agent_file_edit" && d.file) {
            const f = fileEntry(d.file);
            f.ai.edits++;
            f.ai.added += d.linesAdded || 0;
            f.ai.removed += d.linesRemoved || 0;
            if (d.excerpt && !f.diffs.length) f.diffs.push("[AI edit excerpt]\n" + d.excerpt);
        }
    }

    let diffBudget = options.sendDiffs ? MAX_TOTAL_DIFF : 0;
    for (const f of files.values()) {
        const parts = [];
        if (f.manual.bursts) parts.push(`manual +${f.manual.added} −${f.manual.removed} in ${f.manual.bursts} edit burst(s)`);
        if (f.ai.edits) parts.push(`AI agent +${f.ai.added} −${f.ai.removed} in ${f.ai.edits} edit(s)`);
        if (!parts.length) parts.push("AI-assisted edits");

        let detail;
        if (diffBudget > 0 && f.diffs.length) {
            const diff = f.diffs.join("\n…\n");
            detail = diff.slice(0, Math.min(MAX_FILE_DIFF, diffBudget));
            diffBudget -= detail.length;
        }
        add("file_change", `${f.file}${f.language ? " (" + f.language + ")" : ""}: ${parts.join("; ")}`, detail);
    }

    // ---- file operations --------------------------------------------------
    const created = new Set();
    const deleted = new Set();
    for (const e of events) {
        const d = e.data || {};
        if (e.type === "file_changes") {
            (d.created || []).forEach(f => created.add(f));
            (d.deleted || []).forEach(f => deleted.add(f));
        } else if (e.type === "file_renamed") {
            add("file_op", `Renamed ${d.from} → ${d.to}`);
        }
    }
    if (created.size) add("file_op", `Created: ${[...created].slice(0, 15).join(", ")}${created.size > 15 ? ` (+${created.size - 15} more)` : ""}`);
    if (deleted.size) add("file_op", `Deleted: ${[...deleted].slice(0, 15).join(", ")}${deleted.size > 15 ? ` (+${deleted.size - 15} more)` : ""}`);

    // ---- files looked at but not changed ----------------------------------
    const viewed = [...new Set(events.filter(e => e.type === "editor_focus").map(e => e.data && e.data.file).filter(Boolean))]
        .filter(f => !files.has(f));
    if (viewed.length) add("viewed", `Opened without changing: ${viewed.slice(0, 15).join(", ")}`);

    // ---- commands and tests -----------------------------------------------
    const commands = events
        .filter(e => e.type === "terminal_command" || e.type === "agent_shell")
        .map(e => ({ ...(e.data || {}), by: e.type === "agent_shell" ? "AI agent" : "user", ts: e.ts }));

    for (const c of commands.slice(-30)) {
        const result = [];
        if (typeof c.exitCode === "number") result.push(`exit ${c.exitCode}`);
        if (c.tests) result.push(`tests ${c.tests.passed} passed / ${c.tests.failed} failed`);
        const errors = (c.errorLines || []).slice(0, 4);
        add(
            c.tests || TEST_COMMAND.test(c.command || "") ? "test_run" : "command",
            `[${c.by}, ${localTime(c.ts, timeZone)}] ${c.command}${result.length ? " → " + result.join(", ") : ""}${errors.length ? " | errors: " + errors.join(" / ") : ""}`
        );
    }

    // ---- git --------------------------------------------------------------
    const branches = events.filter(e => e.type === "git_state" && e.data && e.data.branch);
    if (branches.length) add("git", `Branch: ${branches[branches.length - 1].data.branch}`);
    const commits = events.filter(e => e.type === "git_commit");
    for (const c of commits) add("commit", `Commit ${c.data.hash} on ${c.data.branch || "?"}: "${c.data.message || ""}"`);

    // ---- AI agent conversation --------------------------------------------
    for (const e of events.filter(e => e.type === "agent_prompt").slice(-10)) {
        add("agent_prompt", `User asked the AI agent: "${clipText(e.data.prompt, 350)}"`);
    }
    for (const e of events.filter(e => e.type === "agent_response").slice(-5)) {
        add("agent_response", `AI agent replied: "${clipText(e.data.text, 300)}"`);
    }
    for (const e of events.filter(e => e.type === "agent_tool_failure").slice(-5)) {
        add("agent_error", `AI agent tool ${e.data.tool || ""} failed: ${e.data.error || ""}`);
    }
    const stops = events.filter(e => e.type === "agent_stop");
    if (stops.length) add("agent_stop", `AI agent run finished (${stops[stops.length - 1].data.status || "unknown status"})`);

    // ---- browser research during the session ------------------------------
    for (const r of (row.research || []).slice(-8)) {
        add("research", `Browser ${r.website || ""} at ${localTime(r.start, timeZone)}: ${r.summary}`);
    }

    // ---- facts used to check the AI's claims ------------------------------
    const lastAgentEdit = agentEdits.length ? ms(agentEdits[agentEdits.length - 1].ts) : null;
    const facts = {
        filesChanged: [...files.keys()],
        hasPassingTest: commands.some(isPassing),
        hasFailingTest: commands.some(isFailingTest),
        lastTestPassed: (() => {
            const tests = commands.filter(c => c.tests || TEST_COMMAND.test(c.command || ""));
            return tests.length ? isPassing(tests[tests.length - 1]) : null;
        })(),
        hasCommit: commits.length > 0,
        hasAgentStopAfterEdits: lastAgentEdit !== null && stops.some(s => ms(s.ts) > lastAgentEdit && /complete/i.test(s.data.status || "")),
        eventCount: events.length
    };

    const context = appTime(row.context, startMs, endMs);

    const payload = {
        project: { name: row.project_name, root: row.project_root },
        session: {
            kind: row.final ? "ended (user inactive)" : "still in progress (interim update)",
            start: localTime(row.started_at, timeZone, true),
            end: localTime(row.last_event_at, timeZone, true),
            minutes: Math.round((endMs - startMs) / 60000)
        },
        appTime: context,
        previousSummaryOfThisTask: row.current_memory || null,
        otherOpenTasksInThisProject: (row.open_tasks || []).map(t => ({ id: t.id, title: t.title, summary: t.summary, status: t.status })),
        evidence: items
    };

    return {
        items,
        facts,
        appTime: context,
        payload,
        processedUntil: events.length ? new Date(ms(events[events.length - 1].ts)).toISOString() : row.last_event_at
    };
}
