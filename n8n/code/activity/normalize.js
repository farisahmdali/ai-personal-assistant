// Validates events delivered to /webhook/activity and turns them into
// activity_events rows. Requires redact() (cursor-activity/lib/redact.js).
//
// Accepts { events: [...] }, a bare array, or a single event. Both the shared
// envelope { id, ts, source, type, project, data } and the original simple
// format { source, type, url, title, app, timestamp } are understood.

const MAX_EVENTS_PER_REQUEST = 1000;
const MAX_STRING = 4000;
const MAX_DATA_CHARS = 30000;
const BULKY_FIELDS = ["diff", "outputTail", "excerpt", "text", "prompt"];

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function parseTimestamp(value, fallback) {
    let d;
    if (typeof value === "number") d = new Date(value < 1e12 ? value * 1000 : value);
    else if (typeof value === "string" && value) d = new Date(value);
    if (!d || isNaN(d)) return fallback;
    // Clocks can be wrong; never accept events from the future.
    return d.getTime() > Date.now() + 5 * 60000 ? fallback : d.toISOString();
}

function normalizeRootPath(root) {
    let out = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
}

function cleanData(value, depth) {
    if (typeof value === "string") {
        const s = value.length > MAX_STRING ? value.slice(0, MAX_STRING - 1) + "…" : value;
        return redact(s);
    }
    if (Array.isArray(value)) return value.slice(0, 200).map(v => cleanData(v, depth + 1));
    if (value && typeof value === "object" && depth < 6) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = cleanData(v, depth + 1);
        return out;
    }
    return typeof value === "number" || typeof value === "boolean" || value === null ? value : null;
}

function capSize(data) {
    if (JSON.stringify(data).length <= MAX_DATA_CHARS) return data;
    const out = { ...data };
    for (const field of BULKY_FIELDS) {
        if (typeof out[field] === "string") out[field] = out[field].slice(0, 1000) + "… [truncated]";
        if (JSON.stringify(out).length <= MAX_DATA_CHARS) return out;
    }
    return { truncated: true, keys: Object.keys(data).slice(0, 50) };
}

function normalizeEvent(raw, receivedAt) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const type = typeof raw.type === "string" ? raw.type.trim().slice(0, 64) : "";
    if (!type) return null;

    const source = typeof raw.source === "string" && raw.source.trim() ? raw.source.trim().slice(0, 64) : "unknown";
    const ts = parseTimestamp(raw.ts !== undefined ? raw.ts : raw.timestamp, receivedAt);

    let data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : null;
    if (!data) {
        // Original simple format.
        data = {};
        for (const key of ["url", "title", "app", "application", "windowTitle"]) {
            if (raw[key] !== undefined) data[key] = raw[key];
        }
    }
    data = capSize(cleanData(data, 0));

    const project = raw.project && typeof raw.project === "object" && typeof raw.project.root === "string" && raw.project.root
        ? {
            root: normalizeRootPath(raw.project.root).slice(0, 500),
            name: String(raw.project.name || raw.project.root.split(/[\\/]/).pop()).slice(0, 200)
        }
        : null;

    const id = typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim().slice(0, 128)
        : "legacy-" + fnv1a(source + "|" + type + "|" + ts + "|" + JSON.stringify(data));

    return {
        event_id: id,
        ts,
        source,
        type,
        project_root: project ? project.root : null,
        project_name: project ? project.name : null,
        data
    };
}

function normalizeBatch(body, receivedAt) {
    const now = receivedAt || new Date().toISOString();
    const list = Array.isArray(body) ? body : body && Array.isArray(body.events) ? body.events : body ? [body] : [];

    const rows = [];
    const seen = new Set();
    let invalid = 0;

    for (const raw of list.slice(0, MAX_EVENTS_PER_REQUEST)) {
        const row = normalizeEvent(raw, now);
        if (!row) {
            invalid++;
            continue;
        }
        if (seen.has(row.event_id)) continue;
        seen.add(row.event_id);
        rows.push(row);
    }

    return { rows, invalid: invalid + Math.max(0, list.length - MAX_EVENTS_PER_REQUEST) };
}
