// Accumulates edits per document and turns them into one `edit_summary` per
// burst of work instead of one event per keystroke.
//
// A burst is flushed on save, when the user switches editor, after `quietMs`
// without changes, or after `maxMs` of continuous editing. A flush with no net
// change (typed then undone) produces nothing, and a save without edits since
// the last flush produces nothing, so repeated saves never duplicate events.

const { lineDiff } = require("./diff");
const { redact } = require("./redact");

class EditAggregator {
    constructor(options = {}) {
        this.quietMs = options.quietMs || 30000;
        this.maxMs = options.maxMs || 300000;
        this.maxTrackedChars = options.maxTrackedChars || 1000000;
        this.files = new Map();
    }

    // Remember the current text as the baseline (document opened / focused).
    track(key, text) {
        if (text.length > this.maxTrackedChars) {
            this.files.delete(key);
            return false;
        }
        const state = this.files.get(key);
        if (!state || !state.dirty) {
            this.files.set(key, { baseline: text, dirty: false, changes: 0, undoRedo: 0, firstChangeAt: 0, lastChangeAt: 0 });
        }
        return true;
    }

    isTracked(key) {
        return this.files.has(key);
    }

    untrack(key) {
        this.files.delete(key);
    }

    change(key, { now = Date.now(), undoRedo = false, count = 1 } = {}) {
        const state = this.files.get(key);
        if (!state) return false;
        if (!state.dirty) {
            state.dirty = true;
            state.firstChangeAt = now;
        }
        state.lastChangeAt = now;
        state.changes += count;
        if (undoRedo) state.undoRedo += count;
        return true;
    }

    isDirty(key) {
        const state = this.files.get(key);
        return !!(state && state.dirty);
    }

    due(now = Date.now()) {
        const keys = [];
        for (const [key, s] of this.files) {
            if (s.dirty && (now - s.lastChangeAt >= this.quietMs || now - s.firstChangeAt >= this.maxMs)) {
                keys.push(key);
            }
        }
        return keys;
    }

    dirtyKeys() {
        return [...this.files].filter(([, s]) => s.dirty).map(([k]) => k);
    }

    // Returns the edit summary data, or null if there is nothing to report.
    flush(key, currentText, { reason = "quiet", includeDiff = true } = {}) {
        const state = this.files.get(key);
        if (!state || !state.dirty) return null;

        const diff = lineDiff(state.baseline, currentText);
        const summary = diff && {
            reason,
            firstChangeAt: new Date(state.firstChangeAt).toISOString(),
            lastChangeAt: new Date(state.lastChangeAt).toISOString(),
            changeCount: state.changes,
            undoRedoCount: state.undoRedo,
            startLine: diff.startLine,
            linesAdded: diff.linesAdded,
            linesRemoved: diff.linesRemoved,
            diff: includeDiff ? redact(diff.hunk) : undefined,
            diffTruncated: diff.truncated
        };

        this.files.set(key, { baseline: currentText, dirty: false, changes: 0, undoRedo: 0, firstChangeAt: 0, lastChangeAt: 0 });
        return summary || null;
    }
}

module.exports = { EditAggregator };
