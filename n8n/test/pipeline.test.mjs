import { test } from "node:test";
import assert from "node:assert/strict";
import { load, runNode, el } from "./helpers.mjs";

const lib = load(
    ["stable-ids.js", "diff.js", "events.js", "ingest.js"],
    ["assignIds", "diffTrees", "indexTree", "toEvents", "processSnapshot"]
);

const repoNameInput = (value) => el("input", {
    attrs: { name: "repository[name]", type: "text", label: "Repository name" },
    ...(value === undefined ? {} : { value })
});

function createRepoPage({ name = "", publicChecked = false, alert } = {}) {
    const children = [
        el("h1", { text: "Create a new repository" }),
        el("form", { attrs: { "aria-label": "New repository" } }, [
            repoNameInput(name),
            el("input", { attrs: { name: "visibility", type: "radio", label: "Public" }, checked: publicChecked }),
            el("input", { attrs: { name: "visibility-private", type: "radio", label: "Private" }, checked: !publicChecked }),
            el("button", { attrs: { type: "submit" }, text: "Create repository" })
        ])
    ];
    if (alert) children.push(el("div", { attrs: { role: "alert" }, text: alert }));
    return el("body", {}, [el("main", {}, children)]);
}

test("ids stay stable across snapshots", () => {
    const first = lib.assignIds(createRepoPage(), {}, 1);
    const second = lib.assignIds(createRepoPage({ name: "x" }), first.idMap, first.nextId);

    const ids = t => [...lib.indexTree(t).keys()];
    assert.deepEqual(ids(second.tree), ids(first.tree));
    assert.equal(second.nextId, first.nextId);
});

test("appending to a list keeps existing ids", () => {
    const list = items => el("body", {}, [el("ul", {}, items.map(t => el("li", { text: t })))]);
    const a = lib.assignIds(list(["one", "two"]), {}, 1);
    const b = lib.assignIds(list(["one", "two", "three"]), a.idMap, a.nextId);

    const ops = lib.diffTrees(a.tree, b.tree);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op, "add");
    assert.equal(ops[0].element.text, "three");
    assert.match(ops[0].element.id, /^e_\d+$/);
});

test("diff reports update, add and remove", () => {
    const a = lib.assignIds(createRepoPage(), {}, 1);
    const b = lib.assignIds(createRepoPage({ name: "personal-assistant", alert: "Saved" }), a.idMap, a.nextId);
    const ops = lib.diffTrees(a.tree, b.tree);

    const update = ops.find(o => o.op === "update");
    assert.deepEqual(update.changes, { value: "personal-assistant" });

    const add = ops.find(o => o.op === "add");
    assert.equal(add.element.text, "Saved");
    assert.ok(add.parentId);

    const c = lib.assignIds(createRepoPage({ name: "personal-assistant" }), b.idMap, b.nextId);
    const removed = lib.diffTrees(b.tree, c.tree);
    assert.deepEqual(removed, [{ op: "remove", elementId: add.element.id }]);
});

test("number-only and relative-time text changes are ignored", () => {
    const page = t => el("body", {}, [el("p", { attrs: { id: "status" }, text: t })]);
    const a = lib.assignIds(page("Updated 5 min ago · 12 views"), {}, 1);
    const b = lib.assignIds(page("Updated 6 min ago · 13 views"), a.idMap, a.nextId);
    assert.deepEqual(lib.diffTrees(a.tree, b.tree), []);

    const c = lib.assignIds(page("Build failed"), b.idMap, b.nextId);
    assert.deepEqual(lib.diffTrees(b.tree, c.tree)[0].changes, { text: "Build failed" });
});

test("GitHub create-repository flow becomes readable events", () => {
    const url = "https://github.com/new";
    const s1 = lib.processSnapshot({ tabId: 7, url, title: "Create a New Repository", capturedAt: 1000, tree: createRepoPage() }, {});
    assert.deepEqual(s1.events.map(e => e.text), ['Opened "Create a New Repository" (github.com/new)']);
    assert.equal(s1.website, "github.com");

    const state1 = { url, tree: s1.tree, id_map: s1.idMap, next_id: s1.nextId };
    const s2 = lib.processSnapshot({
        tabId: 7, url, title: "Create a New Repository", capturedAt: 5000,
        tree: createRepoPage({ name: "personal-assistant", publicChecked: true }),
        interactions: [
            { at: 2000, kind: "change", target: { tag: "input", type: "text", label: "Repository name", value: "personal-assistant" } },
            { at: 3000, kind: "click", target: { tag: "input", type: "radio", label: "Public" } },
            { at: 3001, kind: "change", target: { tag: "input", type: "radio", label: "Public", checked: true } },
            { at: 4000, kind: "click", target: { tag: "button", type: "submit", text: "Create repository" } }
        ]
    }, state1);

    assert.deepEqual(s2.events.map(e => e.text), [
        'Entered "personal-assistant" into "Repository name"',
        'Selected "Public"',
        'Clicked button "Create repository"'
    ]);

    const state2 = { url, tree: s2.tree, id_map: s2.idMap, next_id: s2.nextId };
    const s3 = lib.processSnapshot({
        tabId: 7, url, title: "Create a New Repository", capturedAt: 6000,
        tree: createRepoPage({ name: "personal-assistant", publicChecked: true, alert: "Repository created successfully" })
    }, state2);
    assert.deepEqual(s3.events.map(e => e.text), ['Message appeared: "Repository created successfully"']);
});

test("masked inputs never expose values", () => {
    const events = lib.toEvents([], [
        { at: 1, kind: "change", target: { tag: "input", type: "password", label: "Password" } }
    ], { at: 1, url: "https://x.test/", prevUrl: "https://x.test/" }, new Map());
    assert.deepEqual(events.map(e => e.text), ['Filled in "Password"']);
});

test("navigation inside a tab is reported", () => {
    const page = t => el("body", {}, [el("h1", { text: t })]);
    const s1 = lib.processSnapshot({ tabId: 1, url: "https://app.test/a", title: "A", tree: page("A") }, {});
    const s2 = lib.processSnapshot(
        { tabId: 1, url: "https://app.test/b", title: "B", tree: page("B") },
        { url: s1.url, tree: s1.tree, id_map: s1.idMap, next_id: s1.nextId }
    );
    assert.equal(s2.events[0].text, 'Opened "B" (app.test/b)');
    assert.ok(s2.events.some(e => e.text === 'Section appeared: "B"'));
});

test("ingest Code node runs with n8n-style globals", () => {
    const out = runNode("nodes/ingest-snapshot.js", {
        input: [{ json: {} }],
        nodes: {
            "DOM Snapshot Webhook": [{ json: { body: { tabId: 3, url: "https://github.com/new", title: "New", tree: createRepoPage() } } }]
        }
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].json.tabId, "3");
    assert.equal(out[0].json.eventCount, 1);
    assert.equal(typeof out[0].json.tree, "string");
    assert.equal(JSON.parse(out[0].json.events)[0].kind, "navigation");
});

test("ingest Code node ignores invalid payloads", () => {
    const out = runNode("nodes/ingest-snapshot.js", {
        input: [{ json: {} }],
        nodes: { "DOM Snapshot Webhook": [{ json: { body: { url: "https://x.test" } } }] }
    });
    assert.deepEqual(out, []);
});
