// Groups project events into work sessions. An event joins an existing
// session of the same project when it falls within `idleMinutes` of it;
// otherwise it starts a new one. Session ids are deterministic
// (project + first event time), so re-running the same input is harmless.
// Projects are never mixed: sessions are always per project root.

function sessionHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// events:   [{ event_id, project_root, project_name, ts }]
// sessions: open sessions [{ session_id, project_root, project_name, started_at, last_event_at }]
function sessionize(events, sessions, idleMinutes) {
    const idleMs = idleMinutes * 60000;
    const byProject = new Map();

    for (const s of sessions || []) {
        const list = byProject.get(s.project_root) || [];
        list.push({
            session_id: s.session_id,
            project_root: s.project_root,
            project_name: s.project_name,
            start: new Date(s.started_at).getTime(),
            last: new Date(s.last_event_at).getTime(),
            changed: false
        });
        byProject.set(s.project_root, list);
    }

    const assignments = [];
    const sorted = [...(events || [])].sort((a, b) => new Date(a.ts) - new Date(b.ts));

    for (const e of sorted) {
        const t = new Date(e.ts).getTime();
        const list = byProject.get(e.project_root) || [];
        byProject.set(e.project_root, list);

        let session = list.find(s => t >= s.start - idleMs && t <= s.last + idleMs);
        if (!session) {
            session = {
                session_id: "ws-" + sessionHash(e.project_root) + "-" + t.toString(36),
                project_root: e.project_root,
                project_name: e.project_name,
                start: t,
                last: t,
                changed: true
            };
            list.push(session);
        }

        session.start = Math.min(session.start, t);
        session.last = Math.max(session.last, t);
        session.changed = true;
        if (e.project_name) session.project_name = e.project_name;
        assignments.push({ event_id: e.event_id, session_id: session.session_id });
    }

    const changedSessions = [];
    for (const list of byProject.values()) {
        for (const s of list) {
            if (s.changed) {
                changedSessions.push({
                    session_id: s.session_id,
                    project_root: s.project_root,
                    project_name: s.project_name,
                    started_at: new Date(s.start).toISOString(),
                    last_event_at: new Date(s.last).toISOString()
                });
            }
        }
    }

    return { sessions: changedSessions, assignments };
}
