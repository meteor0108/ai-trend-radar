# Daily digest job

Instructions for the scheduled Claude Code routine that fills this site. It runs unattended every day at about 03:30 KST (inside the owner's overnight usage window, so it must finish well before 04:00 KST): do not ask questions, make reasonable choices and proceed. Never invent details you did not read.

## 0. Setup

- `TODAY=$(TZ=Asia/Seoul date +%F)`
- `python3 scripts/publish_day.py seen --today $TODAY` → `ids` already published (skip these) and `recentKeywords` (reuse these exact spellings when a theme recurs).

## 1. Collect

The site shows each platform on its own tab: the top 5 papers / top 10 news per platform, with the rest behind "더보기". So collect **per platform**, walking down each list and skipping every id in `seen` until you have the target number of new items (or the list runs out).

Use WebFetch for pages; `curl` works too for the APIs below. If a source fails, skip it and add its key to `failed`.

| key | source | take (new items only) |
|---|---|---|
| `alphaxiv` | https://www.alphaxiv.org/ | top 10 trending papers |
| `hf` | https://huggingface.co/papers | top 10 by upvotes |
| `hftrend` | https://huggingface.co/papers/trending | top 10 in trending order (multi-day trend with GitHub stars; many overlap with `hf`/`alphaxiv`, which is fine) |
| `arxiv` | https://arxiv.org/list/cs.RO/new | robotics fill only, see "Robotics lane" in section 2 |
| `geeknews` | https://news.hada.io/ and https://news.hada.io/?page=2 (fallback https://news.hada.io/rss/news) | up to 15 AI/ML items, in front-page order |
| `hn` | https://news.ycombinator.com/ and https://news.ycombinator.com/news?p=2 | up to 15 AI/ML stories, in page order |
| `openai` | https://openai.com/news/rss.xml (the HTML pages return 403; use the RSS item text) | posts from the last 3 days (up to 15) |
| `anthropic` | https://www.anthropic.com/news (no RSS; dates are printed on the page) | posts from the last 3 days (up to 15) |
| `deepmind` | https://deepmind.google/blog/rss.xml | posts from the last 3 days (up to 15) |
| `google` | https://research.google/blog/rss/ | AI/ML posts from the last 3 days (up to 15) |
| `nvidia` | https://blogs.nvidia.com/feed/ and https://developer.nvidia.com/blog/feed/ | AI/ML research or technical posts from the last 3 days (up to 15); skip marketing, gaming, partner promos and event recaps |
| `meta` | https://ai.meta.com/blog/ | AI/ML posts from the last 3 days (up to 15) |

News is AI/ML only: LLMs, agents, vision, multimodal, robotics, RL, AI infra/tools, major AI industry news.

## 2. Rank

- One item per paper (dedupe by arXiv id) and per story. A paper on both alphaXiv and HF, or a story on both GeekNews and HN, is **one** item whose `sources` lists both platforms; put the other platform's link in `altUrl` (papers) or `discussUrl` (news).
- News on more than one platform also gets `sourceUrls`: the item's own page on each platform in `sources`, e.g. `{"hn": "https://news.ycombinator.com/item?id=41234567", "geeknews": "https://news.hada.io/topic?id=34500", "openai": "https://openai.com/index/…"}`. The site turns each platform name into a link with it. Papers and single-platform news do not need it (the links are derived from the id and `url`).
- A company-blog post that is also on GeekNews or HN is one item too: `sources` lists the blog and the site(s), `url` is the blog post, `discussUrl` the discussion page.
- `ranks`: the item's position on each platform it came from, e.g. `{"hf": 2, "alphaxiv": 7}` (HF by upvotes, alphaXiv/HF Trending by trending order, GeekNews/HN by page order, blogs newest first). The publish script renumbers them 1..n per platform, so only the order matters.
- `rank`: overall importance within papers and within news (1 = most important). The top 5 papers and top 10 news are the "전체" headline view:
  - Papers: prefer papers on more than one list, then HF upvotes / alphaXiv rank / HF Trending order. 1–2 of the top 5 are robotics-lane papers (the publish script moves the best-ranked robotics paper into the top 5 if you leave none there).
  - News: in the top 10, at most 4 company-blog posts (OpenAI, Anthropic, DeepMind, Google Research, Meta, NVIDIA; prefer model/research announcements); fill the rest from GeekNews and HN by relevance and points. Rank everything else after the top 10.
- Award-winning robotics conference papers live in the separate, hand-curated `data/conferences/` files; the daily job never touches them.

**Robotics lane** (the site shows these under a "로보틱스" chip, whichever list they came from)

- Every paper gets `"lane"`: `"robotics"` when its subject is robotics — arXiv primary category cs.RO, or robot learning, manipulation, locomotion, navigation, humanoids, VLA / embodied agents acting in the physical world, autonomous driving — otherwise `"trending"`. Decide from the abstract, not from the title alone.
- Aim for **5 robotics papers a day**. Count the robotics papers already collected from alphaXiv, HF and HF Trending. If there are fewer than 5, fill the gap from https://arxiv.org/list/cs.RO/new (new submissions only, not cross-lists or replacements; skip ids in `seen`).
- The cs.RO list has no popularity signal, so pick by reading the abstracts: prefer real-robot experiments over simulation-only results, new datasets/benchmarks or open-sourced systems, and clear, general contributions over narrow incremental ones. Do not pick on author or lab names you cannot verify from the page.
- A fill paper has `"source": "arxiv"`, `"sources": ["arxiv"]`, `"ranks": {"arxiv": n}` (your order of preference), `"scoreLabel": "arXiv cs.RO"` and no `score`.

## 3. Read and summarize (Korean, keep technical terms in English where natural)

Every collected item gets a summary, not only the top ones.

- Paper: read the abstract. `curl -s "https://export.arxiv.org/api/query?id_list=<id1>,<id2>,...&max_results=50"` returns every abstract (`<summary>`) and v1 submission time (`<published>`) in one call; if it fails, read https://arxiv.org/abs/<id>. Then WebFetch https://arxiv.org/html/<id> and ask for the `src` of the first real figure image (not an icon/logo); make it absolute, e.g. `https://arxiv.org/html/2501.12948v2/ppo_vs_grpo.png`, and store it as `image`. If there is no HTML version or no figure, omit `image` (the page falls back to the HF thumbnail, or shows no figure).
- Paper code: when the paper's code is public, set `codeUrl` to the repository (`https://github.com/<owner>/<repo>`, GitHub or GitLab only) and `codeStars` to its star count if known. Take it from `curl -s https://huggingface.co/api/papers/<arxivId>` → `githubRepo` / `githubStars` (the HF list data carries the same fields), or from a repository URL written in the arXiv abstract or comments. Leave both out when no repository is stated; never guess a URL, and do not use project pages or "code coming soon" notes.
- News: read the article (or the GeekNews topic page) enough to summarize accurately. If the article blocks fetching (e.g. 403), summarize from the GeekNews topic page, the HN thread or the RSS item text instead, using only facts quoted there.
- `keywords` per item: 1–3 short English terms, reusing `recentKeywords` spellings when they fit.
- Day `keywords`: write `[]`. The site no longer shows a daily keyword summary; its word cloud is built from the items' own `keywords`, so make those consistent (same spelling for the same theme).

**`published`: when the item was originally posted** (the site shows "N시간 전 / N일 전" and the full date). ISO 8601 with a timezone offset, or `YYYY-MM-DD` when the source gives only a date. Never guess a time you did not read.

| item | where the time comes from |
|---|---|
| paper | arXiv v1 submission: `<published>` from the arXiv API above, or the `[v1]` line of "Submission history" on the abs page |
| `hn` | `curl -s https://hacker-news.firebaseio.com/v0/item/<id>.json` → `time` (Unix seconds, UTC) |
| `geeknews` | the topic's timestamp in https://news.hada.io/rss/news; if it is not in the feed, the topic page's relative time ("3시간전") counted back from when you fetched it |
| blogs | the RSS `pubDate`, or the date printed on the post (`YYYY-MM-DD`, e.g. Anthropic) |

For a story on both GeekNews and HN, use the time of the platform in `source`.

## 4. Write `data/days/$TODAY.json`

Replace the file if it already exists. Shape:

```json
{
  "date": "2026-09-30",
  "keywords": [],
  "failed": [],
  "items": [
    {
      "id": "p-2609.38172",
      "kind": "paper",
      "source": "hf",
      "sources": ["hf", "alphaxiv"],
      "ranks": {"hf": 1, "alphaxiv": 3},
      "lane": "trending",
      "rank": 1,
      "published": "2026-09-28T17:59:59Z",
      "title": "Original English title",
      "url": "https://arxiv.org/abs/2609.38172",
      "image": "https://arxiv.org/html/2609.38172v1/x1.png",
      "figureUrl": "https://arxiv.org/html/2609.38172",
      "altUrl": "https://www.alphaxiv.org/abs/2609.38172",
      "codeUrl": "https://github.com/owner/repo",
      "codeStars": 1234,
      "score": 44,
      "scoreLabel": "HF 44▲ · alphaXiv #3",
      "oneLine": "한 줄 요약",
      "bullets": [{"label": "문제", "text": "…"}, {"label": "방법", "text": "…"}, {"label": "결과", "text": "…"}],
      "keywords": ["Humanoid", "World Model"]
    },
    {
      "id": "hn-41234567",
      "kind": "news",
      "source": "hn",
      "sources": ["hn"],
      "ranks": {"hn": 4},
      "rank": 1,
      "published": "2026-09-29T21:14:03Z",
      "title": "Story title as posted",
      "url": "https://original-article.example/…",
      "discussUrl": "https://news.ycombinator.com/item?id=41234567",
      "score": 844,
      "scoreLabel": "844P",
      "oneLine": "한 줄 요약",
      "bullets": [{"label": "", "text": "왜 중요한지 1~2줄"}],
      "keywords": ["Open Weights"]
    }
  ]
}
```

- ids: papers `p-<arxivId>` (no version suffix), GeekNews `gn-<topicId>`, HN `hn-<itemId>`, blogs `openai-<slug>` / `anthropic-<slug>` / `deepmind-<slug>` / `google-<slug>` / `meta-<slug>` / `nvidia-<slug>` (lowercase URL slug).
- Paper `source` is the main list it came from (`alphaxiv`, `hf`, `hftrend`, or `arxiv` for a robotics fill); `sources` lists every list it appeared on.
- News `bullets`: 1–2 items with an empty `label`.
- All URLs must be https.

## 4b. GitHub dashboard: `data/github/trending.json`

The site's GitHub tab is a dashboard, not part of the daily digest: one file holding the **current** trending AI/ML repositories, replaced on every run. It is not checked against `seen`, so a repository that trends again simply shows up again, and repositories never go into the day file.

1. WebFetch the three lists (curl to github.com returns 403 here): https://github.com/trending?since=daily, `?since=weekly`, `?since=monthly`. From each take, in page order, up to 15 AI/ML repositories (models, agents and agent tooling, LLM tools, ML libraries, AI learning material); skip everything else. Note each one's description, language, total stars and stars gained in that period.
2. Read the existing `data/github/trending.json` first. For a repository already in it (same `owner/repo`, case-insensitive) reuse its `oneLine`, `bullets`, `keywords` and `created`, and only refresh the numbers. Read the README (`https://github.com/<owner>/<repo>`) only for repositories that are new to the file.
3. For a new repository write `oneLine` (Korean, what it is), 1–2 `bullets` (Korean, plain strings, only facts from the README), 1–3 `keywords` (reuse `recentKeywords` spellings and the ones already in the file), and `created` from `curl -s https://ungh.cc/repos/<owner>/<repo>` → `repo.createdAt` (api.github.com is blocked here).
4. Write the file with one entry per repository; `periods` holds each list it is on:

```json
{
  "repos": [
    {
      "repo": "owner/name",
      "description": "The repository's own description, as shown on GitHub",
      "language": "Python",
      "stars": 50649,
      "periods": {"daily": {"rank": 2, "gained": 3483}, "weekly": {"rank": 4, "gained": 15186}},
      "created": "2026-04-09T21:40:26Z",
      "oneLine": "한 줄 요약",
      "bullets": ["README에 적힌 사실 1", "README에 적힌 사실 2"],
      "keywords": ["Coding Agents"]
    }
  ]
}
```

5. `python3 scripts/publish_day.py github data/github/trending.json` — it validates, renumbers the ranks 1..15 per period and stamps `updated`. Fix what it reports and run it again.

If the trending pages cannot be fetched, leave the existing file untouched and add `github` to the day file's `failed`.

## 5. Publish

1. `python3 scripts/publish_day.py publish data/days/$TODAY.json` — it validates, drops already-published ids, keeps at most 35 papers / 80 news, makes sure a robotics paper is in the top 5, renumbers `rank` and per-platform `ranks`, and rebuilds `data/index.json` and `feed.xml`. Fix anything it reports as an error and run it again; fix `missing published` warnings when the time can be read. Keep its JSON output for step 6.
2. `git add data feed.xml && git commit -m "digest: $TODAY"` and push to `main`. If the push is rejected, pull with rebase and push again once.

## 6. Notify on Slack

Send exactly one message with the Slack connector's `slack_send_message`, `channel_id` = `YOUR_SLACK_USER_ID` (the user's own DM). Do not send to any other channel or user. Markdown:

```
📰 **AI 트렌드 레이더 업데이트** — MM.DD (요일)
논문 N편 · 뉴스 M건
• <headline 1 title> — <oneLine>
• <headline 2 title> — <oneLine>
• <headline 3 title> — <oneLine>
👉 [오늘의 다이제스트 보기](<url from the publish output>)
```

Add a line `⚠️ 수집 실패: …` if `failed` is not empty. If the Slack tools are unavailable, skip this step and say so in the final response.

## 7. Finish

Final response: one line with paper/news counts, per-platform counts (`perSource`), GitHub dashboard counts (`perPeriod`), dropped duplicates, failed sources, and whether push and Slack succeeded.
