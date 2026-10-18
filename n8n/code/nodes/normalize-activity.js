// @include ../../../cursor-activity/lib/redact.js
// @include ../activity/normalize.js

const body = $('Activity Webhook').first().json.body;
const { rows, invalid } = normalizeBatch(body, new Date().toISOString());

return [{ json: { rows: JSON.stringify(rows), count: rows.length, invalid } }];
