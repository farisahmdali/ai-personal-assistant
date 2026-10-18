// Prompt for the coding-task summary, and validation of the AI's reply.
// The validator enforces the "facts vs inferences" rules instead of trusting
// the model: claims without evidence become inferences, and "completed" needs
// proof (passing tests, a commit, or a finished agent run after its edits).

const CODING_MAX_ATTEMPTS = 3;
const STATUSES = ["in_progress", "blocked", "completed", "unknown"];

const CODING_SYSTEM_PROMPT = `You maintain the long-term memory of a developer's personal AI assistant.

You receive one work session in one project: time range, time spent per application, and numbered evidence items (E1, E2, …) captured from the editor, terminal, git, the Cursor AI agent and the browser. You may also receive the previous summary of the same task and other open tasks in the project.

Infer what the developer is actually working on by reading the evidence together (e.g. a controller, service, schema and form changed together → one feature). Then write a cumulative summary of the task: if a previous summary is given, update it with the new evidence instead of starting over.

Rules:
- observedChanges are facts directly shown by evidence. Every one must cite evidence ids.
- inferences are your interpretations (purpose of a change, likely feature, likely cause of an error). Give each a confidence 0.0–1.0 and cite the evidence it is based on.
- Do not say something is complete just because files were edited. Use "completed" only when evidence shows passing tests, a commit, or a finished AI agent run after the edits. Failing tests or unresolved errors mean "blocked" or "in_progress".
- Record errors, failing tests and failed attempts as blockers if they were not resolved later in the session.
- nextSteps are the most likely next actions, based on blockers and unfinished work.
- If this session continues one of the other open tasks listed, set continuesMemoryId to its id.
- If nothing meaningful happened (only opening files, no changes or commands), return {"shouldStore": false}.
- Never include secrets, passwords or tokens.

Reply with JSON only:
{
  "shouldStore": true,
  "taskKey": "short-kebab-case-name-of-the-task",
  "title": "short task title",
  "summary": "2–3 sentences: what the developer is doing and where it stands",
  "objective": "the current objective",
  "status": "in_progress" | "blocked" | "completed" | "unknown",
  "progress": "what is done so far",
  "files": ["paths involved"],
  "observedChanges": [{"text": "...", "evidence": ["E1"]}],
  "inferences": [{"text": "...", "confidence": 0.7, "evidence": ["E2"]}],
  "decisions": ["technical decisions or dependencies"],
  "blockers": ["unresolved errors or failing tests"],
  "tests": [{"command": "...", "result": "passed | failed | unknown"}],
  "nextSteps": ["..."],
  "confidence": 0.0,
  "importance": 0.0,
  "continuesMemoryId": null
}`;

function buildCodingRequest(payload, model) {
    return {
        model,
        temperature: 0.2,
        messages: [
            { role: "system", content: CODING_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(payload, null, 1) }
        ]
    };
}

function asStrings(value, max = 20, maxLen = 300) {
    return Array.isArray(value)
        ? value.filter(v => typeof v === "string" && v.trim()).slice(0, max).map(v => v.trim().slice(0, maxLen))
        : [];
}

function clamp01(value, fallback) {
    const n = Number(value);
    return isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

// ctx: { attempts, evidenceIds: [], facts, currentMemoryId, openTaskIds: [] }
function parseCodingSummary(response, ctx) {
    const failure = error => ({ action: (ctx.attempts || 0) >= CODING_MAX_ATTEMPTS ? "drop" : "retry", error });

    if (!response || response.error || !Array.isArray(response.choices)) {
        return failure(response && response.error ? (response.error.message || JSON.stringify(response.error)) : "no choices in response");
    }

    let content = response.choices[0] && response.choices[0].message ? response.choices[0].message.content : "";
    if (typeof content !== "string") content = JSON.stringify(content || "");
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end < start) return failure("reply is not JSON");

    let r;
    try {
        r = JSON.parse(content.slice(start, end + 1));
    } catch (err) {
        return failure("invalid JSON: " + err.message);
    }

    if (r.shouldStore !== true) return { action: "discard" };
    if (typeof r.summary !== "string" || !r.summary.trim()) return failure("summary missing");

    const known = new Set(ctx.evidenceIds || []);
    const cite = list => (Array.isArray(list) ? list.filter(id => known.has(id)) : []);

    // Facts must cite real evidence; anything else is an inference.
    const observedChanges = [];
    const inferences = [];
    for (const c of Array.isArray(r.observedChanges) ? r.observedChanges : []) {
        if (!c || typeof c.text !== "string") continue;
        const evidence = cite(c.evidence);
        if (evidence.length) observedChanges.push({ text: c.text.slice(0, 300), evidence });
        else inferences.push({ text: c.text.slice(0, 300), confidence: 0.5, evidence: [], note: "no supporting evidence cited" });
    }
    for (const c of Array.isArray(r.inferences) ? r.inferences : []) {
        if (!c || typeof c.text !== "string") continue;
        inferences.push({ text: c.text.slice(0, 300), confidence: clamp01(c.confidence, 0.5), evidence: cite(c.evidence) });
    }

    let status = STATUSES.includes(r.status) ? r.status : "unknown";
    const facts = ctx.facts || {};
    if (status === "completed" && !(facts.hasPassingTest && facts.lastTestPassed !== false) && !facts.hasCommit && !facts.hasAgentStopAfterEdits) {
        status = "in_progress";
        inferences.push({ text: "The task may be complete, but no passing tests, commit or finished agent run confirms it.", confidence: 0.4, evidence: [] });
    }
    if (status === "completed" && facts.lastTestPassed === false) {
        status = "blocked";
    }

    const blockers = asStrings(r.blockers, 10);
    const nextSteps = asStrings(r.nextSteps, 10);
    const openTaskIds = (ctx.openTaskIds || []).map(Number);
    const continues = Number(r.continuesMemoryId);
    const continuesValid = openTaskIds.includes(continues) ? continues : null;

    const targetMemoryId = ctx.currentMemoryId || continuesValid || null;
    const relatedMemoryId = ctx.currentMemoryId && continuesValid && continuesValid !== ctx.currentMemoryId ? continuesValid : null;

    const files = [...new Set([...asStrings(r.files, 50), ...(facts.filesChanged || [])])].slice(0, 50);

    let pendingTask = null;
    if (status !== "completed") {
        if (blockers.length) pendingTask = `Blocked: ${blockers[0]}${nextSteps.length ? ` — next: ${nextSteps[0]}` : ""}`;
        else if (nextSteps.length) pendingTask = nextSteps.join("; ").slice(0, 500);
    }

    return {
        action: "store",
        memory: {
            title: String(r.title || r.taskKey || "Coding task").slice(0, 200),
            taskKey: String(r.taskKey || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || null,
            summary: r.summary.trim().slice(0, 1500),
            objective: typeof r.objective === "string" ? r.objective.slice(0, 500) : null,
            status,
            progress: typeof r.progress === "string" ? r.progress.slice(0, 1000) : null,
            files,
            observedChanges,
            inferences,
            decisions: asStrings(r.decisions, 10),
            blockers,
            tests: Array.isArray(r.tests)
                ? r.tests.filter(t => t && typeof t.command === "string").slice(0, 10)
                    .map(t => ({ command: t.command.slice(0, 200), result: ["passed", "failed"].includes(t.result) ? t.result : "unknown" }))
                : [],
            nextSteps,
            confidence: clamp01(r.confidence, 0.5),
            importance: clamp01(r.importance, 0.6),
            pendingTask,
            targetMemoryId,
            relatedMemoryId
        }
    };
}
