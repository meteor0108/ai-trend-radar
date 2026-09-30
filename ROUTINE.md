# Daily digest job

Instructions for the scheduled Claude Code routine that fills this site. It runs unattended every day at 07:58 KST: do not ask questions, make reasonable choices and proceed. Never invent details you did not read.

## 0. Setup

- `TODAY=$(TZ=Asia/Seoul date +%F)`
- `python3 scripts/publish_day.py seen --today $TODAY` → `ids` already published (skip these) and `recentKeywords` (reuse these exact spellings when a theme recurs).

## 1. Collect

Use the WebFetch tool for every source. If a source fails, skip it and add its key to `failed`.

| key | source | what to take |
|---|---|---|
| `alphaxiv` | https://www.alphaxiv.org/ | top ~10 trending papers |
| `hf` | https://huggingface.co/papers | top ~10 by upvotes |
| `arxiv` | https://export.arxiv.org/api/query?search_query=cat:cs.RO+AND+(co:CoRL+OR+co:RSS+OR+co:ICRA+OR+co:IROS)&sortBy=submittedDate&sortOrder=descending&max_results=40 | robotics papers submitted in the last 7 days whose comment says accepted at / to appear in CoRL, RSS, ICRA or IROS (ignore "submitted to", "under review") |
| `geeknews` | https://news.hada.io/ (fallback https://news.hada.io/rss/news) | front-page items |
| `hn` | https://news.ycombinator.com/ | top ~30 stories with points |
| `google` | https://research.google/blog/rss/ | posts from the last 3 days |
| `nvidia` | https://blogs.nvidia.com/feed/ and https://developer.nvidia.com/blog/feed/ | posts from the last 3 days |
| `meta` | https://ai.meta.com/blog/ | posts from the last 3 days |

## 2. Select (skip every id in `seen`)

**Papers — exactly 5 when possible**
- Robotics lane (`"lane": "robotics"`): 2 papers if there are two strong conference-accepted candidates, otherwise 1. Set `venue` like `"CoRL 2026"`. If there is no conference-accepted paper, pick 1 robotics paper (cs.RO or clearly about robots) from the alphaXiv/HF lists instead, with no `venue`.
- Trending lane (`"lane": "trending"`): fill the rest from alphaXiv + HF merged, deduped by arXiv id. Prefer papers on both lists, then HF upvotes / alphaXiv rank.
- Ranks: trending papers first (1, 2, 3…), then robotics.

**News — up to 10**
- AI/ML only: LLMs, agents, vision, multimodal, robotics, RL, AI infra/tools, major AI industry news.
- Company blogs: at most 3 blog posts in total, prefer research/technical posts. Skip NVIDIA marketing, gaming, partner promos and event recaps.
- Fill the rest from GeekNews and Hacker News by relevance and points. If the same story appears on both, keep one and put the other link in `discussUrl`.
- Order by importance (rank 1 = most important).

## 3. Read and summarize (Korean, keep technical terms in English where natural)

- Paper: read https://arxiv.org/abs/<id>. Then WebFetch https://arxiv.org/html/<id> and ask for the `src` of the first real figure image (not an icon/logo); make it absolute, e.g. `https://arxiv.org/html/2501.12948v2/ppo_vs_grpo.png`, and store it as `image`. If there is no HTML version or no figure, omit `image` (the page falls back to the HF thumbnail or the flow diagram).
- News: read the article (or the GeekNews topic page) enough to summarize accurately. If the article blocks fetching (e.g. 403), summarize from the GeekNews topic page or the HN thread instead, using only facts quoted there.
- `keywords` per item: 1–3 short English terms, reusing `recentKeywords` spellings when they fit.
- Day `keywords`: 3–5 themes recurring across today's items, each with a one-sentence Korean `note`.

## 4. Write `data/days/$TODAY.json`

Replace the file if it already exists. Shape:

```json
{
  "date": "2026-09-30",
  "keywords": [{"term": "World Model", "note": "로봇·영상 생성 모두 월드 모델을 학습 신호로 쓰는 흐름"}],
  "failed": [],
  "items": [
    {
      "id": "p-2609.38172",
      "kind": "paper",
      "source": "arxiv",
      "sources": ["arxiv"],
      "lane": "robotics",
      "venue": "CoRL 2026",
      "rank": 4,
      "title": "Original English title",
      "url": "https://arxiv.org/abs/2609.38172",
      "image": "https://arxiv.org/html/2609.38172v1/x1.png",
      "figureUrl": "https://arxiv.org/html/2609.38172",
      "altUrl": "https://www.alphaxiv.org/abs/2609.38172",
      "score": 44,
      "scoreLabel": "HF 44▲ · alphaXiv #3",
      "oneLine": "한 줄 요약",
      "bullets": [{"label": "문제", "text": "…"}, {"label": "방법", "text": "…"}, {"label": "결과", "text": "…"}],
      "flow": ["입력/데이터", "핵심 단계", "학습/추론", "결과"],
      "keywords": ["Humanoid", "World Model"]
    },
    {
      "id": "hn-41234567",
      "kind": "news",
      "source": "hn",
      "sources": ["hn"],
      "rank": 1,
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

- ids: papers `p-<arxivId>` (no version suffix), GeekNews `gn-<topicId>`, HN `hn-<itemId>`, blogs `meta-<slug>` / `nvidia-<slug>` / `google-<slug>` (lowercase URL slug).
- Paper `source` is the main list it came from (`alphaxiv`, `hf` or `arxiv`); `sources` lists every list it appeared on.
- Paper `flow`: 3–5 short steps summarizing the method from the abstract, last step = the outcome.
- News `bullets`: 1–2 items with an empty `label`.
- All URLs must be https.

## 5. Publish

1. `python3 scripts/publish_day.py publish data/days/$TODAY.json` — it validates, drops already-published ids, caps to 5 papers / 10 news, renumbers ranks, and rebuilds `data/index.json` and `feed.xml`. Fix anything it reports as an error and run it again. Keep its JSON output for step 6.
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

Final response: one line with paper/news counts, dropped duplicates, failed sources, and whether push and Slack succeeded.
