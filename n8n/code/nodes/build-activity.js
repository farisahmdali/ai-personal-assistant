// @include ../memory.js

const config = $('Config').first().json;

return $input.all().map(item => {
    const row = item.json;
    const activity = buildActivity(row, config.timezone);

    return {
        json: {
            activityId: row.activity_id,
            attempts: row.attempts,
            website: row.website,
            pageTitle: row.page_title || "",
            startedAt: new Date(row.started_at).toISOString(),
            endedAt: new Date(row.last_event_at).toISOString(),
            activity,
            requestBody: buildRequest(activity, config.model)
        }
    };
});
