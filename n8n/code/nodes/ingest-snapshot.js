// @include ../stable-ids.js
// @include ../diff.js
// @include ../events.js
// @include ../ingest.js

// Input: the tab's previous state from "Load Tab State" (empty item if none).
const body = $('DOM Snapshot Webhook').first().json.body || {};

if (!body.url || !body.tree || body.tabId == null) {
    return [];
}

const result = processSnapshot(body, $input.first().json || {});

return [{
    json: {
        tabId: result.tabId,
        url: result.url,
        title: result.title,
        website: result.website,
        tree: JSON.stringify(result.tree),
        idMap: JSON.stringify(result.idMap),
        nextId: result.nextId,
        events: JSON.stringify(result.events),
        eventCount: result.events.length
    }
}];
