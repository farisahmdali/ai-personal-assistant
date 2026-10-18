// Turns DOM diff operations and user interactions into short plain-English
// activity events, e.g.
//   Entered "personal-assistant" into "Repository name"
//   Clicked button "Create repository"
//   Message appeared: "Repository created successfully"

const MESSAGE_ROLES = new Set(["alert", "status", "alertdialog", "dialog"]);
const MAX_CONTENT_ITEMS = 5;
const MAX_CONTENT_CHARS = 600;

function clip(value, max) {
    const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function hostPath(url) {
    try {
        const u = new URL(url);
        return u.host + u.pathname;
    } catch {
        return String(url);
    }
}

function textOf(node, max) {
    const parts = [];

    (function walk(n) {
        if (n.text) parts.push(n.text);
        for (const child of n.children || []) walk(child);
    })(node);

    return clip(parts.join(" "), max);
}

// Name of an interaction target ({ tag, type, role, label, text, name, ... }).
function targetName(t) {
    return t.label || t.text || t.ariaLabel || t.name || t.placeholder || "";
}

// Name of a tree node ({ tag, text, attrs }).
function nodeName(node) {
    const a = node.attrs || {};
    return a.label || a["aria-label"] || node.text || a.name || a.placeholder || "";
}

function targetKind(t) {
    if (t.role) return t.role;
    if (t.tag === "a") return "link";
    if (t.tag === "input" && /^(submit|button|reset)$/.test(t.type || "")) return "button";
    return t.tag || "element";
}

function isMessageNode(node) {
    const role = node.attrs && node.attrs.role;
    return node.tag === "dialog" || MESSAGE_ROLES.has(role);
}

function findMessage(node, depth = 0) {
    if (isMessageNode(node)) return node;
    if (depth > 4) return null;
    for (const child of node.children || []) {
        const found = findMessage(child, depth + 1);
        if (found) return found;
    }
    return null;
}

function toIso(at) {
    const d = new Date(at);
    return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// ctx: { at, url, prevUrl, title, isFirst }
// after: Map of id -> node for the current tree (indexTree in diff.js)
function toEvents(ops, interactions, ctx, after) {
    const events = [];
    const at = toIso(ctx.at);

    function push(time, kind, text) {
        if (!text) return;
        const last = events[events.length - 1];
        if (last && last.text === text) return;
        events.push({ at: time, kind, text });
    }

    if (ctx.isFirst || ctx.url !== ctx.prevUrl) {
        const title = clip(ctx.title || hostPath(ctx.url), 120);
        push(at, "navigation", `Opened "${title}" (${clip(hostPath(ctx.url), 150)})`);
    }

    // What the user did, in order.
    const handled = new Set();
    const sorted = [...(interactions || [])].sort((a, b) => (a.at || 0) - (b.at || 0));

    for (const it of sorted) {
        const t = it.target || {};
        const time = toIso(it.at || ctx.at);
        const name = clip(targetName(t), 80);

        if (it.kind === "click") {
            if (t.tag === "input" && (t.type === "checkbox" || t.type === "radio")) continue;
            if (name) push(time, "interaction", `Clicked ${targetKind(t)} "${name}"`);
        } else if (it.kind === "change") {
            if (!name) continue;
            handled.add(name);

            if (t.type === "checkbox") {
                push(time, "input", `${t.checked ? "Checked" : "Unchecked"} "${name}"`);
            } else if (t.type === "radio") {
                if (t.checked !== false) push(time, "input", `Selected "${name}"`);
            } else if (t.tag === "select") {
                push(time, "input", `Selected "${clip(t.value, 80)}" in "${name}"`);
            } else if (t.value === undefined) {
                push(time, "input", `Filled in "${name}"`);
            } else if (t.value === "") {
                push(time, "input", `Cleared "${name}"`);
            } else {
                push(time, "input", `Entered "${clip(t.value, 200)}" into "${name}"`);
            }
        } else if (it.kind === "submit") {
            push(time, "interaction", name ? `Submitted form "${name}"` : "Submitted a form");
        }
    }

    // What changed on the page.
    let contentItems = 0;
    let contentChars = 0;

    for (const op of ops) {
        if (op.op === "update") {
            const node = after.get(op.elementId);
            if (!node) continue;
            const name = clip(nodeName(node), 80);
            const changes = op.changes;

            if ("value" in changes && name && !handled.has(name) && changes.value) {
                push(at, "input", `Entered "${clip(changes.value, 200)}" into "${name}"`);
            }
            if ("checked" in changes && name && !handled.has(name)) {
                const isRadio = node.attrs && node.attrs.type === "radio";
                if (isRadio) {
                    // The other radio in the group unchecking is implied.
                    if (changes.checked) push(at, "input", `Selected "${name}"`);
                } else {
                    push(at, "input", `${changes.checked ? "Checked" : "Unchecked"} "${name}"`);
                }
            }
            if ("text" in changes && changes.text && isMessageNode(node)) {
                push(at, "message", `Message appeared: "${clip(changes.text, 200)}"`);
            }
        } else if (op.op === "add") {
            const el = op.element;

            const message = findMessage(el);
            if (message) {
                const text = textOf(message, 300);
                if (text) push(at, "message", `Message appeared: "${text}"`);
                continue;
            }

            if (/^h[1-6]$/.test(el.tag) && el.text) {
                push(at, "section", `Section appeared: "${clip(el.text, 150)}"`);
                continue;
            }

            if (contentItems >= MAX_CONTENT_ITEMS || contentChars >= MAX_CONTENT_CHARS) continue;
            const text = textOf(el, MAX_CONTENT_CHARS - contentChars);
            if (text.length >= 3) {
                contentItems++;
                contentChars += text.length;
                push(at, "content", `New content: "${text}"`);
            }
        }
    }

    return events;
}
