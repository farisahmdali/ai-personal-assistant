# Coding activity → assistant memory

Lets the personal assistant understand what you do in Cursor — manual typing
and AI-assisted work — and keep long-term memories of your coding tasks in the
same `memories` table as browser activity.

```
Cursor extension (this folder) ─┐
Cursor agent hooks (hooks/)  ───┼─► %LOCALAPPDATA%\ai-assistant\spool\*.jsonl
personal-monitor (Rust)  ───────┘        │ personal-monitor forwards, retries
                                          ▼
n8n "Activity Ingest" (/webhook/activity) → activity_events   (raw, 3 days)
n8n "Coding Session Builder" (5 min)      → work_sessions     (temporary context)
                                          → OpenRouter → memories (long-term)
memory-viewer shows coding tasks with status, facts vs inferences, next steps
```

## What is captured

| Source | Events |
|---|---|
| Extension | `workspace_opened`, `editor_focus`, `edit_summary` (per file, per burst of typing: +/− lines and a redacted diff hunk), `file_changes`, `file_renamed`, `terminal_command` (command, exit code, duration, error lines, test pass/fail counts), `git_state` (branch), `git_commit` |
| Cursor hooks | `agent_prompt`, `agent_response`, `agent_file_edit`, `agent_shell`, `agent_tool_failure`, `agent_session_start/end`, `agent_stop` |
| personal-monitor | `window_focus` (app, category: coding/browser/terminal/…, title), `idle_start`, `idle_end` |

Edits are captured from the editor's document changes, so manual typing and
AI edits are both seen; n8n marks an edit as AI-assisted when a Cursor hook
reported an agent edit to the same file at the same time.

Not captured: keystrokes, full file contents, files matching the exclude
rules, password fields, your Cursor account email.

## Setup (Windows)

Prerequisites: n8n + Postgres set up as in `../n8n/README.md`, Node 20+, Rust.

1. **Shared settings and the monitor**
   ```powershell
   cd ..\personal-monitor
   cargo build --release
   .\target\release\personal-monitor.exe init      # creates %LOCALAPPDATA%\ai-assistant\config.json
   ```
2. **Database**: rerun the schema (adds `activity_events`, `work_sessions` and new `memories` columns; safe to rerun):
   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d ai_assistant -f ..\n8n\db\schema.sql
   ```
3. **n8n**: with n8n stopped, in `..\n8n`: `npm run build`, then delete the old *Activity Ingest*
   workflow in the editor (it was a stub on the same webhook path), `npm run import`, `npm start`.
   - **Activity Ingest**: select the Postgres credential on *Store Raw Events* → Activate.
   - **Coding Session Builder**: select Postgres on the 4 Postgres nodes and the OpenRouter
     Header Auth credential on *Ask AI*; check *Config* (model, timezone, `idleMinutes`,
     `interimMinutes`, `rawRetentionDays`, `sendDiffs`) → Activate.
4. **Extension**:
   ```powershell
   cd ..\cursor-activity
   npm run package
   cursor --install-extension cursor-activity-0.1.0.vsix
   ```
   Reload Cursor. *Output → AI Assistant Activity* shows the log.
5. **Agent hooks** (writes `~/.cursor/hooks.json`, backing up any existing file and keeping other hooks):
   ```powershell
   npm run install-hooks          # npm run uninstall-hooks to remove
   ```
   Restart Cursor.
6. **Run the monitor** (it also delivers the extension's and hooks' events):
   ```powershell
   ..\personal-monitor\target\release\personal-monitor.exe run
   ```
   To start it at logon, hidden:
   ```powershell
   $exe = (Resolve-Path ..\personal-monitor\target\release\personal-monitor.exe).Path
   schtasks /Create /TN "AI Assistant Monitor" /SC ONLOGON /RL LIMITED /F `
     /TR "powershell -WindowStyle Hidden -Command `"& '$exe' run`""
   ```

Terminal commands are captured through Cursor's shell integration (on by
default for PowerShell, bash, zsh, fish). If commands don't appear, check
*Settings → Terminal › Integrated › Shell Integration: Enabled*.

## Controls

| Action | How |
|---|---|
| Pause / resume everything | `personal-monitor pause` / `resume`, or the Cursor commands *AI Assistant: Pause/Resume activity capture* |
| See queue and last delivery | `personal-monitor status` |
| Delete queued (undelivered) events | `personal-monitor purge-local` |
| Delete raw activity in the database | `psql … -f ..\n8n\db\purge-activity.sql` |
| Delete memories | `DELETE FROM memories WHERE …` |
| Exclude files | add globs to `excludeGlobs` in `%LOCALAPPDATA%\ai-assistant\config.json` (defaults already exclude `.env*`, keys, certificates, `secrets/`, `node_modules/`, build output) |
| Keep code out of the AI request | set `sendDiffs` to false in the builder's *Config* node (summaries then use file names, line counts, commands and errors) |
| Logs | `%LOCALAPPDATA%\ai-assistant\logs\` (`monitor.log`, `cursor-hook.log`), and Cursor's *AI Assistant Activity* output |

## Privacy

- Secrets are redacted three times: in the collector (diffs, terminal output,
  prompts), again in n8n before storage, and window titles in the monitor.
  Covered: private keys, `sk-…`/GitHub/Slack/AWS/Google keys, JWTs, Bearer
  tokens, passwords in URLs, and values assigned to names like
  `password`, `secret`, `token`, `api_key`.
- Everything stays on this PC except the session evidence sent to OpenRouter
  by the Coding Session Builder (the same integration the browser memories use).
- Raw events are deleted `rawRetentionDays` (default 3) after being summarised;
  work sessions 7 days after closing. Only memories are kept long-term.
- Captured terminal commands are never executed.

## Tests

```powershell
npm test                                  # this folder: libs, hook script, extension (fake vscode)
cd ..\personal-monitor; cargo test        # monitor: spool, forwarder retries, idle, redaction
cd ..\n8n; npm test                       # n8n logic: normalise, sessions, evidence, validation
cd sql-tests; npm install; npm test       # workflow SQL on PGlite + real monitor delivery test
```

## Manual test procedure (Windows)

Keep `personal-monitor run`, n8n and Postgres running. Use two small git
projects, e.g. `C:\code\demo-a` and `C:\code\demo-b`. Shortcut used below:

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"; $env:PGCLIENTENCODING = "UTF8"
function q($sql) { & $psql -U postgres -d ai_assistant -c $sql }
```

