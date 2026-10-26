// World Wall live-stream resolver, v2 (strict).
// GET /api/resolve?c=<UC channel id | @handle>&cur=<current videoId>&a=<expected author>
// Reads the channel's OWN /streams page and picks among videos that carry a
// LIVE badge there. Ownership is guaranteed by construction (a channel's
// streams page lists only its own videos). When the client's current video
// is among the live ones it is kept (stability); otherwise the live video
// with the most watchers wins. Optionally verifies the pick with oEmbed:
// the author must loosely match ?a= or the pick is rejected.
function parseWatching(s) {
  if (!s) return 0;
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*([KM])?/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] === "K") n *= 1000;
  if (m[2] === "M") n *= 1000000;
  return Math.round(n);
}
function liveCandidates(html) {
  // Segment the page into per-video lockups; a lockup's LIVE badge can sit
  // before its videoId field, so fixed windows around the id are unreliable.
  const starts = [];
  const lre = /"lockupViewModel":\{/g;
  let lm;
  while ((lm = lre.exec(html)) !== null) starts.push(lm.index);
  const segments = [];
  if (starts.length) {
    for (let i = 0; i < starts.length; i++) {
      segments.push(html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : starts[i] + 20000));
    }
  } else {
    const re = /"videoId":"([A-Za-z0-9_-]{11})"/g;
    let m;
    while ((m = re.exec(html)) !== null) segments.push(html.slice(Math.max(0, m.index - 3500), m.index + 9000));
  }
  const out = [];
  const seen = new Set();
  for (const seg of segments) {
    const vm = seg.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    if (!vm || seen.has(vm[1])) continue;
    seen.add(vm[1]);
    if (!seg.includes("THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE")) continue;
    const t = seg.match(/"title":\{"content":"([^"]{1,120})"/);
    const w = seg.match(/"content":"([\d.,KM]+) watching"/);
    out.push({ videoId: vm[1], title: t ? t[1] : "", watching: parseWatching(w ? w[1] : "") });
    if (out.length >= 6) break;
  }
  return out;
}
function parseScheduled(s) {
  if (!s) return Infinity;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return Infinity;
  let [, mo, d, y, h, mi, ap] = m;
  y = Number(y); if (y < 100) y += 2000;
  h = Number(h) % 12; if (/pm/i.test(ap)) h += 12;
  return Date.UTC(y, Number(mo) - 1, Number(d), h, Number(mi));
}
function upcomingCandidate(html) {
  // Scheduled events carry a badge with text "Upcoming" whose
  // animationActivationTargetId is the event's video ID, plus a
  // "Scheduled for M/D/YY, h:mm PM" line in the same lockup.
  // A channel can list several; the soonest is the one the wall wants.
  const re = /"text":"Upcoming","badgeStyle":"[^"]*","animationActivationTargetId":"([A-Za-z0-9_-]{11})"/g;
  const found = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const seg = html.slice(m.index, m.index + 14000);
    const t = seg.match(/"title":\{"content":"([^"]{1,120})"/);
    if (!t || /queue|Save to playlist/i.test(t[1])) continue;
    const s = seg.match(/"content":"(Scheduled for [^"]{1,40})"/);
    found.push({ videoId: m[1], title: t[1], scheduled: s ? s[1] : "", when: parseScheduled(s ? s[1] : "") });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.when - b.when);
  const f = found[0];
  return { videoId: f.videoId, title: f.title, scheduled: f.scheduled };
}
function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
async function fetchText(url, ctrl) {
  const r = await fetch(url, {
    signal: ctrl.signal,
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  return r.text();
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const c = q.c || "";
  const cur = /^([A-Za-z0-9_-]{11})$/.test(q.cur || "") ? q.cur : null;
  const expectAuthor = q.a || "";
  const isChannel = /^UC[A-Za-z0-9_-]{22}$/.test(c);
  const isHandle = /^@[A-Za-z0-9_.-]{3,}$/.test(c);
  if (!isChannel && !isHandle) { res.status(400).json({ error: "bad channel" }); return; }
  const base = isChannel ? "channel/" + c : c;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const html = await fetchText("https://www.youtube.com/" + base + "/streams", ctrl);
    const cm = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
    const channelId = isChannel ? c : (cm ? cm[1] : null);
    const live = liveCandidates(html);
    if (!live.length) {
      const upcoming = upcomingCandidate(html);
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
      res.status(200).json({ channelId, videoId: null, isLive: false, liveCount: 0, upcoming });
      return;
    }
    let pick = cur ? live.find(v => v.videoId === cur) : null;
    if (!pick) pick = live.slice().sort((a, b) => b.watching - a.watching)[0];
    if (expectAuthor) {
      try {
        const oe = await fetchText("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=" + pick.videoId + "&format=json", ctrl);
        const author = (JSON.parse(oe).author_name || "");
        const na = norm(author), ne = norm(expectAuthor);
        if (!na || !(na.includes(ne) || ne.includes(na))) {
          res.setHeader("Cache-Control", "s-maxage=120");
          res.status(200).json({ channelId, videoId: null, isLive: false, rejected: "author mismatch", author });
          return;
        }
      } catch (e) { /* oEmbed unavailable: streams-page ownership still applies */ }
    }
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    res.status(200).json({ channelId, videoId: pick.videoId, isLive: true, title: pick.title, watching: pick.watching, liveCount: live.length, kept: pick.videoId === cur });
  } catch (e) {
    res.status(200).json({ channelId: isChannel ? c : null, videoId: null, isLive: false, error: "resolve failed" });
  } finally {
    clearTimeout(timer);
  }
};
