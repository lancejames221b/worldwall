# World Wall

A live world news wall for one screen: verified live streams from around
60 countries, wire headlines underneath, and a surge bar that flags the
stories multiple outlets are breaking at once.

World Wall started as a personal command-centre wall and is now open
source. It is world-centric by design, not centred on any one country.

## What it does

- **92 stream tiles** from public broadcasters and private outlets
  worldwide, each labelled with its region and owner (for example
  "Germany · Public").
- **Verified playback.** Every preset stream was checked to actually
  play embedded. Outlets that block YouTube embeds are carried as direct
  HLS streams instead, with [hls.js](https://github.com/video-dev/hls.js)
  in the browser.
- **Live resolution.** Tiles do not hard-code a video. The resolver asks
  each channel for what is live right now and keeps a tile on its current
  stream while it stays live.
- **Surge detection.** Headlines from 14 RSS wire feeds are pooled over a
  rolling two-hour window. When three or more outlets use the same term,
  it surfaces in the surge bar; click through to the first report.
- **Paging.** 24 tiles per page on desktop, auto-rotating every 45
  seconds, with region "desk" scenes (All, Europe, Middle East, Africa,
  Asia-Pacific, Americas, Canada).
- **World clocks**, a focus mode for a single tile, Night Watch (dims
  and mutes overnight, a surge wakes the wall briefly), and a dead-air
  watchdog that flags stalled tiles and tries to recover them.
- **Yours to extend.** Add your own stream tiles and RSS feeds from the
  header; they are kept in your browser's local storage only.
- **Installable.** Ships as a PWA: add it to a home screen or install it
  as a standalone app. The service worker caches only the shell, never
  live data.

## Layout

```text
index.html       The whole wall: markup, styles, tile catalogue, player logic
api/feeds.js     Serverless function: merges the RSS wires, computes surges
                 GET /api/feeds          built-in feeds
                 GET /api/feeds?u=<url>  one custom feed
api/resolve.js   Serverless function: finds a channel's current live video
                 GET /api/resolve?c=<UC channel id | @handle>&cur=<videoId>&a=<expected author>
manifest.json    PWA manifest
sw.js            Service worker (shell cache only)
icons/           App icons from the World Wall mark
logo-mark.png    Header mark
logo-full.jpg    Full logo, used as the share image
```

There is no build step, no database, and no account system. The two
`api/` functions are plain Node handlers in the Vercel serverless format;
there are no environment variables and no secrets.

## Run it

On Vercel (the easy path):

1. Fork or clone this repo and import it as a Vercel project, or connect
   an existing Vercel project to the repo.
2. No build command, no output-directory override, no environment
   variables. Deploy.

Locally with the API functions working:

```bash
npm i -g vercel
vercel dev
```

A plain static server will serve the wall itself, but the `/api/` routes
need the serverless runtime, so tiles will not resolve new live videos
and the wire will not update without it.

## A note on streams

Stream URLs, channel IDs, and feed URLs in this repo are the public,
published endpoints of the outlets themselves. Availability changes:
broadcasters rotate live video IDs, move CDNs, and change embed policy.
The resolver and the direct-HLS fallbacks exist because of that churn.
If a tile goes dark, the fix is usually a fresh stream URL in the tile
catalogue at the top of `index.html`.

## Licence

MIT. See [LICENSE](LICENSE).
