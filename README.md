# AI Personal Assistant — how the system works

This system watches what you do on your computer — in the browser, in Cursor,
and across applications — and turns it into short **memories** the assistant
can use later ("what was I doing, what did I finish, what is still open").

Raw activity is kept only briefly. Only the AI-written memories are kept
long-term.

---

## 1. The big picture

```
 BROWSER                         CODING (Cursor)                    WHOLE PC
 ───────                         ───────────────                    ────────
 chrome-extrension               cursor-activity                    personal-monitor (Rust)
 content.js + background.js      extension + Cursor hooks           window focus + idle time
        │                               │                                  │
        │ POST /webhook/dom-snapshot    │ writes .jsonl files              │ writes .jsonl files
        │                               ▼                                  ▼
        │                 %LOCALAPPDATA%\ai-assistant\spool\   ◄──────────────┘
        │                               │
        │                               │ personal-monitor reads the folder and
        │                               │ POSTs /webhook/activity, then deletes the files
        ▼                               ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ n8n (http://localhost:5678)                                                 │
 │                                                                             │
 │  DOM Snapshot Ingest ──► tmp_* tables ──► Memory Builder (every 10 min) ─┐  │
 │                                                                          │  │
 │  Activity Ingest ──► activity_events ──► Coding Session Builder (5 min) ─┤  │
 │                                          (work_sessions)                 │  │
 │                                                       OpenRouter AI ◄────┤  │
 └──────────────────────────────────────────────────────────────────────────┼──┘
                                                                            ▼
                                         PostgreSQL  ai_assistant.memories (permanent)
                                                                            │
                                                     memory-viewer  http://localhost:3000
```

| Folder | What it is |
|---|---|
| `chrome-extrension/` | Chrome extension that captures what you see and do on web pages |
| `cursor-activity/` | Cursor (VS Code) extension + Cursor agent hook script for coding activity |
| `personal-monitor/` | Rust program: watches the active window and idle time, and delivers all queued coding/PC events to n8n |
| `n8n/` | The workflows, their code, database schema and tests |
| `memory-viewer/` | Small website that shows the memories |

Everything runs on your PC. The only thing sent outside is the grouped
activity sent to **OpenRouter** to write the memory.

---

## 2. What must be running

| Program | Start with | Needed for |
|---|---|---|
| PostgreSQL 18 | Windows service `postgresql-x64-18` (starts automatically) | All storage |
| n8n | `cd n8n` → `npm start` | All processing |
| personal-monitor | `personal-monitor.exe run` | Delivering coding + PC events to n8n |
| Chrome extension | Loaded in `chrome://extensions` | Browser memories |
| Cursor extension + hooks | Installed in Cursor | Coding memories |
| memory-viewer | `cd memory-viewer` → `npm start` | Viewing memories (optional) |

In n8n these four workflows must be **Active**: *DOM Snapshot Ingest*,
*Memory Builder*, *Activity Ingest*, *Coding Session Builder*.

---

## 3. Browser pipeline

### 3.1 Chrome extension — when a page is captured

`content.js` builds a small JSON tree of the visible page (no scripts, styles,
class names or hidden elements) plus your clicks, inputs and form submits, and
sends it to `background.js`, which posts it to n8n.

| Trigger (`reason`) | When it fires |
|---|---|
| `load` | The page finished loading |
| `mutation` | The page changed: sent **2 s** after changes stop, but at least every **10 s** while it keeps changing |
| `navigation` | The URL changed without a reload (single-page apps, back/forward, `#hash`) |
| `interaction` | **~0.8 s** after a click, a changed field or a form submit; also right before you leave the tab |
| `visible` | You switched back to the tab and its content changed while you were away |

Conditions:
- **Identical content is never sent twice** (same URL + same tree), unless there were interactions.
- **Background tabs** don't send while hidden; they catch up when you return.
- Limits: **2000** elements per page, **300** characters per text, **200** per field value.
- **Never captured:** password fields, hidden inputs, card numbers, one-time codes
  (they appear only as `Filled in "Password"`).
- If the extension is reloaded, old tabs stop sending until refreshed.

### 3.2 n8n *DOM Snapshot Ingest* (`POST /webhook/dom-snapshot`)