1. **Project association** — open `demo-a` in Cursor. Within ~10 s:
   `q "SELECT type, project_name FROM activity_events ORDER BY ts DESC LIMIT 5"` shows `workspace_opened | demo-a`.
2. **Manual typing** — type a few lines in a file, wait 30 s (or save):
   an `edit_summary` row appears; `q "SELECT data->>'file', data->>'linesAdded', data->>'diff' FROM activity_events WHERE type='edit_summary' ORDER BY ts DESC LIMIT 1"`.
3. **No save duplicates** — press Ctrl+S five times without typing: no new `edit_summary` rows.
4. **Grouping** — edit 3 related files (e.g. a service, a form, a test), wait `idleMinutes`
   (set it to 2 in *Config* for testing), run *Coding Session Builder* manually: one `memories`
   row of type `coding_task` mentions all files.
5. **AI edits** — ask the Cursor agent to change a file: `agent_prompt` and `agent_file_edit`
   rows appear; in the memory's evidence the file shows "AI agent +x −y".
6. **Two projects** — work in `demo-b` in a second window:
   `q "SELECT project_name, count(*) FROM work_sessions GROUP BY 1"` shows separate sessions,
   and each memory lists only its own project's files.
7. **Terminal errors / tests** — run a failing test (`npm test` with a broken assertion):
   `terminal_command` has `exitCode` 1, `tests.failed` > 0 and the error line; the memory's
   status is `blocked` or `in_progress` with the failure as a blocker.
8. **Facts vs assumptions** — in memory-viewer (http://localhost:3000) the task shows
   *Observed* items with evidence ids and *Inferred* items with confidence.
9. **Memory workflow** — the coding memory appears in memory-viewer next to browser memories.
10. **Restart safety** — stop n8n, type and save, run `personal-monitor status` (queued > 0),
    stop and restart `personal-monitor run`, start n8n: the queue drains to 0 and the events are
    in `activity_events` once.
11. **Redaction** — type `const key = "sk-test-abcdefghijklmnopqrstuvwxyz"` and save:
    `q "SELECT data->>'diff' FROM activity_events WHERE type='edit_summary' ORDER BY ts DESC LIMIT 1"`
    shows `[REDACTED]`. Edits to `.env` produce no events at all.
12. **Existing features** — browse a page with the Chrome extension: `tmp_activities` and later
    browser `memories` are still created; the monitor still prints window changes to its console.

## Known limitations

- Cursor hook payloads were verified against the installed Cursor 3.17.8; Cursor updates may
  change them (the hook script ignores unknown fields and never blocks Cursor).
- `afterShellExecution` does not report an exit code; agent commands rely on test/error parsing.
- Edits are attributed to the AI by timing (±5 s); a manual edit made in the same seconds as
  an agent edit to the same file is counted as AI-assisted.
- Files changed outside the editor are seen as created/deleted only, not as diffs.
- Summaries need n8n, Postgres, the monitor and OpenRouter; collectors keep working and
  queue locally while any of them is down.
