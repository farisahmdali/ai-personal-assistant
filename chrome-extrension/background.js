const N8N_WEBHOOK_URL = "http://localhost:5678/webhook/dom-snapshot";

let activeTab = null;
let activeSince = null;

function now() {
    return Date.now();
}

async function recordActivity(activity) {
    const data = {
        ...activity,
        timestamp: now()
    };

    console.log("ACTIVITY:", data);

    const result = await chrome.storage.local.get("activities");

    const activities = result.activities || [];

    activities.push(data);

    await chrome.storage.local.set({
        activities
    });
}


// Tab became active
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);

    activeTab = tab.id;
    activeSince = now();

    recordActivity({
        type: "tab_activated",
        tabId: tab.id,
        url: tab.url || null,
        title: tab.title || null
    });
});


// Page navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
        recordActivity({
            type: "page_loaded",
            tabId,
            url: tab.url || null,
            title: tab.title || null
        });
    }
});


// Tab closed
chrome.tabs.onRemoved.addListener((tabId) => {
    recordActivity({
        type: "tab_closed",
        tabId
    });

    if (activeTab === tabId) {
        activeTab = null;
        activeSince = null;
    }
});


// Receive DOM snapshots from content.js and forward them to n8n.
// Sent from the service worker so page CSP / mixed-content rules
// on https sites don't block the localhost request.
async function sendToN8n(payload) {
    try {
        const res = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.warn("n8n responded", res.status, await res.text());
        }
    } catch (err) {
        console.warn("Could not reach n8n:", err.message);
    }
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "dom_snapshot" && sender.tab?.id != null) {
        sendToN8n({
            ...message,
            tabId: sender.tab.id,
            windowId: sender.tab.windowId
        });
    }
});