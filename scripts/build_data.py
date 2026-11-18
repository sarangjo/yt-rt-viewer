#!/usr/bin/env python3
"""Build data/videos.json: every upload from the Rooster Teeth, Achievement Hunter
and Let's Play YouTube channels, merged and sorted oldest-first by exact publish time.

Steps:
  1. List every video on each channel's Videos / Shorts / Live tabs (yt-dlp --flat-playlist).
  2. Look up the exact publish time of each video, cached in data/details_cache.json so
     re-runs only look up videos they don't know yet.
       - With YOUTUBE_API_KEY set: YouTube Data API, 50 videos per request (about a minute).
       - Without a key: one lightweight request per video, throttled to stay under
         YouTube's bot check. Takes about an hour the first time; safe to stop and resume.
  3. Write the merged, sorted list to data/videos.json. Videos whose date isn't known yet
     get one estimated from their neighbours in the channel's own (date-ordered) list, so the
     site works while the lookup is still running.

Usage:
  python3 scripts/build_data.py              # build / resume
  python3 scripts/build_data.py --refresh    # re-list channels to pick up new uploads
  python3 scripts/build_data.py --rate 2     # lookups per second without an API key
  python3 scripts/build_data.py --no-fetch   # just rebuild videos.json from the cache
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE_FILE = DATA / "details_cache.json"
OUT_FILE = DATA / "videos.json"

CHANNELS = [
    # key, handle, display name
    ("RT", "RoosterTeeth", "Rooster Teeth"),
    ("AH", "AchievementHunter", "Achievement Hunter"),
    ("LP", "LetsPlay", "Let's Play"),
]
TABS = [("videos", "video"), ("shorts", "short"), ("streams", "stream")]

PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
CLIENT = {"clientName": "WEB", "clientVersion": "2.20251101.00.00", "hl": "en", "gl": "US"}
API_URL = "https://www.googleapis.com/youtube/v3/videos"


class BotCheck(Exception):
    """YouTube answered 'Sign in to confirm you're not a bot': slow down."""


# ---------------------------------------------------------------- listing
def list_tab(handle: str, tab: str, refresh: bool) -> list[dict]:
    raw = DATA / f"raw_{handle}_{tab}.json"
    if refresh or not raw.exists() or raw.stat().st_size == 0:
        print(f"  listing @{handle}/{tab} ...", flush=True)
        res = subprocess.run(
            ["yt-dlp", "--no-update", "--flat-playlist", "-J", f"https://www.youtube.com/@{handle}/{tab}"],
            capture_output=True, text=True,
        )
        if res.returncode != 0 or not res.stdout.strip():
            # A channel without e.g. a Shorts tab makes yt-dlp fail; treat as empty.
            print(f"    (no entries: {res.stderr.strip().splitlines()[-1:] or ''})")
            raw.write_text('{"entries": []}')
        else:
            raw.write_text(res.stdout)
    data = json.loads(raw.read_text())
    return [e for e in (data.get("entries") or []) if e and e.get("id")]


