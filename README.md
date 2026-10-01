# AI 트렌드 레이더

alphaXiv · HF Daily Papers · GeekNews · Hacker News · Meta AI / NVIDIA / Google Research 블로그에서
매일 AI 논문과 뉴스를 플랫폼별로 모아(alphaXiv·HF Papers·HF Trending 논문 각 10편과 로보틱스 논문 5편(부족하면 arXiv cs.RO에서 보충), GeekNews·HN 각 최대 15건과 OpenAI·Anthropic·DeepMind·Google Research·Meta·NVIDIA 블로그 새 글) 한국어로 요약하고, 로보틱스 탑티어 학회 수상 논문을 모아 보여주는 정적 사이트. 화면에는 전체·플랫폼별로 논문 5편·뉴스 10건을 먼저 보여 주고 나머지는 "더보기"로 연다. GitHub 탭은 github.com/trending의 AI/ML 저장소(오늘·이번 주·이번 달)를 매일 새로 받아 보여 주는 대시보드다. GitHub Pages로 게시한다.

- 사이트: https://meteor0108.github.io/ai-trend-radar/
- 매일 03:30 KST 무렵 Claude Code 예약 작업이 [ROUTINE.md](ROUTINE.md)를 따라 수집·요약하고 `data/`에 커밋한다. Slack에는 업데이트 알림만 보낸다.

## 구조

| 경로 | 내용 |
|---|---|
| `index.html`, `style.css`, `app.js` | 목록형 뷰어 (날짜 이동, 논문/뉴스 필터, 키워드 필터, 전체 기간 검색, 별표·읽음은 브라우저에 저장) |
| `data/days/YYYY-MM-DD.json` | 하루치 항목과 키워드 (스키마는 ROUTINE.md 4번) |
| `data/index.json`, `feed.xml` | `scripts/publish_day.py publish`가 다시 만드는 날짜 목록과 RSS |
| `scripts/publish_day.py` | 하루치 파일 검증, 이전 날짜와 중복 제거, 목록·RSS 재생성 |
| `data/conferences/*.json` | 학회 탭: ICRA·IROS·RSS·CoRL 2022–2026 수상작·후보 논문과 한국어 요약 (한 번 수작업으로 모은 데이터, 매일 작업은 건드리지 않음) |
| `data/github/trending.json` | GitHub 탭: 지금 트렌딩 중인 AI/ML 저장소와 한국어 요약 (매일 통째로 교체되는 스냅샷) |

## 로컬 미리보기

`samples/`(커밋하지 않음)에 예시 데이터를 두고 `index.html?data=samples`로 연다.
