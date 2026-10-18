// Works out which project a file belongs to: the nearest git repository root,
// falling back to the containing workspace folder. Project roots are
// normalised ("c:/users/hp/code/app") so all collectors agree on them.

const fs = require("node:fs");
const path = require("node:path");

const gitRootCache = new Map();

function normalizeRoot(p) {
    if (!p) return null;
    let out = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
}

function findGitRoot(startDir) {
    if (gitRootCache.has(startDir)) return gitRootCache.get(startDir);

    let dir = startDir;
    let found = null;
    for (let i = 0; i < 40 && dir; i++) {
        if (fs.existsSync(path.join(dir, ".git"))) {
            found = dir;
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    gitRootCache.set(startDir, found);
    return found;
}

function isInside(file, folder) {
    const rel = path.relative(folder, file);
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

// filePath: absolute path of a file or directory
// workspaceFolders: absolute folder paths open in the editor
function resolveProject(filePath, workspaceFolders = []) {
    if (!filePath) return null;

    const folder = workspaceFolders
        .filter(f => isInside(filePath, f))
        .sort((a, b) => b.length - a.length)[0];

    let stat = null;
    try { stat = fs.statSync(filePath); } catch {}
    const startDir = stat && stat.isDirectory() ? filePath : path.dirname(filePath);

    const gitRoot = findGitRoot(startDir);
    // A git root above the workspace folder (e.g. home dir repo) is too broad.
    const root = gitRoot && (!folder || isInside(gitRoot, folder) || gitRoot === folder) ? gitRoot : (folder || gitRoot);
    if (!root) return null;

    const normalized = normalizeRoot(root);
    return {
        root: normalized,
        name: path.basename(root),
        relativePath: path.relative(root, filePath).replace(/\\/g, "/") || "."
    };
}

module.exports = { resolveProject, normalizeRoot, findGitRoot };
