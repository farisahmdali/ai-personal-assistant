// Line diff between the last reported version of a document and the current
// one. The changed region is found by trimming common leading/trailing lines,
// then diffed with an LCS when small enough. Output is one capped hunk.

const MAX_LCS_CELLS = 250000;

function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push([" ", a[i]]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["-", a[i]]); i++; }
        else { ops.push(["+", b[j]]); j++; }
    }
    while (i < n) ops.push(["-", a[i++]]);
    while (j < m) ops.push(["+", b[j++]]);
    return ops;
}

function lineDiff(before, after, options = {}) {
    const maxLines = options.maxLines || 80;
    const context = options.context === undefined ? 2 : options.context;

    const a = String(before).split(/\r?\n/);
    const b = String(after).split(/\r?\n/);

    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;

    let endA = a.length - 1;
    let endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

    const removedRegion = a.slice(start, endA + 1);
    const addedRegion = b.slice(start, endB + 1);
    if (!removedRegion.length && !addedRegion.length) return null;

    let ops;
    if (removedRegion.length * addedRegion.length <= MAX_LCS_CELLS) {
        ops = lcsOps(removedRegion, addedRegion);
    } else {
        ops = removedRegion.map(l => ["-", l]).concat(addedRegion.map(l => ["+", l]));
    }

    const linesAdded = ops.filter(o => o[0] === "+").length;
    const linesRemoved = ops.filter(o => o[0] === "-").length;
    if (!linesAdded && !linesRemoved) return null;

    // Keep changed lines plus `context` unchanged lines around them.
    const keep = new Array(ops.length).fill(false);
    ops.forEach((op, k) => {
        if (op[0] !== " ") {
            for (let d = -context; d <= context; d++) {
                if (ops[k + d]) keep[k + d] = true;
            }
        }
    });

    const lines = [];
    for (let k = Math.max(0, start - context); k < start; k++) lines.push(" " + a[k]);
    let skipped = false;
    ops.forEach((op, k) => {
        if (keep[k]) {
            lines.push(op[0] + op[1]);
            skipped = false;
        } else if (!skipped) {
            lines.push("…");
            skipped = true;
        }
    });
    for (let k = endB + 1; k < Math.min(b.length, endB + 1 + context); k++) lines.push(" " + b[k]);

    const truncated = lines.length > maxLines;
    const hunkLines = truncated ? lines.slice(0, maxLines).concat(`… (${lines.length - maxLines} more lines)`) : lines;

    return {
        startLine: start + 1,
        linesAdded,
        linesRemoved,
        hunk: hunkLines.map(l => (l.length > 300 ? l.slice(0, 299) + "…" : l)).join("\n"),
        truncated
    };
}

// Added/removed line counts between two snippets (used for agent edits).
function countLineChanges(oldText, newText) {
    const a = oldText ? String(oldText).split(/\r?\n/) : [];
    const b = newText ? String(newText).split(/\r?\n/) : [];
    const counts = new Map();
    for (const line of a) counts.set(line, (counts.get(line) || 0) + 1);

    let common = 0;
    for (const line of b) {
        const c = counts.get(line);
        if (c) { common++; counts.set(line, c - 1); }
    }
    return { linesAdded: b.length - common, linesRemoved: a.length - common };
}

module.exports = { lineDiff, countLineChanges };