1. Gives every element a **stable id** (`e_1`, `e_2`, …) that stays the same across snapshots of the tab.
2. Compares the new tree with the tab's previous one → **add / remove / update** operations.
   Text changes that only differ in numbers or relative times ("5 min ago") are ignored.
3. Turns them into plain-English **events**, e.g.
   `Entered "personal-assistant" into "Repository name"`, `Clicked button "Create repository"`,
   `Message appeared: "Repository created successfully"`.
4. Adds the events to an **activity** = one tab on one website.

An event joins the tab's current activity only if **all** are true:
same website, last event **< 5 min** ago, activity started **< 60 min** ago.
Otherwise a new activity starts.

### 3.3 n8n *Memory Builder* (every **10 min**)

An activity is **ready** when it has been idle **5 min**, or has run **60 min**.

For each ready activity:
1. Up to **150 events / 12 000 characters** are sent to OpenRouter.
2. The AI answers `shouldStore: false` (noise) or a memory: summary, details,
   entities, pending task, importance 0–1.
3. Result:

| Result | What happens |
|---|---|
| `store` | Memory saved to `memories`; temporary data deleted |
| `discard` | Not worth remembering; temporary data deleted |
| `retry` | AI call failed; activity reopened and tried again next run |
| `drop` | Failed **3** times; temporary data deleted |

Housekeeping each run: activities stuck in "processing" for **30 min** are
reopened; tab state not updated for **2 hours** is deleted.

---

## 4. Coding pipeline

### 4.1 Cursor extension — what and when

Events are kept in memory and written to the spool folder **every 3 s**.

| Event | When |
|---|---|
| `workspace_opened` | Cursor starts or a folder is added |
| `editor_focus` | You open/switch to a file (same file again within **60 s** is not repeated) |
| `edit_summary` | One per **burst of typing** in a file — see below |
| `file_changes` | Files created/deleted, collected for **5 s** (created-then-deleted temp files are ignored) |
| `file_renamed` | A file renamed in Cursor |
| `terminal_command` | A terminal command finished: command, exit code, duration, last **40** output lines, error lines, test pass/fail counts |
| `git_state` | Git branch at start and when it changes |
| `git_commit` | A new commit: hash, branch, message |

**When an `edit_summary` is written** (whichever comes first):

| Condition | Value |
|---|---|
| You save the file (`Ctrl+S`) | immediately |
| You switch to another file | immediately |
| No typing in that file | **30 s** |
| Typing continuously | every **5 min** |
| You close the file / Cursor | immediately |

It contains lines added/removed, number of changes, undo/redo count and a
redacted diff (max **80** lines).

Conditions:
- **Saving without changes writes nothing** → no duplicate events.
- **Typing then undoing everything writes nothing** (no net change).
- Manual typing **and** AI agent edits are both seen (both change the document).
- Files over **1 MB** are not tracked. Nothing is read from disk; keystrokes are never recorded.
- **Excluded files produce no events at all** (see §7.1).
- Terminal capture needs Cursor's shell integration (on by default).

### 4.2 Cursor agent hooks — what and when

Registered in `~/.cursor/hooks.json` by `npm run install-hooks`. Each hook
writes one event to the spool and replies immediately (never blocks Cursor).

| Cursor hook | Event |
|---|---|
| `beforeSubmitPrompt` | `agent_prompt` — your prompt (max 2000 chars) and attached files |
| `afterAgentResponse` | `agent_response` — the reply (max 1500 chars) |
| `afterFileEdit`, `afterTabFileEdit` | `agent_file_edit` — file, lines added/removed, short excerpt |
| `afterShellExecution` | `agent_shell` — command, duration, output tail, errors, tests |
| `postToolUseFailure` | `agent_tool_failure` |
| `sessionStart`, `sessionEnd`, `stop` | `agent_session_start/end`, `agent_stop` |

Your Cursor account email (sent by Cursor in every hook) is **not** stored.

### 4.3 personal-monitor — PC activity and delivery

**Watches** (every **0.5 s**):

| Event | When |
|---|---|
| `window_focus` | The active window changes: app, category, title (redacted) |
| `idle_start` | No keyboard/mouse input for **120 s** (`idleSeconds`) |
| `idle_end` | Input again; includes how long you were away |

