// Compares two id-annotated trees (see stable-ids.js) and returns operations:
//   { op: "add",    parentId, element }
//   { op: "remove", elementId }
//   { op: "update", elementId, changes }
// Only top-most added/removed elements are reported. Text changes that only
// differ in numbers or relative times ("5 min ago") are treated as noise.

const MEANINGFUL_ATTRS = ["href", "aria-expanded", "aria-selected", "disabled", "open", "label", "placeholder", "role"];

const RELATIVE_TIME = /\b(just now|now|today|yesterday|\d+\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?)\s*ago)\b/gi;

function normalizeNoise(text) {
    return String(text || "").replace(RELATIVE_TIME, "~").replace(/\d+/g, "0");
}

function indexTree(tree) {
    const index = new Map();

    (function walk(node) {
        index.set(node.id, node);
        for (const child of node.children || []) {
            walk(child);
        }
    })(tree);

    return index;
}

function withoutParentIds(node) {
    const out = { ...node };
    delete out.parentId;
    if (node.children) {
        out.children = node.children.map(withoutParentIds);
    }
    return out;
}

function diffTrees(prev, cur) {
    if (!prev) {
        return [];
    }

    const before = indexTree(prev);
    const after = indexTree(cur);
    const ops = [];

    for (const [id, node] of after) {
        const old = before.get(id);

        if (!old) {
            if (!node.parentId || before.has(node.parentId)) {
                ops.push({ op: "add", parentId: node.parentId, element: withoutParentIds(node) });
            }
            continue;
        }

        const changes = {};

        if ((old.text || "") !== (node.text || "") && normalizeNoise(old.text) !== normalizeNoise(node.text)) {
            changes.text = node.text || "";
        }
        if (old.value !== node.value) {
            changes.value = node.value === undefined ? null : node.value;
        }
        if (!!old.checked !== !!node.checked) {
            changes.checked = !!node.checked;
        }
        if (old.selected !== node.selected) {
            changes.selected = node.selected === undefined ? null : node.selected;
        }

        const oldAttrs = old.attrs || {};
        const newAttrs = node.attrs || {};
        for (const attr of MEANINGFUL_ATTRS) {
            if (oldAttrs[attr] !== newAttrs[attr]) {
                changes.attrs = changes.attrs || {};
                changes.attrs[attr] = newAttrs[attr] === undefined ? null : newAttrs[attr];
            }
        }

        if (Object.keys(changes).length) {
            ops.push({ op: "update", elementId: id, changes });
        }
    }

    for (const [id, node] of before) {
        if (!after.has(id) && (!node.parentId || after.has(node.parentId))) {
            ops.push({ op: "remove", elementId: id });
        }
    }

    return ops;
}
