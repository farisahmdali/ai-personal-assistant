// Builds the grouped activity sent to the AI and parses the AI's memory reply.

const MAX_EVENTS = 150;
const MAX_EVENT_CHARS = 12000;
const MAX_ATTEMPTS = 3;

const MEMORY_SYSTEM_PROMPT = `You turn a user's browser activity into long-term memory for their personal AI assistant.

You receive one activity: the website, page, time range and a list of timestamped events captured in the browser (pages opened, clicks, text entered, messages that appeared, new content).

Decide:
1. What the user actually did.
2. What task they were working on.
3. Whether it is worth remembering. Store meaningful work, decisions, things created, submitted, sent, purchased or booked, focused research on a topic, and anything left unfinished. Do not store idle browsing, page loads with no real action, ads or noise.
4. Important entities: projects, websites, files, tasks, people, organizations, products, topics, decisions, goals.
5. Whether a task was left unfinished (for example a form filled in but not submitted, or an error that was not resolved).

Rules:
- Use only what the events show. Do not invent details.
- Never include passwords, card numbers, one-time codes or other secrets.
- Write about the user in the past tense ("Created…", "Researched…").
- importance is 0.0–1.0: about 0.2 routine, 0.5 useful context, 0.8+ significant work or decisions.

Reply with JSON only, no other text. Either
{"shouldStore": false}
or
{
  "shouldStore": true,
  "memoryType": "activity" | "task" | "research" | "decision" | "communication" | "purchase",
  "summary": "one sentence",
  "details": ["short fact", "..."],
  "entities": [{"type": "project|website|file|task|person|organization|product|topic", "name": "..."}],
  "pendingTask": "what remains to be done" or null,
  "importance": 0.0
}`;

function localTime(value, timeZone, withDate) {
    const d = new Date(value);
    const opts = { timeZone, hour12: false };
    // sv-SE formats as "2026-10-08 09:05:12"
    const s = d.toLocaleString("sv-SE", opts);
    return withDate ? s : s.slice(11);
}

// row: claimed tmp_activities row with aggregated events [{ at, kind, text }]
function buildActivity(row, timeZone) {
    const events = row.events || [];
    const lines = [];
    let budget = MAX_EVENT_CHARS;

    for (const e of events) {
        if (lines.length >= MAX_EVENTS) break;
        const line = `${localTime(e.at, timeZone, false)} ${e.text}`;
        if (line.length > budget) break;
        budget -= line.length;
        lines.push(line);
    }

    if (events.length > lines.length) {
        lines.push(`(${events.length - lines.length} more events omitted)`);
    }

    return {
        sessionId: row.activity_id,
        website: row.website,
        page: row.page_title || "",
        timeRange: {
            start: localTime(row.started_at, timeZone, true),
            end: localTime(row.last_event_at, timeZone, true)
        },
        events: lines
    };
}

function buildRequest(activity, model) {
    return {
        model,
        temperature: 0.2,
        messages: [
            { role: "system", content: MEMORY_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(activity, null, 2) }
        ]
    };
}

// Returns { action: "store" | "discard" | "retry" | "drop", memory?, error? }
function parseMemory(response, attempts) {
    const failure = error => ({ action: (attempts || 0) >= MAX_ATTEMPTS ? "drop" : "retry", error });

    if (!response || response.error || !Array.isArray(response.choices)) {
        const message = response && response.error ? (response.error.message || JSON.stringify(response.error)) : "no choices in response";
        return failure(message);
    }

    let content = response.choices[0] && response.choices[0].message ? response.choices[0].message.content : "";
    if (typeof content !== "string") content = JSON.stringify(content || "");

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end < start) return failure("reply is not JSON");

    let parsed;
    try {
        parsed = JSON.parse(content.slice(start, end + 1));
    } catch (err) {
        return failure("invalid JSON: " + err.message);
    }

    if (parsed.shouldStore !== true) {
        return { action: "discard" };
    }

    if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
        return failure("memory has no summary");
    }

    const importance = Number(parsed.importance);
    const pending = parsed.pendingTask;

    return {
        action: "store",
        memory: {
            memoryType: typeof parsed.memoryType === "string" && parsed.memoryType ? parsed.memoryType : "activity",
            summary: parsed.summary.trim(),
            details: Array.isArray(parsed.details) ? parsed.details.filter(d => typeof d === "string") : [],
            entities: Array.isArray(parsed.entities)
                ? parsed.entities.filter(e => e && typeof e.name === "string").map(e => ({ type: String(e.type || "other"), name: e.name }))
                : [],
            pendingTask: pending == null || pending === "" ? null : (typeof pending === "string" ? pending : JSON.stringify(pending)),
            importance: isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5
        }
    };
}
