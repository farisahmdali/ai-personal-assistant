
// Captures a compact semantic tree of the page plus the user's interactions
// and sends it to the background script on load, on DOM changes, on in-page
// (SPA) navigation, after interactions and when the tab becomes visible.
// n8n diffs consecutive trees and turns them into activity events.

const DEBOUNCE_MS = 2000;     // wait for the DOM to settle
const MAX_WAIT_MS = 10000;    // but send at least this often while it keeps changing
const INTERACTION_MS = 800;   // capture shortly after a click / change / submit
const MAX_NODES = 2000;
const MAX_TEXT = 300;
const MAX_VALUE = 200;

const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME",
    "OBJECT", "EMBED", "LINK", "META", "HEAD", "VIDEO", "AUDIO", "PICTURE", "SOURCE"
]);

// Elements kept as nodes in the tree. Everything else is flattened.
const KEEP_TAGS = new Set([
    "H1", "H2", "H3", "H4", "H5", "H6", "P", "A", "BUTTON", "LABEL", "LI", "UL", "OL",
    "TABLE", "TR", "TD", "TH", "FORM", "DIALOG", "IMG", "PRE", "BLOCKQUOTE", "MAIN",
    "ARTICLE", "NAV", "HEADER", "FOOTER", "ASIDE", "SUMMARY", "DETAILS", "FIGCAPTION",
    "DT", "DD", "INPUT", "TEXTAREA", "SELECT"
]);

// Flattened elements whose text joins the surrounding text.
const INLINE_TAGS = new Set([
    "SPAN", "B", "I", "EM", "STRONG", "SMALL", "CODE", "ABBR", "TIME", "MARK",
    "SUP", "SUB", "U", "S", "FONT", "KBD", "Q", "CITE", "BDI", "WBR", "BR"
]);

const KEEP_ATTRS = [
    "id", "name", "role", "aria-label", "data-testid", "href", "type", "placeholder",
    "aria-expanded", "aria-selected", "disabled", "open"
];

// Attributes that by themselves make a flattened element worth keeping.
const IDENTITY_ATTRS = ["role", "aria-label", "data-testid"];

const GENERATED_ID = /\d{4,}|^:r|^[a-f0-9-]{12,}$/i;
const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code|current-password|new-password)/;

const CLICKABLE = [
    "button", "a[href]", "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=checkbox]", "[role=switch]", "summary",
    "input[type=submit]", "input[type=button]", "input[type=checkbox]", "input[type=radio]"
].join(",");

let lastSentHash = null;
let lastUrl = location.href;
let pendingReason = null;
let debounceTimer = null;
let maxWaitTimer = null;
let observer = null;
let interactions = [];


// ---------------------------------------------------------------------------
// Semantic tree
// ---------------------------------------------------------------------------

function clean(text, max = MAX_TEXT) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function isSecretField(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    return type === "password" || SECRET_AUTOCOMPLETE.test(autocomplete);
}

function labelOf(el) {
    if (el.labels && el.labels.length) {
        const text = clean(el.labels[0].innerText, 80);
        if (text) return text;
    }

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
        const text = clean(labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || "").join(" "), 80);
        if (text) return text;
    }

    return clean(
        el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
        el.getAttribute("title") || el.getAttribute("name") || "",
        80
    );
}

function controlState(el) {
    const tag = el.tagName;
    const state = {};
    const type = (el.getAttribute("type") || "").toLowerCase();

    if (tag === "INPUT" && (type === "checkbox" || type === "radio")) {
        state.checked = el.checked;
    } else if (tag === "SELECT") {
        state.value = clean(el.selectedOptions[0]?.text || "", MAX_VALUE);
    } else if (el.isContentEditable) {
        state.value = clean(el.innerText, MAX_VALUE);
    } else if (!isSecretField(el) && "value" in el) {
        state.value = clean(el.value, MAX_VALUE);
    }

    return state;
}

function attrsOf(el) {
    const attrs = {};

    for (const name of KEEP_ATTRS) {
        const value = el.getAttribute(name);
        if (value === null) continue;
        if (name === "id" && GENERATED_ID.test(value)) continue;
        attrs[name] = name === "href" ? clean(el.href || value, 300) : clean(value, 120);
    }

    if (el.tagName === "IMG") {
        const alt = clean(el.getAttribute("alt"), 120);
        if (alt) attrs.alt = alt;
    }

    return attrs;
}

function isVisible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility !== "function" || el.checkVisibility()) return true;
    // display: contents has no box but its children are visible.
    return getComputedStyle(el).display === "contents";
}

