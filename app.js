(function () {
  "use strict";

  // ?data=samples loads the local preview fixtures instead of the real data folder
  const BASE = new URLSearchParams(location.search).get("data") === "samples" ? "samples/" : "data/";
  const SRC_LABEL = { alphaxiv: "alphaXiv", hf: "HF Papers", hftrend: "HF Trending", arxiv: "arXiv", geeknews: "GeekNews", hn: "Hacker News", meta: "Meta AI", nvidia: "NVIDIA", google: "Google Research", openai: "OpenAI", anthropic: "Anthropic", deepmind: "DeepMind", github: "GitHub" };
  const HEAT_DAYS = 14;
  const MAX_DAYS = 180;
  // Per section: platforms in chip order, and how many rows show before "더보기"
  // "robotics" is not a site: it collects every paper on the robotics lane, whichever list it came from
  const PLATS = { paper: ["robotics", "alphaxiv", "hf", "hftrend", "arxiv"], news: ["geeknews", "hn", "openai", "anthropic", "deepmind", "google", "meta", "nvidia"] };
  const SHOW = { paper: 5, news: 10 };

  const S = {
    index: [], updated: null, days: new Map(), date: null, loaded: false,
    kind: "all", q: "", kw: null,
    plat: { paper: "all", news: "all" }, more: { paper: false, news: false },
    open: new Set(), broken: new Set(), marks: { read: {} },
    conf: { loaded: false, loading: false, confs: [], notes: {}, papers: [], pick: "all", year: null, winners: false },
    gh: { loaded: false, loading: false, repos: [], updated: null, period: "daily" },
  };
  const $ = (id) => document.getElementById(id);
  const CONF_ORDER = ["icra", "iros", "rss", "corl"];

  try { const k = localStorage.getItem("tr.kind"); if (["all", "paper", "news", "conf", "gh"].includes(k)) S.kind = k; } catch (e) {}
  try { const m = JSON.parse(localStorage.getItem("tr.marks") || "null"); if (m && typeof m === "object") S.marks = { read: m.read || {} }; } catch (e) {}
  function saveMarks() { try { localStorage.setItem("tr.marks", JSON.stringify(S.marks)); } catch (e) {} }

  // Helpers
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
  const str = (v) => (typeof v === "string" ? v : "");
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const fmtDate = (d) => { const [, m, dd] = d.split("-"); const wd = "일월화수목금토"[new Date(d + "T00:00:00").getDay()]; return `${m}.${dd} (${wd})`; };
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const arxivId = (i) => (typeof i.id === "string" && i.id.startsWith("p-") ? i.id.slice(2) : null);
  // Public code repository of a paper (GitHub/GitLab only), with a compact star count when known
  const codeUrl = (i) => { const u = safeUrl(i.codeUrl); return u && /^(github|gitlab)\.com$/.test(hostOf(u)) ? u : null; };
  const stars = (n) => (Number.isInteger(n) && n > 0 ? " ★" + (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : n) : "");
  // Shown beside the platform names, as one more place the paper lives
  const codeMark = (i) => { const g = codeUrl(i) && hostOf(codeUrl(i)) === "gitlab.com"; return codeUrl(i) ? el("a", { class: "src " + (g ? "gitlab" : "github"), href: codeUrl(i), target: "_blank", rel: "noopener", title: "공개된 코드 저장소", text: g ? "GitLab" : "GitHub" }) : null; };
  // Where an item lives on one of its platforms; null when the day file gives no way to tell
  function srcUrl(i, s) {
    const own = i.sourceUrls && safeUrl(i.sourceUrls[s]);
    if (own) return own;
    const aid = arxivId(i);
    if (aid) return { hf: `https://huggingface.co/papers/${aid}`, hftrend: `https://huggingface.co/papers/${aid}`, alphaxiv: `https://www.alphaxiv.org/abs/${aid}`, arxiv: `https://arxiv.org/abs/${aid}` }[s] || null;
    const id = str(i.id), d = safeUrl(i.discussUrl);
    if (s === "hn") return id.startsWith("hn-") ? "https://news.ycombinator.com/item?id=" + id.slice(3) : d && hostOf(d) === "news.ycombinator.com" ? d : null;
    if (s === "geeknews") return id.startsWith("gn-") ? "https://news.hada.io/topic?id=" + id.slice(3) : d && hostOf(d) === "news.hada.io" ? d : null;
    return safeUrl(i.url); // blogs and GitHub Trending: the post or repository itself
  }
  const srcMark = (i, s) => { const u = srcUrl(i, s); return u ? el("a", { class: "src " + s, href: u, target: "_blank", rel: "noopener", title: SRC_LABEL[s] + "에서 보기", text: SRC_LABEL[s] }) : el("span", { class: "src " + s, text: SRC_LABEL[s] }); };

  // Source timestamps: full ISO with offset, or a bare YYYY-MM-DD when the source gives only a date
  const kstDay = (t) => t.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  function postedAt(i) {
    const p = str(i.published);
    if (isDate(p)) return { dateOnly: true, day: p };
    const t = new Date(p);
    return p && !isNaN(t) ? { dateOnly: false, t } : null;
  }
  function ago(i) {
    const p = postedAt(i);
    if (!p) return null;
    if (p.dateOnly) {
      const days = Math.round((new Date(kstDay(new Date()) + "T00:00:00Z") - new Date(p.day + "T00:00:00Z")) / 864e5);
      return days <= 0 ? "오늘" : days + "일 전";
    }
    const min = Math.floor((Date.now() - p.t) / 6e4);
    if (min < 1) return "방금";
    if (min < 60) return min + "분 전";
    if (min < 60 * 24) return Math.floor(min / 60) + "시간 전";
    return Math.floor(min / 1440) + "일 전";
  }
  // "2026년 9월 30일 (수) 23:10 KST", or without the time for date-only sources
  function postedText(i) {
    const p = postedAt(i);
    if (!p) return "";
    const k = new Date(p.dateOnly ? p.day + "T00:00:00Z" : p.t.getTime() + 9 * 36e5);
    const pad = (n) => String(n).padStart(2, "0");
    const day = `${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 (${"일월화수목금토"[k.getUTCDay()]})`;
    return p.dateOnly ? day : `${day} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())} KST`;
  }

  function imageOf(i) {
    if (S.broken.has(i.id)) return null;
    const img = safeUrl(i.image);
    if (img) return img;
    const aid = arxivId(i);
    if (aid && arr(i.sources).some((s) => s === "hf" || s === "hftrend")) return `https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/${aid}.png`;
    return null;
  }

  // Data loading
  async function getJSON(path) {
    const r = await fetch(BASE + path, { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status + " " + path);
    return r.json();
  }
  async function loadDay(date) {
    if (S.days.has(date)) return S.days.get(date);
    let day;
    try {
      const d = await getJSON("days/" + date + ".json");
      day = { date, keywords: arr(d.keywords), failed: arr(d.failed), items: arr(d.items).filter((i) => i && typeof i.id === "string").map((i) => ({ ...i, date })) };
    } catch (e) {
      day = { date, keywords: [], failed: [], items: [], error: true };
    }
    S.days.set(date, day);
    return day;
  }
  async function loadDays(dates) { await Promise.all(dates.map(loadDay)); }
  const dates = () => S.index.map((d) => d.date);
  const crossDay = () => !!(S.q.trim() || S.kw);
  function loadedItems() { return [...S.days.values()].flatMap((d) => d.items); }

  // Today panel
  function renderToday() {
    const host = $("today");
    if (!S.date) { host.hidden = true; return; }
    host.hidden = false;
    const meta = S.index.find((d) => d.date === S.date) || {};
    const day = S.days.get(S.date);
    const c = meta.counts || {};
    const failed = arr(day ? day.failed : meta.failed).filter((s) => SRC_LABEL[s]);
    host.replaceChildren(...[
      el("div", { class: "head" },
        el("h2", { text: fmtDate(S.date) + " 오늘의 워드클라우드" }),
        el("div", { class: "counts" }, el("span", null, el("b", { text: c.paper ?? "–" }), "논문"), el("span", null, el("b", { text: c.news ?? "–" }), "뉴스"))),
      wordCloud(day ? day.items : []) || el("p", { class: "notice", text: "이 날짜에는 워드클라우드를 만들 키워드가 부족해요." }),
      failed.length ? el("p", { class: "failed", text: "수집 실패: " + failed.map((s) => SRC_LABEL[s]).join(", ") }) : null,
    ].filter(Boolean));
  }

  // Word cloud of the day's item keywords: size and tone follow how many items carry the word
  function wordCloud(items) {
    const counts = new Map();
    items.forEach((i) => arr(i.keywords).forEach((k) => { if (typeof k === "string" && k) counts.set(k, (counts.get(k) || 0) + 1); }));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
    if (top.length < 3) return null;
    const max = top[0][1], min = top[top.length - 1][1];
    // biggest words in the middle, smaller ones alternating outwards
    const order = [];
    top.forEach((w, n) => (n % 2 ? order.unshift(w) : order.push(w)));
    const words = order.map(([k, n]) => {
      const t = max === min ? 0.5 : (n - min) / (max - min);
      const b = el("button", { class: "word w" + Math.round(t * 3) + (S.kw === k ? " on" : ""), title: `${k} · ${n}건`, "aria-label": `${k} ${n}건`, onclick: () => setKw(k), text: k });
      b.style.fontSize = (16 + t * 26).toFixed(1) + "px";
      return b;
    });
    return el("div", { class: "cloud" }, words);
  }

  // Rows
  function brokenImage(id) { if (!S.broken.has(id)) { S.broken.add(id); renderFeed(); } }
  function markRead(id) { if (!S.marks.read[id]) { S.marks.read[id] = 1; saveMarks(); } }
  function toggleOpen(id) { if (S.open.has(id)) S.open.delete(id); else S.open.add(id); renderFeed(); }

  function lightbox(src, alt) {
    const box = el("div", { class: "lightbox", role: "dialog", "aria-label": "이미지 크게 보기", tabindex: "-1" }, el("img", { src, alt }));
    const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.append(box);
    box.focus();
  }

  function awardBadges(i) {
    const aw = arr(i.awards).filter((a) => a && typeof a.name === "string");
    aw.sort((a, b) => (b.status === "winner") - (a.status === "winner"));
    return aw.map((a) => el("span", { class: "award" + (a.status === "winner" ? " win" : ""), text: (a.status === "winner" ? "수상 · " : "후보 · ") + a.name }));
  }

  // Conference papers have no platform list, so their links are written out the same way: alphaXiv, arXiv, code, and the award announcement
  function confMarks(i) {
    const link = (cls, href, text, title) => el("a", { class: "src " + cls, href, target: "_blank", rel: "noopener", title, text });
    const aid = typeof i.arxiv === "string" && /^\d{4}\.\d{4,5}$/.test(i.arxiv) ? i.arxiv : null;
    const url = safeUrl(i.url), award = safeUrl(i.awardSource);
    const name = (S.conf.confs.find((c) => c.key === i.conf) || {}).name || str(i.conf).toUpperCase();
    return [
      aid ? link("alphaxiv", `https://www.alphaxiv.org/abs/${aid}`, "alphaXiv", "alphaXiv에서 보기") : null,
      aid ? link("arxiv", `https://arxiv.org/abs/${aid}`, "arXiv", "arXiv에서 보기") : url ? link("orig", url, "원문", "논문 원문") : null,
      codeMark(i),
      award ? link("confsrc", award, name + " award", "수상 발표 출처") : null,
    ];
  }

  // Repository numbers for the period being viewed: total stars, then stars gained in that period
  const num = (n) => (Number.isInteger(n) ? n.toLocaleString("en-US") : "");
  function repoStats(i) {
    const p = S.gh.period, g = (i.periods[p] || {}).gained, label = (PERIODS.find(([k]) => k === p) || [])[1];
    return [
      stars(i.stars) ? el("span", { class: "score", text: stars(i.stars).trim() }) : null,
      Number.isInteger(g) ? el("span", { class: "score gain", text: `${label} +${num(g)}` }) : null,
    ];
  }

  function row(i, rank) {
    const isConf = i.kind === "conf";
    const isPaper = i.kind === "paper" || isConf;
    const isRepo = i.kind === "repo";
    const url = safeUrl(i.url);
    const read = !!S.marks.read[i.id], open = S.open.has(i.id);
    const srcs = arr(i.sources).length ? arr(i.sources) : [i.source];
    const img = isPaper ? imageOf(i) : null;

    const title = el("h3", { class: "title" },
      url ? el("a", { href: url, target: "_blank", rel: "noopener", text: str(i.title), onclick: () => { markRead(i.id); setTimeout(renderFeed, 0); } }) : str(i.title),
      !isPaper && !isRepo && url ? el("span", { class: "domain", text: hostOf(url) }) : null);
    const kws = arr(i.keywords).slice(0, 3).map((k) => (typeof k === "string" ? el("button", { class: "kw", onclick: () => setKw(k), text: "#" + k }) : null));
    // Things of one kind sit together in a group; the divider is drawn only between groups
    const grp = (...kids) => { const k = kids.flat().filter(Boolean); return k.length ? el("span", { class: "grp" }, k) : null; };
    const meta = isConf
      // one line each: awards, authors, links, keywords
      ? [grp(awardBadges(i)), grp(i.authors ? el("span", { class: "authors", text: str(i.authors) }) : null), grp(confMarks(i)), grp(kws)]
          .filter(Boolean).map((g) => el("div", { class: "meta" }, g))
      : el("div", { class: "meta" },
        grp(i.venue ? el("span", { class: "venue", text: str(i.venue) }) : null),
        grp(srcs.filter((s) => SRC_LABEL[s]).map((s) => srcMark(i, s)), isPaper ? codeMark(i) : null),
        grp(isRepo ? repoStats(i) : null),
        grp(isRepo && i.language ? el("span", { class: "lang", text: str(i.language) }) : null),
        grp(ago(i) ? el("span", { class: "ago", title: postedText(i), text: ago(i) + (isRepo ? " 생성" : "") }) : null),
        grp(kws));

    const side = el("div", { class: "side" },
      img ? el("button", { class: "thumb", "aria-label": "그림 크게 보기", onclick: () => lightbox(img, str(i.title)) },
        el("img", { src: img, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: () => brokenImage(i.id) })) : null,
      el("div", { class: "tools" },
        el("button", { class: "mini", "aria-expanded": String(open), onclick: () => toggleOpen(i.id), text: open ? "접기 ▴" : "자세히 ▾" })));

    const li = el("li", { class: "row" + (read ? " read" : "") },
      el("div", { class: "row-main" },
        el("span", { class: "rank", text: isConf ? "" : (rank ?? i.rank ?? "") }),
        el("div", { class: "row-body" }, title, i.oneLine ? el("p", { class: "oneline", text: str(i.oneLine) }) : null, meta),
        side));
    if (open) li.append(detail(i, img));
    return li;
  }

  function detail(i, img) {
    const isConf = i.kind === "conf";
    const isPaper = i.kind === "paper" || isConf;
    const bullets = arr(i.bullets).filter((b) => b && typeof b.text === "string");
    const list = bullets.length ? el("ul", { class: "details" }, bullets.map((b) => b.label
      ? el("li", null, el("span", { class: "k", text: str(b.label) }), el("span", { text: b.text }))
      : el("li", { class: "plain" }, el("span", { class: "k", text: "·" }), el("span", { text: b.text })))) : null;

    // No link row here: the title opens the original and the names in the meta line open each platform's page
    const visual = isPaper && img
      ? el("figure", { class: "figure" },
          el("button", { class: "zoom", "aria-label": "그림 크게 보기", onclick: () => lightbox(img, str(i.title)) },
            el("img", { src: img, alt: str(i.title) + " 대표 그림", loading: "lazy", referrerpolicy: "no-referrer", onerror: () => brokenImage(i.id) })),
          el("figcaption", { text: (safeUrl(i.image) ? "논문 본문의 대표 Figure" : "Hugging Face 썸네일") + " · 누르면 크게 보여요" }))
      : null;
    const note = isConf && !bullets.length ? el("p", { class: "notice", text: "공개된 초록을 찾지 못해 제목만 정리했어요. 제목을 누르면 원문으로 가요." }) : null;
    const isRepo = i.kind === "repo";
    const when = !isConf && postedText(i)
      ? el("p", { class: "posted" }, el("span", { class: "k", text: isRepo ? "생성" : "게시" }), postedText(i),
          isRepo ? null : el("span", { class: "basis", text: isPaper ? "arXiv 제출 기준" : (SRC_LABEL[i.source] || "원문") + " 기준" }))
      : null;
    // Each figure in the reaction line links to the platform it was counted on
    const parts = str(i.scoreLabel).split(" · ").filter(Boolean).map((t) => {
      // points ("782P") belong to the discussion site, even when the item's main source is a company blog
      const board = ["hn", "geeknews"].includes(i.source) ? i.source : ["hn", "geeknews"].find((b) => srcsOf(i).includes(b));
      const s = /^HF\b/.test(t) ? (srcsOf(i).includes("hf") ? "hf" : "hftrend") : /^alphaXiv\b/.test(t) ? "alphaxiv" : /^arXiv\b/.test(t) ? "arxiv"
        : /^[\d,.]+k?P$/.test(t) && board ? board : i.source;
      return { text: t, cls: s, url: isConf ? null : srcUrl(i, s) };
    });
    if (isRepo) {
      // stars gained over each period the repository is trending in, then the total
      PERIODS.forEach(([p, label]) => { const g = (i.periods[p] || {}).gained; if (Number.isInteger(g)) parts.push({ text: `${label} +${num(g)}`, cls: "github", url: safeUrl(i.url) }); });
      if (stars(i.stars)) parts.push({ text: "전체" + stars(i.stars), cls: "github", url: safeUrl(i.url) });
    }
    if (isPaper && codeUrl(i) && stars(i.codeStars)) parts.push({ text: "GitHub" + stars(i.codeStars), cls: hostOf(codeUrl(i)) === "gitlab.com" ? "gitlab" : "github", url: codeUrl(i) });
    const score = parts.length ? el("p", { class: "posted" }, el("span", { class: "k", text: "반응" }),
      el("span", { class: "reacts" }, parts.map((p) => (p.url ? el("a", { class: "src " + p.cls, href: p.url, target: "_blank", rel: "noopener", text: p.text }) : el("span", { text: p.text }))))) : null;
    return el("div", { class: "detail" }, visual, list, note, when, score);
  }

  // Feed
  function filtered() {
    const q = S.q.trim().toLowerCase();
    const pool = crossDay() ? loadedItems() : ((S.days.get(S.date) || {}).items || []);
    return pool.filter((i) => {
      if (S.kind === "paper" && i.kind !== "paper") return false;
      if (S.kind === "news" && i.kind === "paper") return false;
      if (S.kw && !arr(i.keywords).includes(S.kw)) return false;
      if (q) {
        const hay = [i.title, i.oneLine, i.venue, ...arr(i.keywords), ...arr(i.bullets).map((b) => b && b.text)].map(str).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || (a.rank || 99) - (b.rank || 99));
  }

  const srcsOf = (i) => (arr(i.sources).length ? arr(i.sources) : [i.source]);
  // Position of an item on one platform (or overall); older days without per-platform ranks fall back to the overall rank
  const inPlat = (i, p) => (p === "robotics" ? i.lane === "robotics" : srcsOf(i).includes(p));
  const platLabel = (p) => (p === "robotics" ? "로보틱스" : SRC_LABEL[p] || p);
  function rankIn(i, plat) {
    if (plat === "all" || plat === "robotics") return i.rank || 999;
    const r = i.ranks && i.ranks[plat];
    return Number.isInteger(r) ? r : 1000 + (i.rank || 999);
  }

  function section(kind, label, unit, all, emptyText) {
    const plat = S.plat[kind];
    const present = PLATS[kind].filter((p) => p === plat || all.some((i) => inPlat(i, p)));
    const count = (p) => all.filter((i) => inPlat(i, p)).length;
    const pick = (p) => { S.plat[kind] = p; S.more[kind] = false; renderFeed(); };
    const chips = present.length ? el("div", { class: "chips platbar", role: "group", "aria-label": label + " 플랫폼" },
      el("button", { class: "chip", "aria-pressed": String(plat === "all"), onclick: () => pick("all") }, "전체", el("span", { class: "cnt", text: all.length })),
      present.map((p) => el("button", { class: "chip pf " + p, "aria-pressed": String(plat === p), onclick: () => pick(p) }, platLabel(p), el("span", { class: "cnt", text: count(p) })))) : null;

    const list = (plat === "all" ? all : all.filter((i) => inPlat(i, plat)))
      .slice().sort((a, b) => b.date.localeCompare(a.date) || rankIn(a, plat) - rankIn(b, plat));
    const head = el("h2", { class: "section-head" }, el("span", { text: label }), el("span", { text: list.length ? list.length + unit : "" }));
    if (!list.length) return el("section", { class: "section" }, head, chips, el("div", { class: "empty" }, el("span", { text: plat === "all" ? emptyText : `이 날짜에는 ${platLabel(plat)} 항목이 없어요.` })));

    // Single day: show the top SHOW rows, the rest behind "더보기". Search/keyword views list every match by date.
    if (!crossDay()) {
      const cap = SHOW[kind], open = S.more[kind];
      const shown = open ? list : list.slice(0, cap);
      const more = list.length > cap
        ? el("button", { class: "more", "aria-expanded": String(open), onclick: () => { S.more[kind] = !open; renderFeed(); } },
            open ? "접기 ▴" : `더보기 · ${list.length - cap}${unit} 더 ▾`)
        : null;
      return el("section", { class: "section" }, head, chips, el("ol", { class: "list" }, shown.map((i, n) => row(i, n + 1))), more);
    }
    const multiDay = new Set(list.map((i) => i.date)).size > 1;
    const out = []; let ul = null, last = null, n = 0;
    list.forEach((i) => {
      if (!ul || (multiDay && i.date !== last)) {
        if (multiDay) out.push(el("div", { class: "daylabel", text: fmtDate(i.date) }));
        ul = el("ol", { class: "list" }); out.push(ul); last = i.date; n = 0;
      }
      ul.append(row(i, ++n));
    });
    return el("section", { class: "section" }, head, chips, out);
  }

  // Conference tab: award winners and finalists, loaded once from data/conferences/
  async function loadConf() {
    const C = S.conf;
    C.loading = true;
    try {
      const idx = await getJSON("conferences/index.json");
      C.confs = arr(idx.confs).filter((c) => c && typeof c.key === "string");
      C.notes = idx.notes && typeof idx.notes === "object" ? idx.notes : {};
      const files = await Promise.all(C.confs.map((c) => getJSON("conferences/" + c.key + ".json").catch(() => ({ papers: [] }))));
      C.papers = files.flatMap((f, n) => arr(f.papers).filter((p) => p && typeof p.id === "string" && typeof p.title === "string")
        .map((p) => ({ ...p, kind: "conf", conf: C.confs[n].key, date: "" })));
    } catch (e) {
      C.error = true;
    }
    // Open on the most recent year; the full list is one click away and much heavier to render
    if (C.year === null) C.year = Math.max(...C.papers.map((p) => p.year).filter(Number.isInteger), 0) || "all";
    C.loaded = true; C.loading = false;
    renderFeed();
  }

  function renderConf() {
    const feed = $("feed"), C = S.conf;
    if (!C.loaded) {
      if (!C.loading) loadConf();
      feed.replaceChildren(el("div", { class: "empty" }, el("span", { text: "불러오는 중…" })));
      return;
    }
    if (C.error || !C.papers.length) {
      feed.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "학회 수상 논문을 불러오지 못했어요" }), el("span", { text: "잠시 후 새로고침해 주세요." })));
      return;
    }
    const name = (k) => (C.confs.find((c) => c.key === k) || {}).name || k.toUpperCase();
    const years = [...new Set(C.papers.map((p) => p.year))].filter(Number.isInteger).sort((a, b) => b - a);
    const chip = (on, label, fn) => el("button", { class: "chip", "aria-pressed": String(on), onclick: fn, text: label });
    const bar = el("div", { class: "confbar" },
      el("div", { class: "chips" }, chip(C.pick === "all", "전체 학회", () => { C.pick = "all"; renderFeed(); }),
        CONF_ORDER.filter((k) => C.confs.some((c) => c.key === k)).map((k) => chip(C.pick === k, name(k), () => { C.pick = k; renderFeed(); }))),
      el("div", { class: "chips" }, chip(C.year === "all", "전체 연도", () => { C.year = "all"; renderFeed(); }),
        years.map((y) => chip(C.year === y, String(y), () => { C.year = y; renderFeed(); })),
        el("button", { class: "toggle", "aria-pressed": String(C.winners), onclick: () => { C.winners = !C.winners; renderFeed(); }, text: "수상작만" })));

    const q = S.q.trim().toLowerCase();
    const list = C.papers.filter((p) => {
      if (C.pick !== "all" && p.conf !== C.pick) return false;
      if (C.year !== "all" && p.year !== C.year) return false;
      if (C.winners && !arr(p.awards).some((a) => a && a.status === "winner")) return false;
      if (S.kw && !arr(p.keywords).includes(S.kw)) return false;
      if (q) {
        const hay = [p.title, p.oneLine, p.authors, ...arr(p.keywords), ...arr(p.awards).map((a) => a && a.name), ...arr(p.bullets).map((b) => b && b.text)].map(str).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const wins = (p) => arr(p.awards).some((a) => a && a.status === "winner");
    const groups = new Map();
    CONF_ORDER.forEach((k) => years.forEach((y) => groups.set(k + "-" + y, [])));
    list.forEach((p) => { const g = p.conf + "-" + p.year; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); });
    const out = [bar];
    const byYear = [...groups.entries()].filter(([, ps]) => ps.length).sort((a, b) => Number(b[0].split("-")[1]) - Number(a[0].split("-")[1]) || CONF_ORDER.indexOf(a[0].split("-")[0]) - CONF_ORDER.indexOf(b[0].split("-")[0]));
    byYear.forEach(([g, ps]) => {
      const [k, y] = g.split("-");
      ps.sort((a, b) => wins(b) - wins(a) || str((arr(a.awards)[0] || {}).name).localeCompare(str((arr(b.awards)[0] || {}).name)) || a.title.localeCompare(b.title));
      const w = ps.filter(wins).length;
      const note = C.notes[g];
      out.push(el("section", { class: "section" },
        el("h2", { class: "section-head" }, el("span", { text: name(k) + " " + y }), el("span", { text: `수상 ${w} · 후보 ${ps.length - w}` })),
        note ? el("p", { class: "confnote", text: note }) : null,
        el("ol", { class: "list" }, ps.map(row))));
    });
    if (out.length === 1) out.push(el("div", { class: "empty" }, el("span", { text: "조건에 맞는 논문이 없어요." })));
    feed.replaceChildren(...out);
  }

  // GitHub tab: a dashboard of the current trending AI/ML repositories (a snapshot replaced every day, not a daily archive)
  const PERIODS = [["daily", "오늘"], ["weekly", "이번 주"], ["monthly", "이번 달"]];
  async function loadGh() {
    const G = S.gh;
    G.loading = true;
    try {
      const d = await getJSON("github/trending.json");
      G.updated = d.updated || null;
      G.repos = arr(d.repos).filter((r) => r && typeof r.id === "string" && typeof r.repo === "string" && r.periods && typeof r.periods === "object")
        .map((r) => ({ ...r, kind: "repo", source: "github", sources: ["github"], title: r.repo, published: r.created, date: "",
          bullets: arr(r.bullets).filter((t) => typeof t === "string").map((t) => ({ label: "", text: t })) }));
    } catch (e) {
      G.error = true;
    }
    G.loaded = true; G.loading = false;
    renderFeed();
  }

  function renderGh() {
    const feed = $("feed"), G = S.gh;
    if (!G.loaded) {
      if (!G.loading) loadGh();
      feed.replaceChildren(el("div", { class: "empty" }, el("span", { text: "불러오는 중…" })));
      return;
    }
    if (G.error || !G.repos.length) {
      feed.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "GitHub 트렌딩을 불러오지 못했어요" }), el("span", { text: "잠시 후 새로고침해 주세요." })));
      return;
    }
    const inPeriod = (p) => G.repos.filter((r) => r.periods[p] && Number.isInteger(r.periods[p].rank));
    const t = G.updated ? new Date(G.updated) : null;
    const bar = el("div", { class: "confbar" },
      el("div", { class: "chips" }, PERIODS.map(([p, label]) =>
        el("button", { class: "chip", "aria-pressed": String(G.period === p), onclick: () => { G.period = p; renderFeed(); } }, label, el("span", { class: "cnt", text: inPeriod(p).length })))),
      el("p", { class: "confnote", text: "github.com/trending 의 AI/ML 저장소를 매일 아침 새로 가져와요." + (t && !isNaN(t) ? " 마지막 갱신 " + t.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "") }));

    const q = S.q.trim().toLowerCase();
    const list = inPeriod(G.period).filter((r) => {
      if (S.kw && !arr(r.keywords).includes(S.kw)) return false;
      if (q) {
        const hay = [r.repo, r.description, r.oneLine, r.language, ...arr(r.keywords), ...r.bullets.map((b) => b.text)].map(str).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => a.periods[G.period].rank - b.periods[G.period].rank);
    const label = (PERIODS.find(([p]) => p === G.period) || [])[1];
    feed.replaceChildren(bar, el("section", { class: "section" },
      el("h2", { class: "section-head" }, el("span", { text: "GitHub " + label }), el("span", { text: list.length ? list.length + "개" : "" })),
      list.length ? el("ol", { class: "list" }, list.map((r) => row(r, r.periods[G.period].rank)))
        : el("div", { class: "empty" }, el("span", { text: "조건에 맞는 저장소가 없어요." }))));
  }

  function renderFeed() {
    if (S.kind === "conf") return renderConf();
    if (S.kind === "gh") return renderGh();
    const feed = $("feed");
    if (!S.loaded) { feed.replaceChildren(el("div", { class: "empty" }, el("span", { text: "불러오는 중…" }))); return; }
    if (!S.index.length) {
      feed.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "아직 수집된 항목이 없어요" }), el("span", { text: "매일 새벽(KST)에 논문과 뉴스가 자동으로 채워져요." })));
      return;
    }
    const list = filtered();
    const papers = list.filter((i) => i.kind === "paper"), news = list.filter((i) => i.kind !== "paper");
    const out = [];
    if (S.kind !== "news") out.push(section("paper", "논문", "편", papers, "조건에 맞는 논문이 없어요."));
    if (S.kind !== "paper") out.push(section("news", "뉴스", "건", news, "조건에 맞는 뉴스가 없어요."));
    feed.replaceChildren(...out);
  }

  // Heatmap: rows = top keywords over the last 14 days, cols = dates (oldest → newest)
  function renderHeat() {
    const ds = dates().slice(0, HEAT_DAYS).reverse();
    const heat = $("heat");
    const counts = {};
    ds.forEach((d) => arr((S.days.get(d) || {}).items).forEach((i) => arr(i.keywords).forEach((k) => {
      if (typeof k !== "string") return;
      (counts[k] ||= {})[d] = (counts[k][d] || 0) + 1;
    })));
    const top = Object.entries(counts).map(([k, v]) => [k, Object.values(v).reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
    heat.style.setProperty("--cols", Math.max(ds.length, 1));
    if (!top.length) { heat.replaceChildren(el("p", { class: "notice", text: S.loaded ? "데이터가 쌓이면 키워드별 등장 횟수가 날짜별로 표시돼요." : "불러오는 중…" })); return; }
    const max = Math.max(...top.flatMap((k) => ds.map((d) => counts[k][d] || 0)));
    const lvl = (n) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
    const rows = top.map((k) => el("div", { class: "hrow" },
      el("button", { class: "lab" + (S.kw === k ? " on" : ""), title: k, onclick: () => setKw(k), text: k }),
      ds.map((d) => {
        const n = counts[k][d] || 0;
        const c = el("button", { class: "cell" + (d === S.date && !crossDay() ? " sel" : ""), title: `${k} · ${fmtDate(d)} · ${n}건`, "aria-label": `${k} ${fmtDate(d)} ${n}건`, onclick: () => goDate(d) });
        c.style.background = `var(--heat-${lvl(n)})`;
        return c;
      })));
    const axis = el("div", { class: "hrow" }, el("span"), ds.map((d, i) => el("span", { class: "axis", text: i === 0 || i === ds.length - 1 || ds.length <= 7 ? d.slice(8) : "" })));
    heat.replaceChildren(...rows, axis);
  }

  function renderDates() {
    const sel = $("dateSel"), ds = dates();
    sel.replaceChildren(...ds.map((d, i) => el("option", { value: d, text: fmtDate(d) + (i === 0 ? " · 최신" : "") })));
    sel.disabled = !ds.length;
    if (S.date) sel.value = S.date;
    const idx = ds.indexOf(S.date);
    $("prevDay").disabled = idx < 0 || idx === ds.length - 1;
    $("nextDay").disabled = idx <= 0;
  }

  function renderToolbar() {
    document.querySelectorAll("#kindSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === S.kind)));
    const kf = $("kwFilter"); kf.hidden = !S.kw; kf.textContent = S.kw ? "#" + S.kw + "  ✕" : "";
  }

  function renderStatus() {
    if (!S.updated) { $("status").textContent = ""; return; }
    const t = new Date(S.updated);
    $("status").textContent = isNaN(t) ? "" : "마지막 업데이트 " + t.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function render() {
    document.body.classList.toggle("conf-mode", S.kind === "conf" || S.kind === "gh"); // dashboards: no date bar, word cloud or heatmap
    renderDates(); renderToday(); renderToolbar(); renderFeed(); renderHeat(); renderStatus();
  }

  // Navigation and filters
  async function goDate(d) {
    if (!dates().includes(d)) return;
    S.date = d; S.kw = null; S.q = ""; $("q").value = "";
    S.more = { paper: false, news: false };
    if (location.hash !== "#" + d) history.replaceState(null, "", "#" + d);
    await loadDay(d);
    render();
  }
  async function ensureCrossDay() { if (S.kind !== "conf" && S.kind !== "gh" && crossDay()) { await loadDays(dates().slice(0, MAX_DAYS)); } render(); }
  function setKw(k) { S.kw = S.kw === k ? null : k; ensureCrossDay(); }

  // Theme: one button cycles 자동 → 화이트 → 다크. "system" follows the OS setting (no data-theme attribute); light/dark are explicit overrides
  const THEMES = { system: "◐ 자동", light: "☀ 화이트", dark: "☾ 다크" };
  const NEXT_THEME = { system: "light", light: "dark", dark: "system" };
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const btn = $("themeBtn");
    btn.textContent = THEMES[t];
    btn.setAttribute("aria-label", "화면 모드: " + THEMES[t].slice(2));
    btn.title = t === "system" ? "컴퓨터 설정을 따라가는 중 · 눌러서 바꾸기" : "눌러서 바꾸기";
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      const dark = m.media.includes("dark");
      if (t === "system") m.media = dark ? "(prefers-color-scheme: dark)" : "(prefers-color-scheme: light)";
      else m.media = (t === "dark") === dark ? "all" : "not all";
    });
  }
  let theme = "system";
  try { const t = localStorage.getItem("tr.theme"); if (t === "light" || t === "dark") theme = t; } catch (e) {}
  applyTheme(theme);
  $("themeBtn").addEventListener("click", () => { theme = NEXT_THEME[theme]; applyTheme(theme); try { localStorage.setItem("tr.theme", theme); } catch (x) {} });

  $("dateSel").addEventListener("change", (e) => goDate(e.target.value));
  $("prevDay").addEventListener("click", () => { const d = dates(), i = d.indexOf(S.date); if (i < d.length - 1) goDate(d[i + 1]); });
  $("nextDay").addEventListener("click", () => { const d = dates(), i = d.indexOf(S.date); if (i > 0) goDate(d[i - 1]); });
  $("kindSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.kind = b.dataset.k; S.kw = null; try { localStorage.setItem("tr.kind", S.kind); } catch (x) {} ensureCrossDay(); });
  $("kwFilter").addEventListener("click", () => { S.kw = null; render(); });
  let qt; $("q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; ensureCrossDay(); }, 200); });
  window.addEventListener("hashchange", () => { const d = location.hash.slice(1); if (isDate(d) && d !== S.date) goDate(d); });

  // Boot
  render();
  (async () => {
    try {
      const idx = await getJSON("index.json");
      S.index = arr(idx.days).filter((d) => d && isDate(d.date)).sort((a, b) => b.date.localeCompare(a.date));
      S.updated = idx.updated || null;
    } catch (e) {
      S.index = [];
      $("status").textContent = "데이터를 불러오지 못했어요. 잠시 후 새로고침해 주세요.";
    }
    const want = location.hash.slice(1);
    S.date = dates().includes(want) ? want : dates()[0] || null;
    if (S.date) await loadDay(S.date);
    S.loaded = true;
    render();
    await loadDays(dates().slice(0, HEAT_DAYS));
    renderHeat();
  })();
})();
