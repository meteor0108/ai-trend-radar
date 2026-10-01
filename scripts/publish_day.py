#!/usr/bin/env python3
"""Maintain the site's data files for the daily digest job.

  python3 scripts/publish_day.py seen [--today YYYY-MM-DD] [--days 14]
      Print already-published item ids (all days) and recent keyword terms, as JSON.
      Pass --today to leave out today's file when a run is being redone.

  python3 scripts/publish_day.py publish data/days/YYYY-MM-DD.json
      Validate and normalize the day file, drop items published on other days,
      renumber overall and per-platform ranks, then rebuild data/index.json and feed.xml.
      Prints a JSON summary (counts, dropped ids, headlines) for the Slack notice.
"""
import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DAYS = DATA / "days"
FEED = ROOT / "feed.xml"
SITE_URL = "https://meteor0108.github.io/ai-trend-radar/"
KST = timezone(timedelta(hours=9))

PAPER_SOURCES = {"alphaxiv", "hf", "hftrend", "arxiv"}
NEWS_SOURCES = {"geeknews", "hn", "github", "openai", "anthropic", "deepmind", "meta", "nvidia", "google"}
ALL_SOURCES = PAPER_SOURCES | NEWS_SOURCES
ID_RE = re.compile(r"^(p-\d{4}\.\d{4,5}|gn-\d+|hn-\d+|(gh|openai|anthropic|deepmind|meta|nvidia|google)-[a-z0-9][a-z0-9-]{0,119})$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CODE_RE = re.compile(r"^https://(github|gitlab)\.com/[\w.-]+/[\w.-]+/?$")
SHOW = {"paper": 5, "news": 10}  # shown before "더보기", overall and per platform
PER_SOURCE = {"paper": 10, "news": 15}  # items to collect per platform
MAX_TOTAL = {"paper": 35, "news": 80}
FEED_ITEMS = 60
WHEN_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$")


def https(v):
    return v if isinstance(v, str) and v.startswith("https://") else None


def text(v, limit=600):
    return v.strip()[:limit] if isinstance(v, str) and v.strip() else None


def when(v):
    """Normalize a source timestamp to KST ISO seconds, or keep a bare YYYY-MM-DD. None if unusable."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    if DATE_RE.match(v):
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            return None
        return v
    m = WHEN_RE.match(v)
    if not m:
        # RSS pubDate, e.g. "Wed, 30 Sep 2026 10:30:00 GMT"
        try:
            t = parsedate_to_datetime(v)
        except (TypeError, ValueError):
            return None
        if t is None or t.tzinfo is None or t > datetime.now(timezone.utc) + timedelta(hours=1):
            return None
        return t.astimezone(KST).isoformat(timespec="seconds")
    hms = m.group(2) if m.group(2).count(":") == 2 else m.group(2) + ":00"
    tz = "+00:00" if m.group(3) == "Z" else m.group(3)
    if ":" not in tz:
        tz = tz[:3] + ":" + tz[3:]
    try:
        t = datetime.fromisoformat(f"{m.group(1)}T{hms}{tz}")
    except ValueError:
        return None
    if t > datetime.now(timezone.utc) + timedelta(hours=1):
        return None
    return t.astimezone(KST).isoformat(timespec="seconds")


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
    item["rank"] = raw.get("rank") if isinstance(raw.get("rank"), int) else 999
    ranks = raw.get("ranks") if isinstance(raw.get("ranks"), dict) else {}
    item["ranks"] = {s: ranks[s] for s in item["sources"] if isinstance(ranks.get(s), int)}
    published = when(raw.get("published"))
    if published:
        item["published"] = published
    elif raw.get("published") is not None:
        warnings.append(f"{iid}: unusable published {raw.get('published')!r} (dropped the field)")
    else:
        warnings.append(f"{iid}: missing published")
    item["title"] = title
    item["url"] = url
    for key in ("image", "figureUrl", "altUrl", "discussUrl"):
        if https(raw.get(key)):
            item[key] = raw[key]
    urls = raw.get("sourceUrls") if isinstance(raw.get("sourceUrls"), dict) else {}
    urls = {s: urls[s] for s in item["sources"] if https(urls.get(s))}
    if urls:
        item["sourceUrls"] = urls
    if kind == "paper" and CODE_RE.match(str(raw.get("codeUrl") or "")):
        item["codeUrl"] = raw["codeUrl"].rstrip("/")
        if isinstance(raw.get("codeStars"), int) and raw["codeStars"] >= 0:
            item["codeStars"] = raw["codeStars"]
    elif raw.get("codeUrl"):
        warnings.append(f"{iid}: codeUrl must be a github.com or gitlab.com repository URL (dropped the field)")
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

    warnings, dropped, seen, papers, news, invalid = [], [], set(), [], [], 0
    for r in raw.get("items") or []:
        item = clean_item(r, warnings)
        if not item:
            invalid += 1
            continue
        if item["id"] in earlier or item["id"] in seen:
            dropped.append(item["id"])
            continue
        seen.add(item["id"])
        (papers if item["kind"] == "paper" else news).append(item)

    per_source = {}
    papers = rerank(papers, "paper", per_source, warnings)
    news = rerank(news, "news", per_source, warnings)
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
        "perSource": per_source,
        "dropped": dropped,
        "invalid": invalid,
        "warnings": len(warnings),
        "failed": day["failed"],
        "headlines": [{"title": i["title"], "oneLine": i["oneLine"]} for i in top],
        "url": f"{SITE_URL}#{date}",
    }, ensure_ascii=False, indent=1))


def rerank(group, kind, per_source, warnings):
    """Order by overall rank (1 = headline), then number each platform's items by their rank on that platform."""
    group = sorted(group, key=lambda i: i["rank"])[:MAX_TOTAL[kind]]
    if kind == "paper":
        # The headline papers always include a robotics paper when the day has one
        robotics = [i for i in group if i["lane"] == "robotics"]
        per_source["robotics"] = len(robotics)
        if robotics and robotics[0] not in group[:SHOW[kind]]:
            group.remove(robotics[0])
            group.insert(SHOW[kind] - 1, robotics[0])
    for n, item in enumerate(group, 1):
        item["rank"] = n
    for s in sorted({s for i in group for s in i["sources"]}):
        members = sorted((i for i in group if s in i["sources"]), key=lambda i: (i["ranks"].get(s, 10**6), i["rank"]))
        for n, item in enumerate(members, 1):
            item["ranks"][s] = n
        per_source[s] = len(members)
        if len(members) > PER_SOURCE[kind]:
            warnings.append(f"{s}: {len(members)} items, more than the {PER_SOURCE[kind]} per platform")
    return group


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
            # the feed carries only the headline picks shown before "더보기"
            if isinstance(i, dict) and isinstance(i.get("rank"), int) and i["rank"] <= SHOW.get(i.get("kind"), 0):
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
