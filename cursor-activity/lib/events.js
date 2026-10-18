// Event envelope shared by all collectors, and the local spool they write to.
// The Rust monitor forwards spool files to n8n and deletes them on success.
//
// { id, ts, source, type, project: { root, name } | null, data }

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spoolDir } = require("./config");

let sequence = 0;

function makeEvent(source, type, project, data, ts = new Date()) {
    return {
        id: crypto.randomUUID(),
        ts: new Date(ts).toISOString(),
        source,
        type,
        project: project || null,
        data: data || {}
    };
}

// Writes events atomically: a .tmp file renamed to .jsonl, so the forwarder
// never reads a half-written file.
function writeSpool(events, source, dir = spoolDir()) {
    if (!events.length) return null;
    fs.mkdirSync(dir, { recursive: true });

    const name = `${source}-${Date.now()}-${process.pid}-${sequence++}.jsonl`;
    const file = path.join(dir, name);
    fs.writeFileSync(file + ".tmp", events.map(e => JSON.stringify(e)).join("\n") + "\n");
    fs.renameSync(file + ".tmp", file);
    return file;
}

module.exports = { makeEvent, writeSpool };
