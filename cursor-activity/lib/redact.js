// Removes secrets from text before it leaves the editor: private keys, API
// tokens, credentials in URLs and values assigned to secret-looking names.
//
// Written as a plain script with a guarded export so the same file can be
// bundled into n8n Code nodes (see n8n/scripts/build-workflows.mjs).

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS = [
    // PEM private keys
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
    // OpenAI / OpenRouter / Anthropic style keys
    [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
    // GitHub tokens
    [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
    // Slack tokens
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
    // AWS access key ids
    [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
    // Google API keys
    [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
    // JWTs
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
    // Authorization headers
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=-]{12,}/g, "$1 " + REDACTED],
    // Credentials inside URLs: scheme://user:password@host
    [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+):([^\s@\/]+)@/gi, "$1:" + REDACTED + "@"]
];

const SECRET_NAME = "[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key|session[_-]?key)[A-Za-z0-9_.-]*";

// NAME = "value" | NAME: 'value' | NAME=value
const SECRET_ASSIGNMENT = new RegExp(
    "\\b(" + SECRET_NAME + ")(\\s*(?:[:=]|=>|:=)\\s*)(?:([\"'`])([^\"'`\\r\\n]*)\\3|([^\\s\"'`,;)\\]}]+))",
    "gi"
);

// An unquoted value only counts as a secret when it looks like one, so
// `password = getPassword()` or `token: string` stay readable.
function looksSecret(value) {
    return value.length >= 8 && /[0-9]/.test(value) && /^[A-Za-z0-9_\-+\/=.~]+$/.test(value);
}

function redact(text) {
    if (text == null) return text;
    let out = String(text);

    for (const [pattern, replacement] of SECRET_PATTERNS) {
        out = out.replace(pattern, replacement);
    }

    out = out.replace(SECRET_ASSIGNMENT, (match, name, sep, quote, quoted, bare) => {
        if (quote !== undefined) {
            return quoted.length ? `${name}${sep}${quote}${REDACTED}${quote}` : match;
        }
        return looksSecret(bare) ? `${name}${sep}${REDACTED}` : match;
    });

    return out;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { redact, REDACTED };
}
