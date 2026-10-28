// World Wall wire aggregator.
// GET /api/feeds            -> the built-in outlet feeds, merged
// GET /api/feeds?u=<url>    -> one custom feed
// Returns { items: [{source, title, link, ts}], feeds: [{name, ok, count}] }
const dns = require("node:dns/promises");
const net = require("node:net");
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
function parseFeed(xml, source, base) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 40)) {
    const title = tag(b, "title");
    const rawLink = linkOf(b);
    if (!title || !rawLink) continue;
    /* F1: only http(s) links survive. A feed must never be able to hand
       the wall a javascript: or data: URL to render as a clickable link. */
    let link;
    try {
      const u = new URL(rawLink, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      link = u.href;
    } catch (e) { continue; }
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
    const items = parseFeed(xml, name, url);
    return { name, ok: items.length > 0, count: items.length, items };
  } catch (e) {
    return { name, ok: false, count: 0, items: [] };
  } finally {
    clearTimeout(timer);
  }
}
/* --- B1: SSRF guard for the ?u= custom-feed fetch -------------------------
   The built-in FEEDS above are trusted and keep the plain fetch. A custom
   ?u= URL is caller-controlled, so it goes through fetchFeedSafe instead:
   scheme check, DNS resolution with private / loopback / link-local /
   metadata ranges rejected, redirects followed manually with the FULL
   validation re-run on every hop, a streamed body cap, and an XML-ish
   content-type requirement.
   Residual risk, stated honestly: validation resolves DNS and then fetch
   resolves it again (TOCTOU), so a hostile authoritative DNS server could
   still rebind between the two lookups. Fully closing that needs
   connect-by-IP pinning, which would break TLS SNI and Host routing for
   ordinary feeds; this partial mitigation is accepted for this app. */
function ipBlocked(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;          // private, loopback, "this host"
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;          // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true;                      // 192.168.0.0/16
    if (p[0] === 169 && p[1] === 254) return true;                      // link-local / cloud metadata
    if (p[0] >= 224) return true;                                       // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;                         // unspecified, loopback
    if (s.startsWith("::ffff:")) {
      const v4 = s.slice(7);
      if (net.isIPv4(v4)) return ipBlocked(v4);                         // v4-mapped v6
    }
    const first = parseInt((s.split(":")[0] || "0"), 16);
    if (first >= 0xfe80 && first <= 0xfebf) return true;                // fe80::/10 link-local
    if (first >= 0xfc00 && first <= 0xfdff) return true;                // fc00::/7 unique local
    if (first >= 0xff00) return true;                                   // ff00::/8 multicast
    return false;
  }
  return true; // unparseable address: fail closed
}
async function validatePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (net.isIP(host)) return ipBlocked(host) ? null : u;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { return null; }
  if (!addrs.length) return null;
  for (const a of addrs) { if (ipBlocked(a.address)) return null; }
  return u;
}
async function readBodyCapped(r, cap) {
  if (!r.body || !r.body.getReader) {
    const txt = await r.text();
    return txt.length > cap ? null : txt;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch (e) {} return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder("utf-8").decode(buf);
}
async function fetchFeedSafe(name, startUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    let current = startUrl;
    for (let hop = 0; hop <= 3; hop++) {
      const u = await validatePublicUrl(current);
      if (!u) return { name, ok: false, count: 0, items: [], error: 400 };
      const r = await fetch(u.href, {
        signal: ctrl.signal, redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (WorldWall/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" }
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc || hop === 3) return { name, ok: false, count: 0, items: [], error: 400 };
        try { current = new URL(loc, u).href; } catch (e) { return { name, ok: false, count: 0, items: [], error: 400 }; }
        continue;
      }
      if (!r.ok) return { name, ok: false, count: 0, items: [] };
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!/xml|rss|atom|text\//.test(ct)) return { name, ok: false, count: 0, items: [], error: 415 };
      const xml = await readBodyCapped(r, 1.5 * 1024 * 1024);
      if (xml === null) return { name, ok: false, count: 0, items: [] };
      const items = parseFeed(xml, name, u.href);
      return { name, ok: items.length > 0, count: items.length, items };
    }
    return { name, ok: false, count: 0, items: [], error: 400 };
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
      /* F6: breadth alone is not a surge. Items from 4+ distinct outlets
         must also land inside some 30-minute window, so a term that merely
         recurs across a whole two hours of headlines stays off the bar. */
      const srcTs = [...m.values()].map(i => i.ts).filter(t => t).sort((a, b) => a - b);
      let tight = false;
      for (let a = 0; a < srcTs.length && !tight; a++) {
        let cnt = 0;
        for (let b = a; b < srcTs.length && srcTs[b] - srcTs[a] <= 30 * 60 * 1000; b++) cnt++;
        if (cnt >= 4) tight = true;
      }
      if (!tight) continue;
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
    jobs = [fetchFeedSafe(hostName(u), u)];
  } else {
    jobs = DEFAULT_FEEDS.map(([n, url]) => fetchFeed(n, url));
  }
  const results = await Promise.allSettled(jobs);
  if (u) {
    /* B1: a rejected custom feed is an HTTP error, not an empty feed, and
       the error body never carries DNS or address detail. */
    const r0 = results[0];
    const v = r0 && r0.status === "fulfilled" ? r0.value : null;
    if (!v || v.error) {
      const code = v && v.error ? v.error : 400;
      res.status(code).json({ error: code === 415 ? "unsupported content type" : "bad url" });
      return;
    }
  }
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
/* Exposed for the local validator scratch tests only; the route above
   remains the module's behaviour. */
module.exports._test = { ipBlocked, validatePublicUrl };
