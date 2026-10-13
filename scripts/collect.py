#!/usr/bin/env python3
"""Download today's raw source material for the daily digest.

Runs in GitHub Actions (see .github/workflows/collect.yml), where outbound network access is open.
The Claude Code routine that writes the digest runs in a sandbox that can reach GitHub but not
the paper and news sites, so it reads what this script stored on the `raw` branch instead of the web.

  python3 scripts/collect.py --out DIR

Writes into DIR:
  manifest.json   date (KST), collection time, and "ok" or an error message per source
  papers.json     ranked id lists per platform, plus details (abstract, v1 time, figure, code) per unseen paper
  news.json       ranked items per platform with the article (or GeekNews topic) text
  github.json     the daily/weekly/monthly trending lists, plus created time and README per repository

Items already published on an earlier day are listed with "seen": true and are not fetched in detail.
Only the standard library is used.
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import unquote, urljoin

ROOT = Path(__file__).resolve().parent.parent
KST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
ARXIV_ID = r"\d{4}\.\d{4,5}"
TEXT_LIMIT = 6000      # characters of article text kept per news item
README_LIMIT = 5000    # characters of README kept per repository
BLOG_DAYS = 3          # company-blog posts newer than this are collected
HN_TOP = 60            # Hacker News front-page depth (two pages of 30)
HF_DAILY_DETAIL = 25   # HF Daily papers fetched in detail, by upvotes
HFTREND_DETAIL = 25    # HF Trending papers fetched in detail, in trending order

status = {}


# ---------- HTTP and text helpers

def get(url, accept=None, headers=None, timeout=25, limit=4_000_000):
    """GET a URL and return (final_url, text). Raises on HTTP errors."""
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9,ko;q=0.8"}
    if accept:
        h["Accept"] = accept
    if accept and accept.startswith("text/html"):
        # some sites (ai.meta.com) answer 400 to page requests that do not look like a browser navigation
        h.update({"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "document", "Upgrade-Insecure-Requests": "1"})
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read(limit)
        charset = r.headers.get_content_charset() or "utf-8"
        return r.geturl(), body.decode(charset, errors="replace")


def get_json(url, **kw):
    return json.loads(get(url, accept="application/json", **kw)[1])


def retry(fn, *args, tries=3, **kw):
    for n in range(tries):
        try:
            return fn(*args, **kw)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if n == tries - 1 or (isinstance(e, urllib.error.HTTPError) and e.code in (400, 401, 403, 404, 410)):
                raise
            time.sleep(2 * (n + 1))


def strip_tags(s):
    s = re.sub(r"(?is)<(script|style|noscript|svg|template)\b.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|section)>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v\xa0]+", " ", s)
    return re.sub(r"\s*\n\s*", "\n", s).strip()


def page_text(doc, limit=TEXT_LIMIT):
    """Readable text of an article page: the <article> or <main> element if there is one, else the body."""
    doc = re.sub(r"(?is)<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b.*?</\1>", " ", doc)
    for tag in ("article", "main"):
        m = re.search(rf"(?is)<{tag}\b[^>]*>(.*)</{tag}>", doc)
        if m and len(strip_tags(m.group(1))) > 400:
            return strip_tags(m.group(1))[:limit]
    m = re.search(r"(?is)<body\b[^>]*>(.*)</body>", doc)
    return strip_tags(m.group(1) if m else doc)[:limit]


def fetch_text(url):
    """Article text, or None when the page cannot be read."""
    if not url or not url.startswith("http"):
        return None
    try:
        _, doc = retry(get, url, accept="text/html,application/xhtml+xml", timeout=20, limit=3_000_000, tries=2)
    except Exception:
        return None
    if re.search(r"(?i)\.pdf(\?|$)", url) or doc.startswith("%PDF"):
        return None
    t = page_text(doc)
    return t if len(t) > 200 else None


def no_decl(xml):
    """ElementTree refuses a str that still carries an encoding declaration (or a byte order mark)."""
    return re.sub(r"^\s*<\?xml[^>]*\?>", "", xml.lstrip("﻿ \t\r\n"))


def pmap(fn, items, workers=8):
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def iso(t):
    return t.astimezone(KST).isoformat(timespec="seconds") if t else None


def rss_time(s):
    try:
        t = parsedate_to_datetime(s.strip())
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, AttributeError):
        return None


def source(key):
    """Decorator: run a collector, record "ok" or the error, return [] / {} on failure."""
    def wrap(fn):
        def run(*a, **kw):
            t0 = time.time()
            try:
                out = fn(*a, **kw)
                status[key] = "ok"
                return out
            except Exception as e:
                status[key] = f"error: {type(e).__name__}: {e}"[:300]
                print(f"[{key}] failed: {e}", file=sys.stderr)
                return None
            finally:
                print(f"[{key}] {status.get(key)} ({time.time() - t0:.0f}s)", file=sys.stderr)
        return run
    return wrap


def seen_ids(today):
    out = subprocess.run([sys.executable, str(ROOT / "scripts" / "publish_day.py"), "seen", "--today", today],
                         capture_output=True, text=True, check=True).stdout
    return set(json.loads(out)["ids"])


# ---------- papers

@source("hf")
def hf_daily():
    rows = get_json("https://huggingface.co/api/daily_papers?limit=100")
    rows.sort(key=lambda r: -(r.get("paper", {}).get("upvotes") or 0))
    return [hf_row(r) for r in rows if re.fullmatch(ARXIV_ID, r.get("paper", {}).get("id", ""))]


@source("hftrend")
def hf_trending():
    rows = get_json("https://huggingface.co/api/daily_papers?sort=trending&limit=50")
    return [hf_row(r) for r in rows if re.fullmatch(ARXIV_ID, r.get("paper", {}).get("id", ""))]


def hf_row(r):
    p = r["paper"]
    return {"id": p["id"], "upvotes": p.get("upvotes"), "githubRepo": p.get("githubRepo"), "githubStars": p.get("githubStars"),
            "thumbnail": r.get("thumbnail"), "title": (r.get("title") or p.get("title") or "").strip()}


@source("alphaxiv")
def alphaxiv():
    _, doc = retry(get, "https://www.alphaxiv.org/", accept="text/html")
    ids = list(dict.fromkeys(re.findall(rf"/abs/({ARXIV_ID})", doc)))
    if not ids:
        raise ValueError("no papers found on the page")
    return ids


@source("arxiv")
def arxiv_ro_new():
    """New cs.RO submissions (not cross-lists or replacements), with title, subjects and abstract from the list page."""
    _, doc = retry(get, "https://arxiv.org/list/cs.RO/new", accept="text/html")
    m = re.search(r"(?s)<h3>New submissions.*?</h3>(.*?)(<h3>|$)", doc)
    if not m:
        raise ValueError("no 'New submissions' section")
    out = []
    for dt, dd in re.findall(r"(?s)<dt>(.*?)</dt>\s*<dd>(.*?)</dd>", m.group(1)):
        aid = re.search(rf"/abs/({ARXIV_ID})", dt)
        if not aid:
            continue
        title = re.search(r"(?s)list-title[^>]*>.*?</span>(.*?)</div>", dd)
        subj = re.search(r"(?s)list-subjects[^>]*>.*?</span>(.*?)</div>", dd)
        abstract = re.search(r"(?s)<p class=.mathjax.>(.*?)</p>", dd)
        comments = re.search(r"(?s)list-comments[^>]*>.*?</span>(.*?)</div>", dd)
        out.append({"id": aid.group(1), "title": strip_tags(title.group(1)) if title else "",
                    "subjects": strip_tags(subj.group(1)) if subj else "",
                    "comments": strip_tags(comments.group(1)) if comments else "",
                    "abstract": strip_tags(abstract.group(1)) if abstract else ""})
    return out


def arxiv_meta(ids):
    """Title, abstract, v1 submission time, primary category and comments from the arXiv API, by id."""
    ns = {"a": "http://www.w3.org/2005/Atom", "x": "http://arxiv.org/schemas/atom"}
    out = {}
    ids = list(ids)
    for i in range(0, len(ids), 40):
        chunk = ids[i:i + 40]
        url = "https://export.arxiv.org/api/query?max_results=100&id_list=" + ",".join(chunk)
        try:
            _, xml = retry(get, url, timeout=60)
        except Exception as e:
            print(f"[arxiv-api] chunk failed: {e}", file=sys.stderr)
            continue
        for e in ET.fromstring(no_decl(xml)).findall("a:entry", ns):
            m = re.search(rf"({ARXIV_ID})", e.findtext("a:id", "", ns))
            if not m:
                continue
            prim = e.find("x:primary_category", ns)
            out[m.group(1)] = {
                "title": re.sub(r"\s+", " ", e.findtext("a:title", "", ns)).strip(),
                "abstract": re.sub(r"\s+", " ", e.findtext("a:summary", "", ns)).strip(),
                "published": e.findtext("a:published", "", ns).strip(),
                "primaryCategory": prim.get("term") if prim is not None else None,
                "comments": re.sub(r"\s+", " ", e.findtext("x:comment", "", ns)).strip() or None,
                "authors": [a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)][:8],
            }
        time.sleep(3)  # arXiv API etiquette
    return out


def arxiv_figure(aid):
    """Absolute URL of the first figure image in the arXiv HTML version, or None."""
    try:
        final, doc = retry(get, f"https://arxiv.org/html/{aid}", accept="text/html", timeout=30, limit=6_000_000, tries=2)
    except Exception:
        return None
    m = re.search(r'<img[^>]+src="([^"]+)"[^>]*class="ltx_graphics', doc) or re.search(r'<img[^>]+class="ltx_graphics[^"]*"[^>]*src="([^"]+)"', doc)
    if not m or m.group(1).startswith("data:"):
        return None
    src = m.group(1)
    if re.match(rf"{ARXIV_ID}v\d+/", src):  # e.g. "2610.12549v1/fig.png", relative to /html/
        return urljoin("https://arxiv.org/html/", src)  # urljoin also resolves "../" segments
    return urljoin(final.rstrip("/") + "/", src).replace("http://", "https://")


def hf_paper(aid):
    try:
        p = get_json(f"https://huggingface.co/api/papers/{aid}", timeout=20)
        return {"githubRepo": p.get("githubRepo"), "githubStars": p.get("githubStars"), "upvotes": p.get("upvotes")}
    except Exception:
        return {}


def collect_papers(seen):
    hf, ht, ax, ro = hf_daily() or [], hf_trending() or [], alphaxiv() or [], arxiv_ro_new() or []
    is_new = lambda aid: "p-" + aid not in seen
    lists = {
        "hf": [{"id": r["id"], "upvotes": r["upvotes"], "seen": not is_new(r["id"])} for r in hf],
        "alphaxiv": [{"id": a, "seen": not is_new(a)} for a in ax],
        "hftrend": [{"id": r["id"], "githubStars": r["githubStars"], "seen": not is_new(r["id"])} for r in ht],
        "arxiv": [{"id": r["id"], "seen": not is_new(r["id"])} for r in ro],
    }
    # Which papers get details: the unseen ones near the top of each list, and every new cs.RO submission
    want = [r["id"] for r in hf if is_new(r["id"])][:HF_DAILY_DETAIL]
    want += [a for a in ax if is_new(a)]
    want += [r["id"] for r in ht if is_new(r["id"])][:HFTREND_DETAIL]
    want += [r["id"] for r in ro if is_new(r["id"])]
    want = list(dict.fromkeys(want))
    print(f"[papers] details for {len(want)} papers", file=sys.stderr)

    meta = arxiv_meta(want)
    figures = dict(zip(want, pmap(arxiv_figure, want, workers=4)))
    hf_info = {r["id"]: r for r in hf + ht}
    need_hf = [a for a in want if a not in hf_info]
    hf_info.update({a: d for a, d in zip(need_hf, pmap(hf_paper, need_hf, workers=6)) if d})
    ro_info = {r["id"]: r for r in ro}

    papers = {}
    for aid in want:
        m, h, r = meta.get(aid, {}), hf_info.get(aid, {}), ro_info.get(aid, {})
        papers[aid] = {
            "title": m.get("title") or r.get("title") or h.get("title"),
            "abstract": m.get("abstract") or r.get("abstract"),
            "published": m.get("published"),
            "primaryCategory": m.get("primaryCategory"),
            "subjects": r.get("subjects") or None,
            "comments": m.get("comments") or r.get("comments") or None,
            "authors": m.get("authors"),
            "image": figures.get(aid),
            "hfThumbnail": h.get("thumbnail"),
            "githubRepo": h.get("githubRepo"),
            "githubStars": h.get("githubStars"),
            "hfUpvotes": h.get("upvotes"),
        }
    return {"lists": lists, "papers": papers}


# ---------- news

@source("hn")
def hacker_news(seen):
    ids = get_json("https://hacker-news.firebaseio.com/v0/topstories.json")[:HN_TOP]

    def item(n_id):
        n, i = n_id
        try:
            it = get_json(f"https://hacker-news.firebaseio.com/v0/item/{i}.json", timeout=20) or {}
        except Exception:
            return None
        if it.get("type") != "story" or it.get("dead") or it.get("deleted"):
            return None
        hid = f"hn-{i}"
        row = {"id": hid, "rank": n, "title": it.get("title"), "url": it.get("url") or f"https://news.ycombinator.com/item?id={i}",
               "discussUrl": f"https://news.ycombinator.com/item?id={i}", "points": it.get("score"), "comments": it.get("descendants"),
               "published": iso(datetime.fromtimestamp(it["time"], timezone.utc)) if it.get("time") else None, "seen": hid in seen}
        if not row["seen"]:
            row["text"] = strip_tags(it["text"])[:TEXT_LIMIT] if it.get("text") else fetch_text(it.get("url"))
        return row

    return [r for r in pmap(item, list(enumerate(ids, 1)), workers=10) if r]


@source("geeknews")
def geeknews(seen):
    rows, pubs, feed_text = [], {}, {}
    try:  # the feed carries exact posting times (and the summary) for the newest topics
        _, xml = retry(get, "https://news.hada.io/rss/news")
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for e in ET.fromstring(no_decl(xml)).findall("a:entry", ns):
            m = re.search(r"id=(\d+)", e.findtext("a:id", "", ns))
            if m:
                pubs[m.group(1)] = e.findtext("a:published", "", ns)
                feed_text[m.group(1)] = strip_tags(e.findtext("a:content", "", ns))
    except Exception as e:
        print(f"[geeknews] rss: {e}", file=sys.stderr)
    for page in (1, 2):
        _, doc = retry(get, f"https://news.hada.io/?page={page}", accept="text/html")
        for chunk in doc.split("<div class='topic_row'")[1:]:
            tid = re.search(r"data-topic-state-id='(\d+)'", chunk)
            title = re.search(r"(?s)<h2[^>]*>(.*?)</h2>", chunk)
            link = re.search(r"<a href='([^']+)' rel='nofollow' id='tr", chunk)
            pts = re.search(r"id='tp\d+'>(\d+)</span>", chunk)
            desc = re.search(r"(?s)<div class='topicdesc'>(.*?)</div>", chunk)
            dt = re.search(r'datetime="([^"]+)"', chunk)
            if not (tid and title):
                continue
            t = tid.group(1)
            url = html.unescape(link.group(1)) if link else ""
            rows.append({"id": f"gn-{t}", "rank": len(rows) + 1, "title": strip_tags(title.group(1)),
                         "url": url if url.startswith("http") else f"https://news.hada.io/topic?id={t}",
                         "discussUrl": f"https://news.hada.io/topic?id={t}", "points": int(pts.group(1)) if pts else None,
                         "published": pubs.get(t) or (dt.group(1) if dt else None), "seen": f"gn-{t}" in seen,
                         "summary": strip_tags(desc.group(1)) if desc else None})
    if not rows:
        raise ValueError("no topics found on the front page")

    def topic(row):
        if row["seen"]:
            return row
        row["text"] = None
        try:
            _, doc = retry(get, row["discussUrl"], accept="text/html")
            m = re.search(r"(?s)id='topic_contents'[^>]*>(.*?)(<div class='comment|<div id='comment|id='comment_thread|$)", doc)
            row["text"] = strip_tags(m.group(1))[:TEXT_LIMIT] if m else None
            if not row["text"]:  # older topics answer with a JavaScript browser check instead of the post
                row["textError"] = "no topic text: " + re.sub(r"\s+", " ", strip_tags(doc))[:80]
        except Exception as e:
            row["textError"] = str(e)[:200]
        row["text"] = row["text"] or feed_text.get(row["id"][3:]) or None
        time.sleep(0.5)  # the site throttles bursts
        return row

    return pmap(topic, rows, workers=2)


def recent(t, now):
    return t is not None and now - t <= timedelta(days=BLOG_DAYS) and t <= now + timedelta(hours=1)


def rss_items(url):
    _, xml = retry(get, url, accept="application/rss+xml,application/xml,text/xml")
    root = ET.fromstring(no_decl(xml))
    ce = "{http://purl.org/rss/1.0/modules/content/}encoded"
    for it in root.iter("item"):
        yield {"title": (it.findtext("title") or "").strip(), "url": (it.findtext("link") or "").strip(),
               "time": rss_time(it.findtext("pubDate") or ""), "description": strip_tags(it.findtext("description") or ""),
               "content": strip_tags(it.findtext(ce) or "")}


def slug(url):
    parts = [p for p in re.sub(r"[?#].*$", "", url).rstrip("/").split("/") if p]
    return re.sub(r"[^a-z0-9]+", "-", unquote(parts[-1]).lower()).strip("-")[:120] if parts else ""


def blog(key, feeds, now, seen, fetch=True):
    """Recent posts from RSS feeds, newest first, with the article text."""
    rows = []
    for url in feeds:
        for it in rss_items(url):
            if not recent(it["time"], now) or not it["url"].startswith("https://"):
                continue
            iid = f"{key}-{slug(it['url'])}"
            if any(r["id"] == iid for r in rows):
                continue
            rows.append({"id": iid, "title": it["title"], "url": it["url"], "published": iso(it["time"]),
                         "summary": it["description"][:1000], "seen": iid in seen, "_content": it["content"]})
    rows.sort(key=lambda r: r["published"], reverse=True)

    def body(r):
        content = r.pop("_content")
        if not r["seen"]:
            r["text"] = (content[:TEXT_LIMIT] if len(content) > 400 else None) or (fetch_text(r["url"]) if fetch else None)
        return r

    rows = pmap(body, rows, workers=4)
    for n, r in enumerate(rows, 1):
        r["rank"] = n
    return rows


@source("openai")
def openai_blog(now, seen):
    # openai.com pages answer 403 to scripts, so only the RSS text is kept
    return blog("openai", ["https://openai.com/news/rss.xml"], now, seen, fetch=False)


@source("deepmind")
def deepmind_blog(now, seen):
    return blog("deepmind", ["https://deepmind.google/blog/rss.xml"], now, seen)


@source("google")
def google_blog(now, seen):
    return blog("google", ["https://research.google/blog/rss/"], now, seen)


@source("nvidia")
def nvidia_blog(now, seen):
    return blog("nvidia", ["https://blogs.nvidia.com/feed/", "https://developer.nvidia.com/blog/feed/"], now, seen)


@source("anthropic")
def anthropic_blog(now, seen):
    """anthropic.com/news has no feed; dates are printed next to each link."""
    _, doc = retry(get, "https://www.anthropic.com/news", accept="text/html")
    rows = []
    for m in re.finditer(r'href="/news/([a-z0-9-]+)"', doc):
        s = m.group(1)
        if any(r["id"] == f"anthropic-{s}" for r in rows):
            continue
        near = strip_tags(doc[m.end():m.end() + 1500])
        d = re.search(r"([A-Z][a-z]{2} \d{1,2}, \d{4})", near)
        if not d:
            continue
        day = datetime.strptime(d.group(1), "%b %d, %Y").replace(tzinfo=KST)
        if now - day > timedelta(days=BLOG_DAYS + 1):
            continue
        rows.append({"id": f"anthropic-{s}", "title": None, "url": f"https://www.anthropic.com/news/{s}",
                     "published": day.strftime("%Y-%m-%d"), "seen": f"anthropic-{s}" in seen})

    def body(r):
        try:
            _, page = retry(get, r["url"], accept="text/html", tries=2)
            t = re.search(r"(?s)<h1[^>]*>(.*?)</h1>", page) or re.search(r"(?s)<title>(.*?)</title>", page)
            r["title"] = strip_tags(t.group(1)).replace(" \\ Anthropic", "").strip() if t else r["url"]
            if not r["seen"]:
                r["text"] = page_text(page)
        except Exception:
            r["title"] = r["title"] or r["url"]
        return r

    rows = pmap(body, rows, workers=4)
    rows.sort(key=lambda r: r["published"], reverse=True)
    for n, r in enumerate(rows, 1):
        r["rank"] = n
    return rows


@source("meta")
def meta_blog(now, seen):
    _, doc = retry(get, "https://ai.meta.com/blog/", accept="text/html,application/xhtml+xml")
    links = list(dict.fromkeys(re.findall(r'href="(https://ai\.meta\.com/blog/[a-z0-9-]+/?)"', doc)))[:15]
    rows = []
    for url in links:
        try:
            _, page = retry(get, url, accept="text/html", tries=2)
        except Exception:
            continue
        # posts print their date as text, e.g. "April 8, 2026"
        d = re.search(r"\b((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})\b", strip_tags(page))
        if not d:
            continue
        day = datetime.strptime(d.group(1), "%B %d, %Y").replace(tzinfo=KST)
        if now - day > timedelta(days=BLOG_DAYS + 1):
            continue
        title = re.search(r'(?s)<meta property="og:title" content="([^"]+)"', page) or re.search(r"(?s)<h1[^>]*>(.*?)</h1>", page)
        iid = f"meta-{slug(url)}"
        rows.append({"id": iid, "title": strip_tags(title.group(1)) if title else url, "url": url,
                     "published": day.strftime("%Y-%m-%d"), "seen": iid in seen, "text": None if iid in seen else page_text(page)})
    rows.sort(key=lambda r: r["published"], reverse=True)
    for n, r in enumerate(rows, 1):
        r["rank"] = n
    return rows


def collect_news(seen):
    now = datetime.now(timezone.utc)
    out = {
        "geeknews": geeknews(seen), "hn": hacker_news(seen),
        "openai": openai_blog(now, seen), "anthropic": anthropic_blog(now, seen), "deepmind": deepmind_blog(now, seen),
        "google": google_blog(now, seen), "nvidia": nvidia_blog(now, seen), "meta": meta_blog(now, seen),
    }
    return {k: v for k, v in out.items() if v is not None}


# ---------- GitHub trending

def gh_api(path):
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    return get_json("https://api.github.com" + path, headers=headers, timeout=20)


@source("github")
def github_trending():
    lists = {}
    for period in ("daily", "weekly", "monthly"):
        _, doc = retry(get, f"https://github.com/trending?since={period}", accept="text/html")
        rows = []
        for art in doc.split('<article class="Box-row">')[1:]:
            name = re.search(r'(?s)<h2[^>]*>\s*<a[^>]*href="/([\w.-]+/[\w.-]+)"', art)
            if not name:
                continue
            desc = re.search(r'(?s)<p class="col-9[^"]*">(.*?)</p>', art)
            lang = re.search(r'itemprop="programmingLanguage">([^<]+)<', art)
            stars = re.search(r'(?s)href="/[\w.-]+/[\w.-]+/stargazers"[^>]*>.*?</svg>\s*([\d,]+)', art)
            gained = re.search(r"([\d,]+) stars? (today|this week|this month)", art)
            rows.append({"repo": name.group(1), "rank": len(rows) + 1, "description": strip_tags(desc.group(1)) if desc else None,
                         "language": lang.group(1).strip() if lang else None,
                         "stars": int(stars.group(1).replace(",", "")) if stars else None,
                         "gained": int(gained.group(1).replace(",", "")) if gained else None})
        if not rows:
            raise ValueError(f"no repositories found on the {period} page")
        lists[period] = rows

    def repo(name):
        info = {}
        try:
            r = gh_api(f"/repos/{name}")
            info["created"] = r.get("created_at")
            info["topics"] = r.get("topics") or []
            info["homepage"] = r.get("homepage") or None
        except Exception as e:
            info["error"] = str(e)[:200]
        try:
            _, md = get(f"https://api.github.com/repos/{name}/readme", headers={
                "Accept": "application/vnd.github.raw",
                **({"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"]} if os.environ.get("GITHUB_TOKEN") else {})}, timeout=20)
            info["readme"] = md[:README_LIMIT]
        except Exception:
            info["readme"] = None
        return info

    names = list(dict.fromkeys(r["repo"] for rows in lists.values() for r in rows))
    return {"lists": lists, "repos": dict(zip(names, pmap(repo, names, workers=6)))}


# ---------- main

def write(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    started = datetime.now(KST)
    today = started.strftime("%Y-%m-%d")
    seen = seen_ids(today)
    print(f"[collect] {today}, {len(seen)} ids already published", file=sys.stderr)

    write(out / "papers.json", collect_papers(seen))
    write(out / "news.json", collect_news(seen))
    write(out / "github.json", github_trending() or {})
    write(out / "manifest.json", {"date": today, "startedAt": started.isoformat(timespec="seconds"),
                                  "finishedAt": datetime.now(KST).isoformat(timespec="seconds"), "status": status})
    failed = [k for k, v in status.items() if v != "ok"]
    print(f"[collect] done; failed: {failed or 'none'}", file=sys.stderr)


if __name__ == "__main__":
    main()
