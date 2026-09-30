#!/usr/bin/env python3
"""Maintain the site's data files for the daily digest job.

  python3 scripts/publish_day.py seen [--today YYYY-MM-DD] [--days 14]
      Print already-published item ids (all days) and recent keyword terms, as JSON.
      Pass --today to leave out today's file when a run is being redone.

  python3 scripts/publish_day.py publish data/days/YYYY-MM-DD.json
      Validate and normalize the day file, drop items published on other days,
      renumber ranks, then rebuild data/index.json and feed.xml.
      Prints a JSON summary (counts, dropped ids, headlines) for the Slack notice.
"""
import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DAYS = DATA / "days"
FEED = ROOT / "feed.xml"
SITE_URL = "https://meteor0108.github.io/ai-trend-radar/"
KST = timezone(timedelta(hours=9))

PAPER_SOURCES = {"alphaxiv", "hf", "arxiv"}
NEWS_SOURCES = {"geeknews", "hn", "meta", "nvidia", "google"}
ALL_SOURCES = PAPER_SOURCES | NEWS_SOURCES
ID_RE = re.compile(r"^(p-\d{4}\.\d{4,5}|gn-\d+|hn-\d+|(meta|nvidia|google)-[a-z0-9][a-z0-9-]{0,119})$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_PAPERS, MAX_NEWS = 5, 10
FEED_ITEMS = 60


def https(v):
    return v if isinstance(v, str) and v.startswith("https://") else None


def text(v, limit=600):
    return v.strip()[:limit] if isinstance(v, str) and v.strip() else None


def day_files():
    return sorted((p for p in DAYS.glob("*.json") if DATE_RE.match(p.stem)), key=lambda p: p.stem)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def clean_item(raw, warnings):
    """Return a normalized item, or None (with a warning) if a required field is bad."""
    if not isinstance(raw, dict):
        warnings.append("item is not an object")
        return None
    iid = raw.get("id")
    if not isinstance(iid, str) or not ID_RE.match(iid):
        warnings.append(f"bad id: {iid!r}")
        return None
    kind = raw.get("kind")
    if kind not in ("paper", "news") or (kind == "paper") != iid.startswith("p-"):
        warnings.append(f"{iid}: kind must be 'paper' for p- ids and 'news' otherwise")
        return None
    allowed = PAPER_SOURCES if kind == "paper" else NEWS_SOURCES
    source = raw.get("source")
    if source not in allowed:
        warnings.append(f"{iid}: source {source!r} not in {sorted(allowed)}")
        return None
    title, url, one = text(raw.get("title"), 300), https(raw.get("url")), text(raw.get("oneLine"), 300)
    if not (title and url and one):
        warnings.append(f"{iid}: title, https url and oneLine are required")
        return None

    item = {"id": iid, "kind": kind, "source": source}
    sources = [s for s in raw.get("sources") or [] if s in allowed]
    item["sources"] = list(dict.fromkeys([source] + sources))
    if kind == "paper":
        item["lane"] = "robotics" if raw.get("lane") == "robotics" else "trending"
        venue = text(raw.get("venue"), 40)
        if venue:
            item["venue"] = venue
    item["rank"] = raw.get("rank") if isinstance(raw.get("rank"), int) else 99
    item["title"] = title
    item["url"] = url
    for key in ("image", "figureUrl", "altUrl", "discussUrl"):
        if https(raw.get(key)):
            item[key] = raw[key]
    if isinstance(raw.get("score"), (int, float)):
        item["score"] = raw["score"]
    if text(raw.get("scoreLabel"), 60):
        item["scoreLabel"] = text(raw["scoreLabel"], 60)
    item["oneLine"] = one
    bullets = []
    for b in raw.get("bullets") or []:
        if isinstance(b, dict) and text(b.get("text")):
            bullets.append({"label": text(b.get("label"), 10) or "", "text": text(b["text"])})
    item["bullets"] = bullets[:3]
    if kind == "paper":
        flow = [text(s, 80) for s in raw.get("flow") or [] if text(s, 80)]
        if len(flow) >= 2:
            item["flow"] = flow[:5]
    item["keywords"] = list(dict.fromkeys(k.strip() for k in raw.get("keywords") or [] if isinstance(k, str) and k.strip()))[:4]
    item["addedAt"] = raw.get("addedAt") if isinstance(raw.get("addedAt"), str) else datetime.now(KST).isoformat(timespec="seconds")
    return item


def cmd_seen(args):
    files = [p for p in day_files() if p.stem != args.today]
    ids, terms = [], Counter()
    for p in files:
        try:
            day = read_json(p)
        except (OSError, ValueError) as e:
            print(f"warning: cannot read {p.name}: {e}", file=sys.stderr)
            continue
        ids += [i.get("id") for i in day.get("items") or [] if isinstance(i, dict)]
    for p in files[-args.days:]:
        try:
            day = read_json(p)
        except (OSError, ValueError):
            continue
        for i in day.get("items") or []:
            terms.update(k for k in (i.get("keywords") or []) if isinstance(k, str))
    print(json.dumps({"ids": sorted(set(filter(None, ids))), "recentKeywords": [t for t, _ in terms.most_common(40)]}, ensure_ascii=False, indent=1))


def cmd_publish(args):
    path = Path(args.file).resolve()
    date = path.stem
    if not DATE_RE.match(date):
        sys.exit(f"error: file name must be YYYY-MM-DD.json, got {path.name}")
    try:
        raw = read_json(path)
    except (OSError, ValueError) as e:
        sys.exit(f"error: cannot parse {path}: {e}")
    if raw.get("date") not in (None, date):
        sys.exit(f"error: 'date' field {raw.get('date')!r} does not match file name {date}")

    earlier = set()
    for p in day_files():
        if p.stem == date:
            continue
        try:
            earlier.update(i.get("id") for i in read_json(p).get("items") or [] if isinstance(i, dict))
        except (OSError, ValueError):
            pass

    warnings, dropped, seen, papers, news = [], [], set(), [], []
    for r in raw.get("items") or []:
        item = clean_item(r, warnings)
        if not item:
            continue
        if item["id"] in earlier or item["id"] in seen:
            dropped.append(item["id"])
            continue
        seen.add(item["id"])
        (papers if item["kind"] == "paper" else news).append(item)

    papers.sort(key=lambda i: i["rank"])
    news.sort(key=lambda i: i["rank"])
    papers, news = papers[:MAX_PAPERS], news[:MAX_NEWS]
    for group in (papers, news):
        for n, item in enumerate(group, 1):
            item["rank"] = n
    if not papers and not news:
        for w in warnings:
            print("warning:", w, file=sys.stderr)
        sys.exit("error: no valid items left to publish")

    keywords = []
    for k in raw.get("keywords") or []:
        if isinstance(k, dict) and text(k.get("term"), 40):
            keywords.append({"term": text(k["term"], 40), "note": text(k.get("note"), 200) or ""})
    day = {
        "date": date,
        "generatedAt": raw.get("generatedAt") if isinstance(raw.get("generatedAt"), str) else datetime.now(KST).isoformat(timespec="seconds"),
        "keywords": keywords[:5],
        "failed": [s for s in raw.get("failed") or [] if s in ALL_SOURCES],
        "items": papers + news,
    }
    write_json(path, day)
    rebuild_index()
    rebuild_feed()

    for w in warnings:
        print("warning:", w, file=sys.stderr)
    top = papers[:2] + news[:1] if papers else news[:3]
    print(json.dumps({
        "date": date,
        "papers": len(papers),
        "news": len(news),
        "dropped": dropped,
        "invalid": len(warnings),
        "failed": day["failed"],
        "headlines": [{"title": i["title"], "oneLine": i["oneLine"]} for i in top],
        "url": f"{SITE_URL}#{date}",
    }, ensure_ascii=False, indent=1))


def rebuild_index():
    days = []
    for p in reversed(day_files()):
        try:
            d = read_json(p)
        except (OSError, ValueError) as e:
            print(f"warning: skipping {p.name} in index: {e}", file=sys.stderr)
            continue
        items = [i for i in d.get("items") or [] if isinstance(i, dict)]
        days.append({
            "date": p.stem,
            "counts": {"paper": sum(i.get("kind") == "paper" for i in items), "news": sum(i.get("kind") == "news" for i in items)},
            "keywords": d.get("keywords") or [],
            "failed": d.get("failed") or [],
        })
    write_json(DATA / "index.json", {"updated": datetime.now(KST).isoformat(timespec="seconds"), "days": days})


def rebuild_feed():
    entries = []
    for p in reversed(day_files()):
        try:
            d = read_json(p)
        except (OSError, ValueError):
            continue
        pub = datetime.strptime(p.stem, "%Y-%m-%d").replace(hour=8, tzinfo=KST)
        for i in d.get("items") or []:
            entries.append((pub, i))
        if len(entries) >= FEED_ITEMS:
            break
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        "<channel>",
        "<title>AI 트렌드 레이더</title>",
        f"<link>{SITE_URL}</link>",
        "<description>매일 고른 AI 논문과 뉴스의 한국어 요약</description>",
        "<language>ko</language>",
        f"<lastBuildDate>{format_datetime(datetime.now(KST))}</lastBuildDate>",
    ]
    for pub, i in entries[:FEED_ITEMS]:
        tag = "논문" if i.get("kind") == "paper" else "뉴스"
        out += [
            "<item>",
            f"<title>{escape('[' + tag + '] ' + str(i.get('title', '')))}</title>",
            f"<link>{escape(str(i.get('url', SITE_URL)))}</link>",
            f"<guid isPermaLink=\"false\">{escape(str(i.get('id', '')))}</guid>",
            f"<pubDate>{format_datetime(pub)}</pubDate>",
            f"<description>{escape(str(i.get('oneLine', '')))}</description>",
            "</item>",
        ]
    out += ["</channel>", "</rss>", ""]
    with open(FEED, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seen")
    s.add_argument("--today", default=None)
    s.add_argument("--days", type=int, default=14)
    s.set_defaults(fn=cmd_seen)
    p = sub.add_parser("publish")
    p.add_argument("file")
    p.set_defaults(fn=cmd_publish)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
