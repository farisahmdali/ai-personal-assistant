// Processes one DOM snapshot from the extension against the tab's previous
// state: assign stable ids, diff, and derive activity events.
// Requires stable-ids.js, diff.js and events.js.
//
// body: { tabId, url, title, capturedAt, tree, interactions }
// prev: row from tmp_tab_state ({ url, tree, id_map, next_id }) or {}

function processSnapshot(body, prev) {
    const prevState = prev && prev.tree ? prev : null;
    const at = new Date(body.capturedAt || Date.now()).toISOString();

    const assigned = assignIds(body.tree, prevState && prevState.id_map, prevState && prevState.next_id);
    const ops = diffTrees(prevState ? prevState.tree : null, assigned.tree);

    const events = toEvents(
        ops,
        body.interactions || [],
        {
            at,
            url: body.url,
            prevUrl: prevState ? prevState.url : null,
            title: body.title,
            isFirst: !prevState
        },
        indexTree(assigned.tree)
    );

    let website = "unknown";
    try {
        website = new URL(body.url).hostname || "unknown";
    } catch {}

    return {
        tabId: String(body.tabId),
        url: body.url,
        title: body.title || "",
        website,
        tree: assigned.tree,
        idMap: assigned.idMap,
        nextId: assigned.nextId,
        ops,
        events
    };
}