App categories (`src/classify.rs`): `coding` (Cursor, VS Code, JetBrains…),
`browser`, `terminal`, `communication`, `notes`, `design`, `database`,
`system`, else `other`.

**Delivers** the spool folder to n8n (`POST <n8nUrl>/webhook/activity`):

| Condition | Behaviour |
|---|---|
| Files waiting | Oldest first, up to **200** events per request |
| Nothing waiting | Checks again after **5 s** |
| n8n answered OK | Those files are **deleted** |
| n8n down / error | Files **kept**; retry after 5 s, 10 s, 20 s … max **5 min** |
| Monitor/PC restarted | Files are still on disk and sent later |
| Same events sent twice | Each event has a fixed id; n8n ignores duplicates |
| Request timeout | 30 s |

### 4.4 n8n *Activity Ingest* (`POST /webhook/activity`)

1. Checks each event (needs a `type`); accepts `{events:[…]}`, an array or one event.
2. Redacts secrets again, caps sizes (max **1000** events per request, **4000**
   chars per text, **30 000** chars per event), clamps future timestamps.
3. Stores in `activity_events`. An id already stored is ignored.
4. Replies `{ received, accepted, invalid }`.

### 4.5 n8n *Coding Session Builder* (every **5 min**)

**Step 1 — group into work sessions.** Only events with a project (coding
events) form sessions. Sessions are **per project**, so two projects are never
mixed. An event joins a session of the same project if it is within
`idleMinutes` (**20**) of it; otherwise a new session starts.

**Step 2 — is a session ready?** All must be true:
- status is `open`,
- it has events not yet summarised,
- **and one of:**
  - **finished:** no new event for `idleMinutes` (**20 min**), or
  - **long-running:** started, or last summarised, `interimMinutes` (**30 min**) ago.

Example: coding 10:00–10:40 → ready at 11:00 → memory by ~11:05.
Coding nonstop from 10:00 → in-progress memory at ~10:35, updated ~11:10, …

**Step 3 — build the evidence** (each item numbered `E1`, `E2`, …):

| Evidence | Detail / limits |
|---|---|
| Files changed | Manual vs AI-agent lines; an edit is **AI-assisted** if an agent edit hit the same file within **±5 s** |
| Diffs | Max **1500** chars per file, **8000** total; none if `sendDiffs` = false |
| Files opened but not changed | |
| Commands & tests | Last **30**; who ran them (you / AI agent), exit code, tests, errors |
| Git | Current branch, commits |
| AI agent | Last **10** prompts, **5** replies, **5** tool failures, run finished |
| App time | Minutes per category, context switches, idle minutes (monitor events from **15 min** before the session) |
| Browser research | Browser memories from **30 min** before / during the session (last **8**) |
| Task context | This task's previous summary + up to **5** other open tasks in the project |

Max **3000** events per session per run; the rest are handled next run.

**Step 4 — AI summary** via OpenRouter: task title, summary, objective,
status, progress, files, observed changes, inferences, decisions, blockers,
tests, next steps, confidence, importance.

**Step 5 — the reply is checked, not trusted:**

| Rule | Effect |
|---|---|
| An "observed change" without valid evidence ids | Moved to **inferences** |
| Status `completed` without a passing test run, a commit, or a finished agent run after its edits | Changed to **in_progress** (with a note) |
| Status `completed` but the last test run failed | Changed to **blocked** |
| `continuesMemoryId` not one of this project's open tasks | Ignored |
| Blockers present | `pending_task` = `Blocked: <blocker> — next: <step>` |
| No blockers, has next steps | `pending_task` = next steps |

**Step 6 — save:**

| Situation | What happens |
|---|---|
| Session already has a memory | That memory is **updated** (summary replaced, files merged, time range extended) |
| AI says it continues an open task of the same project | That task's memory is **updated** |
| Otherwise | A new `coding_task` memory is created |
| `shouldStore: false` | Nothing saved; events marked done |
| AI failed (`retry`) | Session reopened, tried next run; after **3** failures dropped |

Afterwards the summarised events are marked processed. A **finished** session
is closed (unless new events arrived meanwhile); a long-running one stays open.

