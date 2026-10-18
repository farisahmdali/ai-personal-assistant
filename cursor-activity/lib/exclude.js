// Glob-based exclusion of sensitive or generated files.
// Patterns without "/" match the file name; others match the path relative to
// the project root. Supports **, * and ?.

function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                const slash = glob[i + 2] === "/";
                re += slash ? "(?:.*/)?" : ".*";
                i += slash ? 2 : 1;
            } else {
                re += "[^/]*";
            }
        } else if (c === "?") {
            re += "[^/]";
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp("^" + re + "$", "i");
}

function createExcluder(globs) {
    const rules = globs.map(g => ({ byName: !g.includes("/"), re: globToRegExp(g) }));

    return function isExcluded(relativePath) {
        if (!relativePath) return false;
        const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
        const name = rel.split("/").pop();
        return rules.some(r => r.re.test(r.byName ? name : rel)) ||
            // "**/x/**" should also match "x/..." at the root
            rules.some(r => !r.byName && r.re.test("/" + rel));
    };
}

module.exports = { createExcluder, globToRegExp };
