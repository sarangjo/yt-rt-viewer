# RT Archive Viewer

A local site that plays every upload from the **Rooster Teeth**, **Achievement Hunter** and
**Let's Play** YouTube channels as one timeline, oldest first.

## Run it

```bash
./start.sh
```

This opens http://localhost:8642. (It runs `python3 server.py`; YouTube embeds need a real
`http://` origin, so opening `index.html` as a file won't work.)

## Using it

- **Prev / Next** (or the `P` / `N` keys) step through videos one at a time in upload order.
  When a video ends, the next one starts automatically (you can turn that off).
- The **sidebar** lists every video in time order. Scroll it, search titles, or jump to a date.
  Click a video to play it. `C` scrolls back to the current video.
- **Filter chips** at the top hide a channel, or Shorts / live streams. Prev/Next skip
  hidden videos.
- Videos YouTube won't play in an embed (members-only, removed, embedding disabled) show a
  notice with a "Watch on YouTube" link and, by default, auto-skip after 5 seconds.

## Progress

Your place is saved every couple of seconds while a video plays, and when you close the tab:
the current video, the time within it, how far you got in every video you started, and which
ones you finished (watching past about 92% counts as finished).

It's stored in two places, and the newer copy wins when the page loads:

- the browser's `localStorage` for `http://localhost:8642`
- `data/progress.json`, written by `server.py`

The `⋯` menu exports or imports a progress backup file.

Browser storage is tied to the port, so if you run on a different `PORT`, progress still loads
from `data/progress.json`.

## Updating the video list

```bash
python3 scripts/build_data.py --refresh
```

This lists all three channels again with `yt-dlp` and looks up exact publish times for any new
videos. Times it already knows come from `data/details_cache.json`. It writes
`data/videos.json`.