**Housekeeping each run:** sessions stuck in "processing" **30 min** are reopened;
processed events older than `rawRetentionDays` (**3 days**) and window/idle
events older than that are deleted; closed sessions older than **7 days** are deleted.

---

## 5. Where data is stored

### Local files — `%LOCALAPPDATA%\ai-assistant\`

| Path | Content |
|---|---|
| `config.json` | Shared settings (see §6.1) |
| `spool\*.jsonl` | Events waiting for delivery (one JSON event per line) |
| `paused` | If this file exists, nothing is captured |
| `state.json` | Last delivery time and last error |
| `logs\monitor.log` | Monitor diagnostics (rotates at 5 MB) |
| `logs\cursor-hook.log`, `logs\cursor-extension.log` | Collector errors |

### PostgreSQL — database `ai_assistant`

| Table | Holds | Deleted |
|---|---|---|
| `tmp_tab_state` | Last page tree + id map per browser tab | after 2 h unused |
| `tmp_activities`, `tmp_activity_events` | Browser activities waiting for the AI | when processed |
| `activity_events` | Raw coding / PC events | 3 days after processed |
| `work_sessions` | Coding sessions in progress | 7 days after closed |
| `memories` | **Long-term memories** (browser + coding) | never (only by you) |

Important `memories` columns: `memory_type` (`activity`, `research`, … or
`coding_task`), `summary`, `details`, `entities`, `pending_task`,
`importance`; for coding also `project`, `project_root`, `status`
(`in_progress` / `blocked` / `completed` / `unknown`), `files`, `evidence`
(observed changes, inferences, next steps, evidence items), `confidence`,
`updated_at`.

n8n's own data (workflows, credentials, run history) is separate, in `n8n\data\`.

---

## 6. Configuration

### 6.1 `%LOCALAPPDATA%\ai-assistant\config.json`

Created by `personal-monitor init`. Read by the monitor, Cursor extension and hooks.

| Setting | Default | Meaning |
|---|---|---|
| `n8nUrl` | `http://localhost:5678` | Where events are delivered |
| `excludeGlobs` | `[]` | Extra files to ignore (added to the defaults in §7.1) |
| `captureWindowTitles` | `true` | Include window titles in `window_focus` |
| `idleSeconds` | `120` | Seconds without input before `idle_start` |
| `outputTailLines` | `40` | Terminal output lines kept per command |
| `batchSize` | `200` | Events per delivery request |

The monitor reads it at start (restart it after changes); the extension
re-reads it every 60 s.

### 6.2 n8n *Coding Session Builder* → **Config** node

| Setting | Default | Meaning |
|---|---|---|
| `model` | `qwen/qwen3.8-27b` (paid) | OpenRouter model |
| `timezone` | `Asia/Kolkata` | Times shown to the AI |
| `idleMinutes` | `20` | Break that ends a session |
| `interimMinutes` | `30` | How often long sessions get an in-progress update |
| `rawRetentionDays` | `3` | Days raw events are kept after summarising |
| `sendDiffs` | `true` | Send redacted code diffs to the AI (false = file names, counts, commands, errors only) |

### 6.3 n8n *Memory Builder* → **Config** node

| Setting | Default | Meaning |
|---|---|---|
| `model` | `qwen/qwen3.8-27b` (paid) | OpenRouter model |
| `timezone` | `Asia/Kolkata` | Times shown to the AI |

Fixed in the workflow: 5 min idle / 60 min max per browser activity, 10 min schedule.

### 6.4 `n8n/.env`

| Setting | Value | Meaning |
|---|---|---|
| `N8N_PORT` | `5678` | n8n port |
| `N8N_LISTEN_ADDRESS` | `127.0.0.1` | Only reachable from this PC |
| `N8N_ENCRYPTION_KEY` | generated | Encrypts saved credentials — keep it |
| `GENERIC_TIMEZONE`, `TZ` | `Asia/Kolkata` | Schedules and times |
| `N8N_USER_FOLDER` | `./data` | n8n's own data |
| `N8N_PAYLOAD_SIZE_MAX` | `64` | Max request size (MB) |

### 6.5 `memory-viewer/.env`

`PGHOST`, `PGPORT`, `PGDATABASE` (`ai_assistant`), `PGUSER`, `PGPASSWORD`, `PORT` (`3000`).

