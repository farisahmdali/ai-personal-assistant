const { parseHTML } = require("linkedom");

function htmlToJson(html) {
    const { document } = parseHTML(html);

    function parseNode(node) {
        if (node.nodeType === 3) {
            const text = node.textContent.trim();

            return text
                ? {
                    type: "text",
                    content: text
                }
                : null;
        }

        if (node.nodeType !== 1) {
            return null;
        }

        const result = {
            type: "element",
            tag: node.tagName.toLowerCase(),
            attributes: {},
            children: []
        };

        for (const attr of node.attributes) {
            result.attributes[attr.name] = attr.value;
        }

        for (const child of node.childNodes) {
            const parsed = parseNode(child);

            if (parsed) {
                result.children.push(parsed);
            }
        }

        return result;
    }

    return parseNode(document.documentElement);
}

export default htmlToJson