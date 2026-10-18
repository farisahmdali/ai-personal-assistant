# n8n — AI Personal Assistant

Self-hosted n8n, run with Node.js, that serves as the automation layer for the
assistant. The `chrome-extrension` and `personal-monitor` projects post
activity events to it.

## Setup

Requires Node.js 20.19 or newer (the `--env-file` flag needs Node 20.6+).

```sh
cp .env.example .env        # then set N8N_ENCRYPTION_KEY
npm install
npm start
```

Open http://localhost:5678 and create the owner account. n8n stores its data
in `data/`.

## Import the bundled workflows

With n8n stopped:

```sh
npm run import
```

Then start n8n, select credentials on the Postgres / HTTP nodes and activate
the workflows. Run `npm run build` first whenever `code/` or
`workflow-templates/` changed.

## Activity Ingest webhook (computer and coding activity)

`POST http://localhost:5678/webhook/activity`
(`/webhook-test/activity` while testing from the editor)

Called by `personal-monitor`, which delivers events from the monitor itself,
the Cursor extension and Cursor hooks (see `../cursor-activity/README.md`).
Body: `{ "events": [...] }`, an array, or a single event, in the shared
envelope format:

```json
{ "id": "…", "ts": "2026-10-11T04:15:00Z", "source": "cursor-ext", "type": "edit_summary",
  "project": { "root": "c:/code/employee-management", "name": "employee-management" },
  "data": { "file": "src/AddEmployee.tsx", "linesAdded": 4, "linesRemoved": 9, "diff": "…" } }
```

The original simple format (`{ "source", "type", "url", "title", "timestamp" }`)
is still accepted. Events are redacted again and stored in `activity_events`;
an event id that was already stored is ignored, so retries are safe. The
response is `{ "received", "accepted", "invalid" }`.

The **Coding Session Builder** workflow (every 5 minutes) groups project events
into `work_sessions` (split after `idleMinutes` of inactivity), builds an
evidence package per session (files changed manually vs by the AI agent,
commands, tests, git, agent prompts, time per app, browser research), asks
OpenRouter for a task summary, checks it (facts must cite evidence; "completed"
needs passing tests, a commit or a finished agent run) and stores or updates a
`coding_task` row in `memories`. Its settings are in the **Config** node.

Before the old stub workflow named *Activity Ingest* can be replaced, delete
it in the editor; the new one uses the same webhook path.

## Browser activity → memory

The Chrome extension captures what you do in the browser. n8n turns it into
short activity events, groups them, asks an AI what is worth remembering, and
keeps **only the resulting memory**. Raw page data is never stored permanently.

```text
Chrome extension
  content.js   builds a compact semantic tree of the page (no scripts, styles,
               hidden elements or class names) + your clicks, inputs, submits
     │  POST /webhook/dom-snapshot
     ▼
DOM Snapshot Ingest (workflow)
  stable element ids (e_N) → diff vs the tab's previous tree → events like
  'Entered "personal-assistant" into "Repository name"'
     │  tmp_tab_state, tmp_activities, tmp_activity_events
     ▼
Memory Builder (workflow, every 10 min)
  activity = one tab on one website, finished after 5 min idle or 60 min
  → OpenRouter → { shouldStore, summary, details, entities, pendingTask, importance }
     │  memories                         (permanent)
     ▼  temporary rows for that activity are deleted
```

Snapshots are sent on page load, DOM changes (2 s after they stop, at most
every 10 s), in-page navigation, ~1 s after a click/change/submit, and when you
return to a tab that changed. Identical snapshots are not sent.

### Setup

1. Create the database and tables (enter your `postgres` password when asked):
   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE ai_assistant"
   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d ai_assistant -f db/schema.sql
   ```
   The first command fails harmlessly if the database already exists.
2. With n8n stopped: `npm run build`, then `npm run import`. Start with `npm start`.
3. In n8n, create two credentials:
   - **Postgres**: host `localhost`, port `5432`, database `ai_assistant`, user `postgres`.
   - **Header Auth** (for OpenRouter): name `Authorization`, value `Bearer <your OpenRouter key>`.
4. Open **DOM Snapshot Ingest**, select the Postgres credential on both Postgres
   nodes, save, **Activate**.
5. Open **Memory Builder**, select the Postgres credential on its two Postgres
   nodes and the Header Auth credential on **Ask AI**. In **Config**, set
   `model` to the OpenRouter model you want (default `qwen/qwen3.8-27b` is paid)
   and `timezone`. Save, **Activate**.
6. Reload the extension in `chrome://extensions` and refresh open tabs.

Re-importing a workflow replaces it, so credentials have to be selected again.

### Replacing the old page capture

The earlier **Page Content Ingest** workflow stored full HTML of every page in
`page_visits`. Delete that workflow in the n8n editor. To delete the data it
captured (permanent):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d ai_assistant -f db/drop-page-visits.sql
```

### Reading memories

```sql
-- what happened today
SELECT activity_start, website, summary, pending_task
FROM memories WHERE activity_start >= current_date ORDER BY activity_start;

-- unfinished tasks
SELECT activity_start, summary, pending_task
FROM memories WHERE pending_task IS NOT NULL ORDER BY activity_start DESC;

-- everything about a project
SELECT activity_start, summary FROM memories
WHERE entities @> '[{"type": "project"}]' AND entities::text ILIKE '%personal assistant%';
```

### Privacy

- Password fields, hidden inputs, card numbers and one-time codes are never
  captured (they appear only as `Filled in "Password"`).
- Text you type into other fields is sent to n8n, kept in `tmp_*` tables until
  the activity is processed (usually under 15 minutes), and sent to OpenRouter
  as part of the activity. The AI is told not to keep secrets in memories.
- Everything stays on your machine except the grouped activity sent to OpenRouter.

### Changing the processing logic

The Code-node logic lives in `code/` and is tested with `npm test`.
`npm run build` copies it from `code/` and `workflow-templates/` into
`workflows/`. Edit those files, not the generated workflows or the code inside
the n8n editor (it is overwritten on the next build + import).

| File | Does |
|---|---|
| `code/stable-ids.js` | Gives elements stable `e_N` ids across snapshots |
| `code/diff.js` | add / remove / update operations, ignores number-only and "5 min ago" changes |
| `code/events.js` | Turns operations and interactions into plain-English events |
| `code/ingest.js` | Runs the three above for one snapshot |
| `code/memory.js` | Groups an activity, the AI prompt, parsing the AI's reply |

## Saving workflow changes

Workflows edited in the UI are stored in `data/`, not in `workflows/`. To write
them back into this folder, stop n8n and run `npm run export`. For the two
activity workflows, prefer editing `workflow-templates/` and `code/` instead.

## Tests

```sh
npm test                          # Code-node logic (node:test)
cd sql-tests && npm install && npm test   # workflow SQL on PGlite + monitor delivery
```

`sql-tests/` has its own `package.json` (PGlite) so n8n's `node_modules` is
not touched.
