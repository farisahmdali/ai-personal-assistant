// @include ../coding/summary.js

// Input: OpenRouter responses, one per session from "Build Evidence".
return $input.all().map((item, i) => {
    const src = $('Build Evidence').itemMatching(i).json;
    const result = parseCodingSummary(item.json, src);
    const m = result.memory;

    const memory = m ? {
        sessionId: src.sessionId,
        projectRoot: src.projectRoot,
        projectName: src.projectName,
        startedAt: src.startedAt,
        endedAt: src.endedAt,
        title: m.title,
        taskKey: m.taskKey,
        summary: m.summary,
        status: m.status,
        // Readable facts for the memory list; full structure lives in evidence.
        details: [
            ...(m.objective ? ["Objective: " + m.objective] : []),
            ...(m.progress ? ["Progress: " + m.progress] : []),
            ...m.observedChanges.map(c => c.text + " [" + c.evidence.join(", ") + "]"),
            ...m.blockers.map(b => "Blocker: " + b)
        ],
        entities: [
            { type: "project", name: src.projectName },
            ...m.files.slice(0, 8).map(f => ({ type: "file", name: f }))
        ],
        files: m.files,
        evidence: {
            objective: m.objective,
            progress: m.progress,
            observedChanges: m.observedChanges,
            inferences: m.inferences,
            decisions: m.decisions,
            blockers: m.blockers,
            tests: m.tests,
            nextSteps: m.nextSteps,
            appTime: src.appTime,
            items: src.evidenceItems
        },
        pendingTask: m.pendingTask || "",
        confidence: m.confidence,
        importance: m.importance,
        targetMemoryId: m.targetMemoryId,
        relatedMemoryId: m.relatedMemoryId
    } : {};

    return {
        json: {
            sessionId: src.sessionId,
            action: result.action,
            final: src.final ? "true" : "false",
            processedUntil: src.processedUntil,
            error: result.error || "",
            memory: JSON.stringify(memory)
        }
    };
});