### 6.6 n8n credentials

| Credential | Used by |
|---|---|
| Postgres (`localhost:5432`, `ai_assistant`) | Every Postgres node |
| Header Auth `Authorization: Bearer <OpenRouter key>` | *Ask AI* in Memory Builder and Coding Session Builder |

---

## 7. Privacy and control

### 7.1 Never captured

- Keystrokes, full file contents, screenshots.
- Password fields, hidden inputs, card numbers, one-time codes.
- Files matching the exclude rules — defaults: `.env`, `.env.*`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `secrets/`, `.secrets/`,
  `node_modules/`, `.git/`, `dist/`, `build/`, `target/`, `.next/`, `out/`.
- Your Cursor account email.

### 7.2 Secrets are redacted (replaced by `[REDACTED]`)

Private keys, `sk-…` / GitHub / Slack / AWS / Google keys, JWTs, `Bearer`
tokens, passwords inside URLs, and values assigned to names containing
`password`, `secret`, `token`, `api_key`, `credential`, …
Redaction happens in the collector, again in n8n, and for window titles in the monitor.

### 7.3 Controls

| Action | Command |
|---|---|
| Pause everything | `personal-monitor pause` or Cursor command *AI Assistant: Pause activity capture* |
| Resume | `personal-monitor resume` / *Resume activity capture* |
| Queue and delivery status | `personal-monitor status` |
| Delete queued events | `personal-monitor purge-local` |
| Delete raw coding/PC activity in DB | `psql … -f n8n\db\purge-activity.sql` |
| Delete old browser capture table | `psql … -f n8n\db\drop-page-visits.sql` |
| Remove Cursor hooks | `cd cursor-activity` → `npm run uninstall-hooks` |
| Delete memories | `DELETE FROM memories WHERE …` |

---

## 8. Useful queries

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"; $env:PGCLIENTENCODING = "UTF8"
function q($sql) { & $psql -U postgres -d ai_assistant -c $sql }

q "SELECT ts, source, type, project_name FROM activity_events ORDER BY ts DESC LIMIT 10"   # latest raw events
q "SELECT project_name, status, started_at, last_event_at, now() FROM work_sessions ORDER BY last_event_at DESC"
q "SELECT activity_start, website, summary, pending_task FROM memories ORDER BY activity_start DESC LIMIT 10"
q "SELECT project, page_title, status, pending_task FROM memories WHERE memory_type='coding_task' ORDER BY updated_at DESC"
q "SELECT summary, pending_task FROM memories WHERE pending_task IS NOT NULL ORDER BY activity_start DESC"   # unfinished work
```

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Spool files pile up | `personal-monitor run` or n8n not running | Start them; check `lastError` in `personal-monitor status` |
| `404` from a webhook | Workflow not Active | Activate it in n8n |
| No coding events | Extension not loaded, paused, or file excluded | Cursor → Output → *AI Assistant Activity*; `personal-monitor resume` |
| *Claim Sessions* returns nothing | No session ready yet (see §4.5 Step 2) | Wait; for testing set `idleMinutes` to 1 |
| Session stuck `processing` | A node was run alone with *Execute step* | `UPDATE work_sessions SET status='open' WHERE status='processing'`, then **Execute workflow** |
| *Ask AI* fails | Key format, model name or no OpenRouter credit | Header value must be `Bearer sk-or-…` |
| Postgres node fails | Wrong credential or schema not applied | Rerun `n8n\db\schema.sql` |
| `psql` encoding error | Emoji in data, console in WIN1252 | `$env:PGCLIENTENCODING = "UTF8"` |

---

## 10. Changing and testing

Workflow code lives in `n8n/code/` and `n8n/workflow-templates/`. After a
change: stop n8n → `npm run build` → `npm run import` → reselect credentials.

```powershell
cd cursor-activity;   npm test        # extension, hooks, libraries
cd personal-monitor;  cargo test      # spool, delivery, idle, redaction
cd n8n;               npm test        # workflow logic
cd n8n\sql-tests;     npm test        # workflow SQL on PGlite + real delivery test
```

More detail: `cursor-activity/README.md` (setup + manual test procedure),
`n8n/README.md`, `personal-monitor/README.md`.
