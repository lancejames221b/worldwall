// World Wall wire aggregator.
// GET /api/feeds            -> the built-in outlet feeds, merged
// GET /api/feeds?u=<url>    -> one custom feed
// Returns { items: [{source, title, link, ts}], feeds: [{name, ok, count}] }
const DEFAULT_FEEDS = [
  ["Global News", "https://globalnews.ca/feed/"],
  ["CBC News", "https://www.cbc.ca/webfeed/rss/rss-topstories"],
  ["CTV News", "https://www.ctvnews.ca/arc/outboundfeeds/rss/?outputType=xml"],
  ["BBC News", "https://feeds.bbci.co.uk/news/rss.xml"],
  ["Sky News", "https://feeds.skynews.com/feeds/rss/home.xml"],
  ["Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["DW", "https://rss.dw.com/xml/rss-en-all"],
  ["France 24", "https://www.france24.com/en/live-news/rss"],
  ["ABC News", "https://feeds.abcnews.com/abcnews/topstories"],
  ["NBC News", "https://feeds.nbcnews.com/nbcnews/public/news"],
  ["Bloomberg", "https://feeds.bloomberg.com/markets/news.rss"],
  ["Euronews", "https://www.euronews.com/rss"],
  ["Channels Television", "https://www.channelstv.com/feed/"],
  ["NDTV", "https://feeds.feedburner.com/ndtvnews-top-stories"]
];

function dec(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? dec(m[1]) : "";
}
function linkOf(block) {
  let m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i) ||
          block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
          block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<link>([\s\S]*?)<\/link>/i);
  return m ? dec(m[1]) : "";
}
function dateOf(block) {
  const raw = tag(block, "pubDate") || tag(block, "dc:date") || tag(block, "published") || tag(block, "updated");
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : t;
}
function parseFeed(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 40)) {
    const title = tag(b, "title");
    const link = linkOf(b);
    if (!title || !link) continue;
    items.push({ source, title, link, ts: dateOf(b) });
  }
  return items;
}
async function fetchFeed(name, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (WorldWall/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" }
    });
    if (!r.ok) return { name, ok: false, count: 0, items: [] };
    const xml = await r.text();
    const items = parseFeed(xml, name);
    return { name, ok: items.length > 0, count: items.length, items };
  } catch (e) {
    return { name, ok: false, count: 0, items: [] };
  } finally {
    clearTimeout(timer);
  }
}
function hostName(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "Custom feed"; }
}

/* Surge detection: a term counts as a surge when three or more different
   outlets use it in recent headlines. Snapshot per invocation (no store):
   pool is items from the last two hours, or the 60 freshest as a fallback. */
const STOP = new Set(("the,and,for,with,after,over,amid,into,from,that,this,says,said,news,live,update,updates,watch,video,latest,first,could,will,would,about,more,than,then,they,them,been,were,what,when,where,which,while,under,between,against,before,during,being,have,its,their,our,your,are,was,not,but,all,can,out,who,how,why,days,year,years,still,also,other,world,global,report,reports,minister,government,home,today,tonight,back,just").split(","));
function computeSurges(items) {
  const fresh = items.filter(i => i.ts && Date.now() - i.ts < 2 * 60 * 60 * 1000);
  const pool = fresh.length >= 12 ? fresh : items.slice(0, 60);
  const byTerm = new Map();
  for (const i of pool) {
    const toks = new Set((i.title || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w)));
    for (const w of toks) {
      if (!byTerm.has(w)) byTerm.set(w, new Map());
      const m = byTerm.get(w);
      if (!m.has(i.source)) m.set(i.source, i);
    }
  }
  const out = [];
  for (const [term, m] of byTerm) {
    if (m.size >= 3) {
      const arr = [...m.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      out.push({ term, count: m.size, sources: [...m.keys()], firstSource: arr[arr.length - 1].source, headline: arr[0].title, firstHeadline: arr[arr.length - 1].title });
    }
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, 3);
}

module.exports = async (req, res) => {
  const u = req.query && req.query.u;
  let jobs;
  if (u) {
    if (!/^https?:\/\//i.test(u)) { res.status(400).json({ error: "bad url" }); return; }
    jobs = [fetchFeed(hostName(u), u)];
  } else {
    jobs = DEFAULT_FEEDS.map(([n, url]) => fetchFeed(n, url));
  }
  const results = await Promise.allSettled(jobs);
  const items = [];
  const feeds = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    feeds.push({ name: r.value.name, ok: r.value.ok, count: r.value.count });
    items.push(...r.value.items);
  }
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const surges = u ? [] : computeSurges(items);
  res.setHeader("Cache-Control", "s-maxage=240, stale-while-revalidate=120");
  res.status(200).json({ items: items.slice(0, 200), feeds, surges, generatedAt: Date.now() });
};
