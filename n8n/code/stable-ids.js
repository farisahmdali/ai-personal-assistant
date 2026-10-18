// Gives every node of a semantic DOM tree a stable id (e_N) that survives
// across snapshots of the same tab, so changes can be expressed as
// add / remove / update operations on element ids.
//
// A node's signature is its parent's id + tag + its strongest identity
// (id, test id, name, aria-label, href, label or a hash of its text), plus an
// occurrence index among same-signature siblings. Signatures seen in the
// previous snapshot map back to the same id.

const GENERATED_ID = /\d{4,}|^:r|^[a-f0-9-]{12,}$/i;

function strHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function nodeIdentity(node, depth = 0) {
    const a = node.attrs || {};

    if (a.id && !GENERATED_ID.test(a.id)) return "#" + a.id;
    if (a["data-testid"]) return "t:" + a["data-testid"];
    if (a.name) return "n:" + a.name;
    if (a["aria-label"]) return "l:" + a["aria-label"];
    if (a.href) return "h:" + a.href;
    if (a.label) return "L:" + a.label;
    if (node.text) return "x:" + strHash(node.text);

    // Containers without identity take it from their first child, which stays
    // the same when content is appended (chats, feeds, lists).
    if (node.children && node.children.length && depth < 3) {
        const first = nodeIdentity(node.children[0], depth + 1);
        if (first) return "c:" + first;
    }

    return "";
}

function copyFields(from, to) {
    for (const key of ["text", "attrs", "value", "checked", "selected"]) {
        if (from[key] !== undefined) {
            to[key] = from[key];
        }
    }
    return to;
}

function assignIds(tree, idMap, nextId) {
    const oldMap = idMap || {};
    const newMap = {};
    let counter = nextId || 1;

    function idFor(signature) {
        const id = oldMap[signature] || "e_" + counter++;
        newMap[signature] = id;
        return id;
    }

    function visitChildren(children, parentId) {
        const seen = {};

        return children.map(child => {
            const base = `${parentId}>${child.tag}:${nodeIdentity(child)}`;
            const n = (seen[base] = (seen[base] || 0) + 1);
            const id = idFor(n > 1 ? `${base}#${n}` : base);

            const out = copyFields(child, { id, parentId, tag: child.tag });
            if (child.children && child.children.length) {
                out.children = visitChildren(child.children, id);
            }
            return out;
        });
    }

    const rootId = idFor("root:" + tree.tag);
    const root = copyFields(tree, { id: rootId, parentId: null, tag: tree.tag });
    if (tree.children && tree.children.length) {
        root.children = visitChildren(tree.children, rootId);
    }

    return { tree: root, idMap: newMap, nextId: counter };
}
