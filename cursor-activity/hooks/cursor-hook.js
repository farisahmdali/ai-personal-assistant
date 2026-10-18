#!/usr/bin/env node
// Cursor agent hook: turns Cursor hook payloads into activity events in the
// local spool. Registered in ~/.cursor/hooks.json by scripts/install-hooks.mjs
// as:  node ".../cursor-hook.js" <hookEventName>
//
// Must never block or break Cursor: always replies quickly and exits 0.

const path = require("node:path");
const { redact } = require("../lib/redact");
const { loadConfig, isPaused, logError } = require("../lib/config");
const { createExcluder } = require("../lib/exclude");
const { countLineChanges } = require("../lib/diff");
const { resolveProject } = require("../lib/project");
const { summarizeOutput } = require("../lib/terminal");
const { makeEvent, writeSpool } = require("../lib/events");

const SOURCE = "cursor-hook";

function clip(text, max) {
    const s = String(text == null ? "" : text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Cursor sends workspace_roots as URI paths ("/c:/Users/me/app"); turn them
// (and any other path) into normal file system paths.
function toFsPath(p) {
    if (typeof p !== "string" || !p) return null;
    let out = p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p;
    if (/^\/[A-Za-z]:/.test(out)) out = out.slice(1);
    return out;
}

function workspaceRoots(payload) {
    const roots = payload.workspace_roots || payload.workspaceRoots || [];
    return Array.isArray(roots) ? roots.map(toFsPath).filter(Boolean) : [];
}

function projectOf(payload, filePath) {
    const roots = workspaceRoots(payload);
    const target = toFsPath(filePath) || roots[0] || toFsPath(payload.cwd) || process.cwd();
    return resolveProject(target, roots);
}

function common(payload) {
    return {
        conversationId: payload.conversation_id || null,
        generationId: payload.generation_id || null,
        model: payload.model || null
    };
}

// Returns the events for one hook invocation.
function mapHook(hook, payload, config) {
    const isExcluded = createExcluder(config.excludeGlobs);
    const base = common(payload);

    switch (hook) {
        case "beforeSubmitPrompt": {
            const project = projectOf(payload);
            const attachments = (payload.attachments || [])
                .map(a => a && toFsPath(a.file_path))
                .filter(Boolean)
                .map(f => resolveProject(f, workspaceRoots(payload))?.relativePath || path.basename(f));
            return [makeEvent(SOURCE, "agent_prompt", project && { root: project.root, name: project.name }, {
                ...base,
                prompt: redact(clip(payload.prompt, 2000)),
                attachments,
                mode: payload.composer_mode || null
            })];
        }

        case "afterAgentResponse": {
            const project = projectOf(payload);
            return [makeEvent(SOURCE, "agent_response", project && { root: project.root, name: project.name }, {
                ...base,
                text: redact(clip(payload.text, 1500)),
                outputTokens: payload.output_tokens ?? null
            })];
        }

        case "afterFileEdit":
        case "afterTabFileEdit": {
            const filePath = toFsPath(payload.file_path);
            const project = projectOf(payload, filePath);
            if (!filePath || (project && isExcluded(project.relativePath))) return [];

            let linesAdded = 0;
            let linesRemoved = 0;
            const excerpts = [];
            for (const edit of payload.edits || []) {
                const c = countLineChanges(edit.old_string, edit.new_string);
                linesAdded += c.linesAdded;
                linesRemoved += c.linesRemoved;
                if (excerpts.join("\n").length < 1500 && edit.new_string) {
                    excerpts.push(clip(edit.new_string, 600));
                }
            }

            return [makeEvent(SOURCE, "agent_file_edit", project && { root: project.root, name: project.name }, {
                ...base,
                file: project ? project.relativePath : filePath,
                absolutePath: filePath,
                tab: hook === "afterTabFileEdit",
                editCount: (payload.edits || []).length,
                linesAdded,
                linesRemoved,
                excerpt: redact(excerpts.join("\n…\n"))
            })];
        }

        case "afterShellExecution": {
            const project = projectOf(payload, payload.cwd);
            const output = summarizeOutput(payload.output, config.outputTailLines);
            return [makeEvent(SOURCE, "agent_shell", project && { root: project.root, name: project.name }, {
                ...base,
                command: redact(clip(payload.command, 1000)),
                durationMs: typeof payload.duration === "number" ? payload.duration : null,
                exitCode: typeof payload.exit_code === "number" ? payload.exit_code : null,
                ...output
            })];
        }

        case "postToolUseFailure": {
            const project = projectOf(payload);
            return [makeEvent(SOURCE, "agent_tool_failure", project && { root: project.root, name: project.name }, {
                ...base,
                tool: payload.tool_name || (payload.tool && payload.tool.name) || null,
                error: redact(clip(payload.error || payload.error_message || payload.message, 600))
            })];
        }

        case "sessionStart":
        case "sessionEnd":
        case "stop": {
            const project = projectOf(payload);
            const type = hook === "stop" ? "agent_stop" : hook === "sessionStart" ? "agent_session_start" : "agent_session_end";
            return [makeEvent(SOURCE, type, project && { root: project.root, name: project.name }, {
                ...base,
                status: payload.status || payload.reason || null
            })];
        }

        default:
            return [];
    }
}

function reply(hook) {
    // beforeSubmitPrompt must allow the prompt to continue.
    return hook === "beforeSubmitPrompt" ? { continue: true } : {};
}

function readStdin(timeoutMs = 3000) {
    return new Promise(resolve => {
        let data = "";
        const timer = setTimeout(() => resolve(data), timeoutMs);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { data += chunk; });
        process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
        process.stdin.on("error", () => { clearTimeout(timer); resolve(data); });
    });
}

async function main() {
    let hook = process.argv[2] || "";
    try {
        const raw = await readStdin();
        const payload = raw.trim() ? JSON.parse(raw) : {};
        hook = hook || payload.hook_event_name || "";

        if (!isPaused()) {
            const events = mapHook(hook, payload, loadConfig());
            writeSpool(events, SOURCE);
        }
    } catch (err) {
        logError("cursor-hook.log", err);
    }

    process.stdout.write(JSON.stringify(reply(hook)));
    process.exit(0);
}

if (require.main === module) {
    main();
}

module.exports = { mapHook, reply };
