// Memory viewer: reads the memories table from PostgreSQL and shows it as a
// plain HTML page.
//
//   npm start   →   http://localhost:3000

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT) || 3000;

const pool = new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || "ai_assistant",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD
});

const template = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const stylesheet = fs.readFileSync(path.join(__dirname, "public", "style.css"), "utf8");


function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function getMemories(search) {
    const { rows } = await pool.query(
        // SELECT * so the page works before and after the coding-activity columns exist.
        `SELECT *
         FROM memories
         WHERE $1 = ''
            OR summary ILIKE '%' || $1 || '%'
            OR details::text ILIKE '%' || $1 || '%'
            OR entities::text ILIKE '%' || $1 || '%'
            OR COALESCE(pending_task, '') ILIKE '%' || $1 || '%'
            OR COALESCE(website, '') ILIKE '%' || $1 || '%'
         ORDER BY activity_start DESC
         LIMIT 300`,
        [search]
    );
    return rows;
}


function renderMemory(m) {
    const time = d => d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const details = (m.details || []).map(d => `<li>${escapeHtml(d)}</li>`).join("");
    const entities = (m.entities || [])
        .map(e => `<span class="tag">${escapeHtml(e.type)}: ${escapeHtml(e.name)}</span>`)
        .join("");

    if (m.memory_type === "coding_task") {
        return renderCodingTask(m, time, details, entities);
    }

    return `
    <article class="memory">
      <div class="meta">
        <span>${time(m.activity_start)}–${time(m.activity_end)}</span>
        <span>${escapeHtml(m.website)}</span>
        <span class="type">${escapeHtml(m.memory_type)}</span>
        <span>importance ${Math.round(m.importance * 100)}%</span>
      </div>
      <p class="summary">${escapeHtml(m.summary)}</p>
      ${m.pending_task ? `<p class="pending">Unfinished: ${escapeHtml(m.pending_task)}</p>` : ""}
      ${details ? `<ul>${details}</ul>` : ""}
      ${entities ? `<div class="tags">${entities}</div>` : ""}
    </article>`;
}

// Coding tasks from the Cursor / computer activity pipeline: observed facts
// and AI inferences are shown separately.
function renderCodingTask(m, time, details) {
    const evidence = m.evidence || {};
    const list = (items, render) => (items || []).map(i => `<li>${render(i)}</li>`).join("");

    const inferences = list(evidence.inferences, i =>
        `${escapeHtml(i.text)} <span class="muted">(${Math.round((i.confidence || 0) * 100)}% sure)</span>`);
    const nextSteps = list(evidence.nextSteps, s => escapeHtml(s));
    const files = (m.files || []).map(f => `<span class="tag">${escapeHtml(f)}</span>`).join("");
    const updated = m.updated_at ? ` · updated ${time(m.updated_at)}` : "";

    return `
    <article class="memory coding">
      <div class="meta">
        <span>${time(m.activity_start)}–${time(m.activity_end)}${updated}</span>
        <span class="project">${escapeHtml(m.project)}</span>
        <span class="status status-${escapeHtml(m.status)}">${escapeHtml((m.status || "unknown").replace("_", " "))}</span>
        <span>confidence ${Math.round((m.confidence || 0) * 100)}%</span>
      </div>
      <p class="title">${escapeHtml(m.page_title)}</p>
      <p class="summary">${escapeHtml(m.summary)}</p>
      ${m.pending_task ? `<p class="pending">Unfinished: ${escapeHtml(m.pending_task)}</p>` : ""}
      ${details ? `<p class="label">Observed</p><ul>${details}</ul>` : ""}
      ${inferences ? `<p class="label">Inferred</p><ul class="inferred">${inferences}</ul>` : ""}
      ${nextSteps ? `<p class="label">Next steps</p><ul>${nextSteps}</ul>` : ""}
      ${files ? `<div class="tags">${files}</div>` : ""}
    </article>`;
}

function renderList(memories) {
    if (!memories.length) {
        return `<p class="empty">No memories found.</p>`;
    }

    let html = "";
    let currentDay = "";

    for (const m of memories) {
        const day = m.activity_start.toLocaleDateString("en-IN", {
            weekday: "long", day: "numeric", month: "long", year: "numeric"
        });
        if (day !== currentDay) {
            currentDay = day;
            html += `<h2>${escapeHtml(day)}</h2>`;
        }
        html += renderMemory(m);
    }

    return html;
}


const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/style.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(stylesheet);
        return;
    }

    if (url.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
    }

    const search = (url.searchParams.get("q") || "").trim().slice(0, 200);

    try {
        const memories = await getMemories(search);
        // Function replacers, so "$&" etc. inside memory text is not interpreted.
        const page = template
            .replace("{{search}}", () => escapeHtml(search))
            .replace("{{count}}", () => String(memories.length))
            .replace("{{memories}}", () => renderList(memories));

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
    } catch (err) {
        console.error(err);
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<p>Could not read memories from PostgreSQL: ${escapeHtml(err.message)}</p>`);
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`Memory viewer running at http://localhost:${PORT}`);
});
