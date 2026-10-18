// @include ../coding/sessionize.js

// Input: { data: { events, sessions } } from "Load Unassigned Events".
const config = $('Config').first().json;
const data = $input.first().json.data || {};
const plan = sessionize(data.events || [], data.sessions || [], Number(config.idleMinutes) || 20);

return [{ json: { plan: JSON.stringify(plan), sessions: plan.sessions.length, events: plan.assignments.length } }];
