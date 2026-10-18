# personal-monitor

Windows activity monitor for the personal assistant.

- Watches the foreground window (application, category, title) and prints
  changes to the console, as before.
- Detects idle time (no keyboard/mouse input for `idleSeconds`) without
  reading which keys were pressed.
- Writes these as events to the shared spool `%LOCALAPPDATA%\ai-assistant\spool`.
- Delivers **all** spooled events — its own and those from the Cursor
  extension and Cursor hooks (`../cursor-activity`) — to n8n
  (`<n8nUrl>/webhook/activity`) in batches, deleting files only after n8n
  accepted them and retrying with backoff otherwise.

```
personal-monitor [run|init|pause|resume|status|purge-local]
```

Settings: `%LOCALAPPDATA%\ai-assistant\config.json` (created by `init`):

```json
{
  "n8nUrl": "http://localhost:5678",
  "excludeGlobs": [],
  "captureWindowTitles": true,
  "idleSeconds": 120,
  "outputTailLines": 40,
  "batchSize": 200
}
```

Set `AI_ASSISTANT_HOME` to use a different data directory (used by tests).

App categories are defined in `src/classify.rs`; add executables there to
recognise more applications.

`cargo test` covers the spool, forwarder retries, idle detection, title
redaction, timestamps and classification. See `../cursor-activity/README.md`
for setup and the end-to-end test procedure.
