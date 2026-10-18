// Registers cursor-hook.js for the Cursor hook events we use, in the global
// ~/.cursor/hooks.json. Existing hooks are kept; a backup is written first.
//
//   node scripts/install-hooks.mjs            install / update
//   node scripts/install-hooks.mjs --remove   uninstall

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Verified against the hook events in the installed Cursor 3.17.8 bundle.
export const HOOK_EVENTS = [
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "afterFileEdit",
    "afterTabFileEdit",
    "afterShellExecution",
    "postToolUseFailure",
    "stop"
];

const MARKER = "cursor-hook.js";

export function updateHooks(config, hookScript, remove = false) {
    const out = config && typeof config === "object" ? structuredClone(config) : {};
    out.version = out.version || 1;
    out.hooks = out.hooks && typeof out.hooks === "object" ? out.hooks : {};

    // Drop our previous entries, keep everyone else's.
    for (const [event, entries] of Object.entries(out.hooks)) {
        if (!Array.isArray(entries)) continue;
        out.hooks[event] = entries.filter(e => !(e && typeof e.command === "string" && e.command.includes(MARKER)));
        if (!out.hooks[event].length) delete out.hooks[event];
    }

    if (!remove) {
        for (const event of HOOK_EVENTS) {
            out.hooks[event] = out.hooks[event] || [];
            out.hooks[event].push({ command: `node "${hookScript}" ${event}` });
        }
    }

    return out;
}

function main() {
    const remove = process.argv.includes("--remove");
    const hookScript = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "cursor-hook.js").replace(/\\/g, "/");
    const file = join(process.env.CURSOR_HOME || join(homedir(), ".cursor"), "hooks.json");

    let current = {};
    if (existsSync(file)) {
        current = JSON.parse(readFileSync(file, "utf8"));
        const backup = `${file}.bak-${Date.now()}`;
        copyFileSync(file, backup);
        console.log("backup:", backup);
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(updateHooks(current, hookScript, remove), null, 2) + "\n");
    console.log(remove ? "removed activity hooks from" : "installed activity hooks in", file);
    if (!remove) console.log("hook script:", hookScript);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
