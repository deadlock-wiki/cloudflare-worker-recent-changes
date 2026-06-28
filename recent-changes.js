const LIMIT = 4;
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const HTML_CACHE_KEY = "https://rc-cache.local/recentchanges.html";

export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);

            if (request.method === "GET" && url.pathname === "/api/recent-changes") {
                return handleRecentChanges(env);
            }

            return handleProxy(request, env, ctx);
        } catch (err) {
            return new Response("Worker error: " + (err?.stack || err?.message || String(err)), {
                status: 500,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
        }
    },
};

/* ------------------------------------------------------------
   MAIN (API endpoint)
------------------------------------------------------------ */
async function handleRecentChanges(env) {
    const innerHtml = await getOrBuildWidgetInnerHtml(env);
    if (!innerHtml) {
        return new Response("Unable to build recent changes widget", { status: 500 });
    }
    return new Response(
        `<ul class="vector-menu-content-list recent-changes-list">${innerHtml}</ul>`,
        {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
            },
        }
    );
}

/* ------------------------------------------------------------
    HTML REWRITE
------------------------------------------------------------ */
async function handleProxy(request, env, ctx) {
    const originResponse = await fetch(request);
    const contentType = originResponse.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
        return originResponse;
    }

    const widgetInnerHtml = await getOrBuildWidgetInnerHtml(env);
    if (!widgetInnerHtml) {
        return originResponse;
    }

    const rewriter = new HTMLRewriter()
        .on("#p-Recent_changes ul.vector-menu-content-list", {
            element(el) {
                el.setAttribute("class", "vector-menu-content-list recent-changes-list");
                el.setInnerContent(widgetInnerHtml, { html: true });
            },
        });

    return rewriter.transform(originResponse);
}

/* ------------------------------------------------------------
   GET OR BUILD WIDGET (5 min TTL)
------------------------------------------------------------ */
async function getOrBuildWidgetInnerHtml(env) {
    const cache = await caches.open("recent-changes-cache");
    const cacheKey = new Request(HTML_CACHE_KEY);

    const htmlCached = await cache.match(cacheKey);

    if (htmlCached) {
        const cachedAt = Number(htmlCached.headers.get("X-Cached-At") || 0);
        const age = Date.now() - cachedAt;

        if (cachedAt && age < TTL_MS) {
            return await htmlCached.text();
        }
    }

    if (!env.MEDIAWIKI_API) {
        return htmlCached ? await htmlCached.text() : null;
    }

    const apiUrl = buildApiUrl(env);

    const upstream = await fetch(apiUrl);

    if (!upstream.ok) {
        if (htmlCached) {
            return await htmlCached.text();
        }
        return null;
    }

    const data = await upstream.json();
    const now = Date.now();

    const innerHtml = renderWidgetItems(
        data?.query?.recentchanges ?? []
    );

    await cache.put(
        cacheKey,
        new Response(innerHtml, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "max-age=31536000",
                "X-Cached-At": String(now),
            },
        })
    );

    return innerHtml;
}

/* ------------------------------------------------------------
   MEDIAWIKI API
------------------------------------------------------------ */
function buildApiUrl(env) {
    const api = new URL(env.MEDIAWIKI_API);
    api.searchParams.set("action", "query");
    api.searchParams.set("list", "recentchanges");
    api.searchParams.set("rcprop", "title|timestamp|user|ids|flags");
    api.searchParams.set("rctype", "edit|new");
    api.searchParams.set("rcnamespace", "0");
    api.searchParams.set("rclimit", String(LIMIT));
    api.searchParams.set("format", "json");
    return api.toString();
}

/* ------------------------------------------------------------
   HTML RENDER
------------------------------------------------------------ */
function renderWidgetItems(items) {
    let html = "";
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const id = "n-change" + (i + 1);
        const title = String(item.title || "Unknown");
        const userName = String(item.user || "Unknown");
        const safeTitle = escapeHtml(title);
        const safeUserName = escapeHtml(userName);
        const timeText = escapeHtml(formatRelativeTime(item.timestamp));
        const titleUrl = escapeHtml(getPageUrl(title));
        const diffUrl = escapeHtml(getDiffUrl(item));
        const userUrl = item.user ? escapeHtml(getContributionsUrl(item.user)) : null;

        html += `<li class="mw-list-item recent-changes-item" id="${id}"><a class="recent-changes-title" href="${titleUrl}" title="${safeTitle}"><span>${safeTitle}</span></a><div class="recent-changes-meta"><a class="recent-changes-time" href="${diffUrl}" title="View diff for ${safeTitle}">${timeText}</a> · ${
            item.user
                ? `<a class="recent-changes-user" href="${userUrl}">${safeUserName}</a>`
                : `<span class="recent-changes-user">${safeUserName}</span>`
        }</div></li>`;
    }

    html += `<li class="mw-list-item recent-changes-item" id="n-change-more"><a class="recent-changes-title" href="/Special:RecentChanges"><span>Show more...</span></a></li>`;
    return html;
}

function getPageUrl(title) {
    return "/" + String(title || "").replace(/ /g, "_");
}

function getContributionsUrl(user) {
    return "/Special:Contributions/" + String(user || "").replace(/ /g, "_");
}

function getDiffUrl(item) {
    if (item && item.revid) {
        return "/Special:Diff/" + item.revid;
    }
    return "/Special:RecentChanges";
}

/* ------------------------------------------------------------
   RELATIVE TIME
------------------------------------------------------------ */
function formatRelativeTime(timestamp) {
    const then = new Date(timestamp).getTime();
    const now = Date.now();
    const diffSeconds = Math.round((now - then) / 1000);
    const abs = Math.abs(diffSeconds);
    let value;
    let short;

    if (abs < 60) {
        short = "s";
        value = diffSeconds;
    } else if (abs < 3600) {
        short = "m";
        value = Math.round(diffSeconds / 60);
    } else if (abs < 86400) {
        short = "h";
        value = Math.round(diffSeconds / 3600);
    } else {
        short = "d";
        value = Math.round(diffSeconds / 86400);
    }

    const n = Math.abs(value);
    return diffSeconds < 0 ? "in " + n + short : n + short + " ago";
}

/* ------------------------------------------------------------
   ESCAPE
------------------------------------------------------------ */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