# ---------------------------------------------------------------- date lookups
def fetch_player(video_id: str) -> dict:
    body = json.dumps({"context": {"client": CLIENT}, "videoId": video_id}).encode()
    req = urllib.request.Request(PLAYER_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    ps = d.get("playabilityStatus") or {}
    reason = ps.get("reason") or ""
    if "not a bot" in reason:
        raise BotCheck(reason)
    mf = (d.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    vd = d.get("videoDetails") or {}
    return {
        "published": mf.get("publishDate") or mf.get("uploadDate"),
        "status": ps.get("status"),
        "reason": reason or None,
        "length": int(mf.get("lengthSeconds") or vd.get("lengthSeconds") or 0) or None,
    }


def fetch_with_player(todo: list[str], cache: dict, rate: float, save, checkpoint=None) -> None:
    """Sequential, throttled lookups. Backs off when YouTube shows its bot check."""
    delay = 1.0 / rate
    cooldown = 120
    ok_since_pause = 0
    start = time.time()
    done = 0
    i = 0
    while i < len(todo):
        vid = todo[i]
        t0 = time.time()
        try:
            cache[vid] = fetch_player(vid)
        except BotCheck:
            save()
            if ok_since_pause:  # we were going too fast: slow down (still blocked: just wait)
                delay = min(delay * 1.5, 10.0)
            ok_since_pause = 0
            print(f"  YouTube bot check after {done} lookups; pausing {cooldown // 60} min, "
                  f"then continuing at {1 / delay:.2f}/s", flush=True)
            time.sleep(cooldown)
            start += cooldown  # keep the rate / ETA estimate about active time only
            cooldown = min(cooldown * 2, 1800)
            continue  # retry the same video
        except Exception as exc:  # network hiccup: short pause, retry a few times
            cache.setdefault(vid, {})
            tries = cache[vid].get("tries", 0) + 1
            if tries >= 3:
                cache[vid] = {"error": str(exc)}
                i += 1
            else:
                cache[vid] = {"tries": tries}
            time.sleep(5)
            continue
        cooldown = 120
        ok_since_pause += 1
        done += 1
        i += 1
        if done % 100 == 0 or i == len(todo):
            save()
            if checkpoint and done % 500 == 0:
                checkpoint()
            rate_now = done / max(time.time() - start, 1e-6)
            left = (len(todo) - i) / max(rate_now, 1e-6)
            print(f"  {i}/{len(todo)}  ({rate_now:.1f}/s, ~{left / 60:.0f} min left)", flush=True)
        time.sleep(max(0.0, delay - (time.time() - t0)))
    save()


def fetch_with_api(todo: list[str], cache: dict, key: str, save) -> None:
    for n in range(0, len(todo), 50):
        batch = todo[n:n + 50]
        qs = urllib.parse.urlencode({"part": "snippet,contentDetails", "id": ",".join(batch), "key": key})
        try:
            with urllib.request.urlopen(f"{API_URL}?{qs}", timeout=30) as r:
                d = json.load(r)
        except urllib.error.HTTPError as exc:
            save()
            try:
                msg = json.load(exc).get("error", {}).get("message", "")
            except Exception:
                msg = ""
            sys.exit(f"YouTube Data API error {exc.code}: {msg or exc.reason}\n"
                     "Check that the key is valid and the YouTube Data API v3 is enabled for its project.")
        found = {}
        for item in d.get("items", []):
            found[item["id"]] = {"published": item["snippet"]["publishedAt"], "status": "OK", "reason": None,
                                 "length": iso_duration(item.get("contentDetails", {}).get("duration"))}
        for vid in batch:
            # Not returned by the API = private or deleted.
            cache[vid] = found.get(vid) or {"published": None, "status": "MISSING", "reason": "private or deleted"}
        if (n // 50) % 20 == 0:
            save()
            print(f"  {min(n + 50, len(todo))}/{len(todo)}", flush=True)
    save()


def iso_duration(s: str | None) -> int | None:
    if not s or not s.startswith("PT"):
        return None
    total, num = 0, ""
    for ch in s[2:]:
        if ch.isdigit():
            num += ch
        else:
            total += int(num or 0) * {"H": 3600, "M": 60, "S": 1}.get(ch, 0)
            num = ""
    return total or None


def to_ts(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-list channel tabs to pick up new uploads")
    ap.add_argument("--rate", type=float, default=3.0, help="lookups/second when no API key is set (default 3)")
    ap.add_argument("--no-fetch", action="store_true", help="skip lookups, just rebuild videos.json")
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)

    # 1. Channel listings. Each tab is newest-first; keep the order for date estimates.
    print("Listing channels")
    videos: dict[str, dict] = {}
    tab_orders: list[list[str]] = []
    for key, handle, _ in CHANNELS:
        for tab, vtype in TABS:
            entries = list_tab(handle, tab, args.refresh)
            print(f"  @{handle}/{tab}: {len(entries)}")
            order = []
            for e in entries:
                vid = e["id"]
                order.append(vid)
                if vid not in videos:
                    videos[vid] = {"id": vid, "title": e.get("title") or "",
                                   "dur": int(e["duration"]) if e.get("duration") else None,
                                   "ch": key, "type": vtype}
            tab_orders.append(order)
    print(f"Total unique videos: {len(videos)}")

    # 2. Exact publish dates (cached).
    cache: dict[str, dict] = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}
    # Drop entries from earlier runs that only recorded a bot check or an error.
    for vid in [v for v, d in cache.items() if "error" in d or "tries" in d or "not a bot" in (d.get("reason") or "")]:
        del cache[vid]

    def save():
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(CACHE_FILE)

    todo = [vid for vid in videos if vid not in cache]
    if todo and not args.no_fetch:
        api_key = os.environ.get("YOUTUBE_API_KEY")
        if api_key:
            print(f"Looking up {len(todo)} publish dates with the YouTube Data API")
            fetch_with_api(todo, cache, api_key, save)
        else:
            print(f"Looking up {len(todo)} publish dates at {args.rate}/s "
                  f"(~{len(todo) / args.rate / 60:.0f} min; {len(videos) - len(todo)} already cached). "
                  f"Set YOUTUBE_API_KEY to do this in about a minute.", flush=True)
            # Write a usable videos.json right away; it improves as dates arrive.
            write_output(videos, tab_orders, cache)
            checkpoint = lambda: write_output(videos, tab_orders, cache)
            try:
                # Pass 1: every 25th video of each channel, so estimates are close everywhere.
                todo_set = set(todo)
                sample = [vid for order in tab_orders for n, vid in enumerate(reversed(order))
                          if n % 25 == 0 and vid in todo_set]
                sample = list(dict.fromkeys(sample))
                if sample:
                    print(f"Pass 1: {len(sample)} sample lookups", flush=True)
                    fetch_with_player(sample, cache, args.rate, save)
                    write_output(videos, tab_orders, cache)
                # Pass 2: everything else, oldest first (where watching starts).
                rest = sorted((vid for vid in todo if vid not in cache), key=lambda vid: videos[vid]["ts"])
                print(f"Pass 2: {len(rest)} lookups, oldest first", flush=True)
                fetch_with_player(rest, cache, args.rate, save, checkpoint)
            except KeyboardInterrupt:
                save()
                print("\nStopped; progress cached. Run again to resume.")
    write_output(videos, tab_orders, cache)


def write_output(videos: dict, tab_orders: list, cache: dict) -> None:
    exact = 0
    for v in videos.values():
        det = cache.get(v["id"]) or {}
        v["ts"] = to_ts(det.get("published"))
        v["approx"] = v["ts"] is None
        if not v["dur"] and det.get("length"):
            v["dur"] = det["length"]
        reason = (det.get("reason") or "").lower()
        v["status"] = "members" if "member" in reason else "private" if ("private" in reason or det.get("status") == "MISSING") else ""
        exact += v["ts"] is not None

    # Estimate missing dates from neighbours in the channel's own date-ordered listing.
    for order in tab_orders:
        known = [(i, videos[vid]["ts"]) for i, vid in enumerate(order) if not videos[vid]["approx"]]
        k = 0
        for i, vid in enumerate(order):
            v = videos[vid]
            if not v["approx"]:
                continue
            while k < len(known) and known[k][0] < i:
                k += 1
            newer = known[k - 1] if k > 0 else None      # smaller index = newer
            older = known[k] if k < len(known) else None
            if newer and older:
                # linear interpolation by position between the two known neighbours
                frac = (i - newer[0]) / (older[0] - newer[0])
                v["ts"] = int(newer[1] + (older[1] - newer[1]) * frac)
            elif newer or older:
                v["ts"] = (newer or older)[1]
            else:
                v["ts"] = 0

    out = sorted(videos.values(), key=lambda v: (v["ts"], v["id"]))
    payload = {
        "generated": int(time.time()),
        "channels": {k: name for k, _, name in CHANNELS},
        "exact": exact,
        # Compact rows: [id, title, ts, dur, ch, type, flags]
        "fields": ["id", "title", "ts", "dur", "ch", "type", "flags"],
        "videos": [
            [v["id"], v["title"], v["ts"], v["dur"] or 0, v["ch"], v["type"],
             ",".join(f for f in (v["status"], "approx" if v["approx"] else "") if f)]
            for v in out
        ],
    }
    tmp = OUT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(OUT_FILE)
    print(f"Wrote {len(out)} videos to {OUT_FILE.relative_to(ROOT)} ({exact} with exact dates, "
          f"{len(out) - exact} estimated)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
