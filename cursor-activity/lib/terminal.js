// Extracts what matters from terminal output: the tail, error lines and test
// results. Output is redacted before it is stored.

const { redact } = require("./redact");

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
const ERROR_LINE = /\b(error|errors|failed|failure|exception|traceback|panicked|fatal|cannot find|not found|undefined is not)\b|\b\w+(Error|Exception)\b|✖|✗|^\s*FAIL\b/i;

function stripAnsi(text) {
    return String(text || "").replace(ANSI, "").replace(/\r(?!\n)/g, "\n");
}

function tail(text, lines) {
    const all = stripAnsi(text).split(/\r?\n/).filter(l => l.trim());
    return all.slice(-lines).join("\n");
}

function errorLines(text, max = 10) {
    return stripAnsi(text)
        .split(/\r?\n/)
        .filter(l => ERROR_LINE.test(l))
        .slice(0, max)
        .map(l => redact(l.trim().slice(0, 300)));
}

// Understands the summary lines of common runners (node:test, jest, vitest,
// mocha, pytest, cargo, go).
function parseTests(text) {
    const out = stripAnsi(text);
    const num = re => {
        const m = out.match(re);
        return m ? Number(m[1]) : null;
    };

    const passed =
        num(/ℹ pass (\d+)/) ?? num(/Tests:.*?(\d+) passed/) ?? num(/(\d+) passed/) ??
        num(/(\d+) passing/) ?? num(/test result: \w+\. (\d+) passed/);
    const failed =
        num(/ℹ fail (\d+)/) ?? num(/Tests:.*?(\d+) failed/) ?? num(/(\d+) failed/) ??
        num(/(\d+) failing/) ?? num(/test result: \w+\. \d+ passed; (\d+) failed/);

    const goFail = /^--- FAIL/m.test(out) || /^FAIL\s/m.test(out);
    const goOk = /^ok\s+\S+/m.test(out);

    if (passed === null && failed === null && !goFail && !goOk) return null;
    return {
        passed: passed ?? (goOk ? 1 : 0),
        failed: failed ?? (goFail ? 1 : 0)
    };
}

function summarizeOutput(text, tailLines = 40) {
    return {
        outputTail: redact(tail(text, tailLines)),
        errorLines: errorLines(text),
        tests: parseTests(text)
    };
}

module.exports = { stripAnsi, tail, errorLines, parseTests, summarizeOutput };
