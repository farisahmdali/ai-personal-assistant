// @include ../memory.js

// Input: OpenRouter responses, one per activity from "Build Activity".
return $input.all().map((item, i) => {
    const src = $('Build Activity').itemMatching(i).json;
    const result = parseMemory(item.json, src.attempts);
    const memory = result.memory || {};

    // Postgres query parameters: no nulls, empty strings become NULL in SQL.
    return {
        json: {
            activityId: src.activityId,
            action: result.action,
            error: result.error || "",
            startedAt: src.startedAt,
            endedAt: src.endedAt,
            website: src.website,
            pageTitle: src.pageTitle,
            memoryType: memory.memoryType || "activity",
            summary: memory.summary || "",
            details: JSON.stringify(memory.details || []),
            entities: JSON.stringify(memory.entities || []),
            pendingTask: memory.pendingTask || "",
            importance: memory.importance == null ? 0 : memory.importance
        }
    };
});