function buildTree() {
    let count = 0;

    // Returns { nodes: [...], text: "inline text not yet placed in a node" }
    function walk(el) {
        if (el.nodeType === Node.TEXT_NODE) {
            return { nodes: [], text: el.data };
        }
        if (el.nodeType !== Node.ELEMENT_NODE || count >= MAX_NODES) {
            return { nodes: [], text: "" };
        }

        const tag = el.tagName;
        if (SKIP_TAGS.has(tag) || !isVisible(el)) {
            return { nodes: [], text: "" };
        }
        if (tag === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") {
            return { nodes: [], text: "" };
        }

        const isControl = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
            (el.isContentEditable && !el.parentElement?.isContentEditable);

        if (isControl) {
            count++;
            const node = { tag: el.isContentEditable ? "textbox" : tag.toLowerCase(), attrs: attrsOf(el), ...controlState(el) };
            const label = labelOf(el);
            if (label) node.attrs.label = label;
            return { nodes: [node], text: "" };
        }

        // Children, with inline text runs turned into #text nodes when they
        // sit between kept nodes.
        const children = [];
        let text = "";

        function flushText() {
            const t = clean(text);
            if (t) children.push({ tag: "#text", text: t });
            text = "";
        }

        for (const child of el.childNodes) {
            const result = walk(child);
            if (result.nodes.length) {
                flushText();
                children.push(...result.nodes);
            }
            text += result.text;
        }

        const attrs = attrsOf(el);
        const keep = KEEP_TAGS.has(tag) || IDENTITY_ATTRS.some(a => attrs[a]) || (attrs.id && !INLINE_TAGS.has(tag));

        if (keep) {
            count++;
            const node = { tag: tag.toLowerCase() };
            if (Object.keys(attrs).length) node.attrs = attrs;

            if (!children.length) {
                const t = clean(text);
                if (t) node.text = t;
            } else {
                flushText();
                node.children = children;
            }
            return { nodes: [node], text: "" };
        }

        if (INLINE_TAGS.has(tag)) {
            return { nodes: children, text: (tag === "BR" ? " " : "") + text };
        }

        // Block-level wrapper (div, section, …): its own text becomes a node.
        flushText();
        return { nodes: children, text: " " };
    }

    const root = walk(document.body || document.documentElement);
    return { tag: "body", children: root.nodes };
}


// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function describe(el) {
    const tag = el.tagName.toLowerCase();
    const target = { tag };
    const type = el.getAttribute("type");
    const role = el.getAttribute("role");
    const name = el.getAttribute("name");

    if (type) target.type = type.toLowerCase();
    if (role) target.role = role;
    if (name) target.name = clean(name, 80);

    if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) {
        target.label = labelOf(el);
        Object.assign(target, controlState(el));
    } else {
        target.text = clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.value, 80);
    }

    return target;
}

function recordInteraction(kind, el) {
    interactions.push({ at: Date.now(), kind, target: describe(el) });
    if (interactions.length > 50) interactions.shift();
    scheduleSoon();
}

function onClick(event) {
    const el = event.target instanceof Element ? event.target.closest(CLICKABLE) : null;
    if (el) recordInteraction("click", el);
}

function onChange(event) {
    const el = event.target;
    if (el instanceof Element && (el.matches("input, textarea, select") || el.isContentEditable)) {
        recordInteraction("change", el);
    }
}

function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    interactions.push({
        at: Date.now(),
        kind: "submit",
        target: {
            tag: "form",
            label: clean(form.getAttribute("aria-label") || form.getAttribute("name") ||
                form.querySelector("h1, h2, h3, legend")?.innerText || "", 80)
        }
    });
    scheduleSoon();
}


// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// FNV-1a 32-bit
function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function capture(reason) {
    // Extension was reloaded or removed: this script is orphaned.
    if (!chrome.runtime?.id) {
        teardown();
        return;
    }

    const tree = buildTree();
    const treeHash = hash(location.href + JSON.stringify(tree));

    if (treeHash === lastSentHash && !interactions.length) {
        return;
    }

    const payload = {
        type: "dom_snapshot",
        reason,
        url: location.href,
        title: document.title,
        capturedAt: Date.now(),
        tree,
        interactions
    };

    lastSentHash = treeHash;
    lastUrl = location.href;
    interactions = [];

    try {
        chrome.runtime.sendMessage(payload).catch(() => {});
    } catch {
        teardown();
    }
}


// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function clearTimers() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
}

function flush() {
    const reason = pendingReason;
    clearTimers();
    pendingReason = null;

    // Hidden tabs are caught up when they become visible again.
    if (reason && !document.hidden) {
        capture(reason);
    }
}

const REASON_RANK = { mutation: 0, navigation: 1, interaction: 2 };

function schedule(reason, delay = DEBOUNCE_MS) {
    if (!pendingReason || REASON_RANK[reason] > REASON_RANK[pendingReason]) {
        pendingReason = reason;
    }

    if (document.hidden) {
        return;
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, delay);

    if (!maxWaitTimer) {
        maxWaitTimer = setTimeout(flush, MAX_WAIT_MS);
    }
}

function scheduleSoon() {
    schedule("interaction", INTERACTION_MS);
}

function onMutation() {
    // Don't let DOM churn push an interaction capture back.
    if (pendingReason === "interaction") return;
    schedule(location.href !== lastUrl ? "navigation" : "mutation");
}

function onNavigation() {
    schedule("navigation");
}

function onVisibilityChange() {
    if (document.hidden) {
        // Send what the user just did before they leave the tab.
        if (interactions.length) capture("interaction");
        return;
    }

    clearTimers();
    pendingReason = null;
    capture("visible");
}

function onPageHide() {
    if (interactions.length) capture("interaction");
}


function teardown() {
    observer?.disconnect();
    clearTimers();
    window.removeEventListener("popstate", onNavigation);
    window.removeEventListener("hashchange", onNavigation);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("submit", onSubmit, true);
}


observer = new MutationObserver(onMutation);
observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
});

window.addEventListener("popstate", onNavigation);
window.addEventListener("hashchange", onNavigation);
window.addEventListener("pagehide", onPageHide);
document.addEventListener("visibilitychange", onVisibilityChange);
document.addEventListener("click", onClick, true);
document.addEventListener("change", onChange, true);
document.addEventListener("submit", onSubmit, true);

capture("load");
