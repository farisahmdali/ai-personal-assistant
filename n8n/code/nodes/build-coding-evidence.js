// @include ../coding/evidence.js
// @include ../coding/summary.js

// Input: claimed work sessions from "Claim Sessions".
const config = $('Config').first().json;

return $input.all().map(item => {
    const row = item.json;
    const built = buildEvidence(row, {
        sendDiffs: config.sendDiffs !== false && config.sendDiffs !== "false",
        timezone: config.timezone
    });

    return {
        json: {
            sessionId: row.session_id,
            attempts: row.attempts,
            final: !!row.final,
            projectRoot: row.project_root,
            projectName: row.project_name,
            startedAt: new Date(row.started_at).toISOString(),
            endedAt: new Date(row.last_event_at).toISOString(),
            processedUntil: built.processedUntil,
            currentMemoryId: row.memory_id ? Number(row.memory_id) : null,
            openTaskIds: (row.open_tasks || []).map(t => Number(t.id)),
            evidenceIds: built.items.map(i => i.id),
            evidenceItems: built.items.map(i => ({ id: i.id, kind: i.kind, text: i.text })),
            facts: built.facts,
            appTime: built.appTime,
            requestBody: buildCodingRequest(built.payload, config.model)
        }
    };
});
