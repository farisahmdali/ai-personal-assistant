import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "../scripts/build-workflows.mjs";

const codeDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "code");

// Loads plain (non-module) code files the way n8n sees them and returns the
// named top-level functions.
export function load(files, names) {
    const source = files.map(f => readFileSync(join(codeDir, f), "utf8")).join("\n");
    return new Function(`${source}\nreturn { ${names.join(", ")} };`)();
}

// Runs a bundled Code-node file with stubbed n8n globals.
export function runNode(file, { input = [], nodes = {} }) {
    const code = bundle(join(codeDir, file));
    const $input = { all: () => input, first: () => input[0] };
    const $ = name => ({
        first: () => nodes[name][0],
        all: () => nodes[name],
        itemMatching: i => nodes[name][i]
    });
    return new Function("$", "$input", code)($, $input);
}

// Tiny tree builder: el("button", { text: "Go" }, [children])
export function el(tag, fields = {}, children) {
    const node = { tag, ...fields };
    if (children) node.children = children;
    return node;
}
