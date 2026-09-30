(function () {
  "use strict";

  // ?data=samples loads the local preview fixtures instead of the real data folder
  const BASE = new URLSearchParams(location.search).get("data") === "samples" ? "samples/" : "data/";
  const SRC_LABEL = { alphaxiv: "alphaXiv", hf: "HF Papers", arxiv: "arXiv", geeknews: "GeekNews", hn: "Hacker News", meta: "Meta AI", nvidia: "NVIDIA", google: "Google Research" };
  const HEAT_DAYS = 14;
  const MAX_DAYS = 180;

  const S = {
    index: [], updated: null, days: new Map(), date: null, loaded: false,
    kind: "all", star: false, unread: false, q: "", kw: null,
    open: new Set(), broken: new Set(), marks: { read: {}, star: {} },
  };
  const $ = (id) => document.getElementById(id);

  try { const k = localStorage.getItem("tr.kind"); if (k === "all" || k === "paper" || k === "news") S.kind = k; } catch (e) {}
  try { const m = JSON.parse(localStorage.getItem("tr.marks") || "null"); if (m && typeof m === "object") S.marks = { read: m.read || {}, star: m.star || {} }; } catch (e) {}
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

  function imageOf(i) {
    if (S.broken.has(i.id)) return null;
    const img = safeUrl(i.image);
    if (img) return img;
    const aid = arxivId(i);
    if (aid && arr(i.sources).includes("hf")) return `https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/${aid}.png`;
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
  const crossDay = () => !!(S.q.trim() || S.kw || S.star);
  function loadedItems() { return [...S.days.values()].flatMap((d) => d.items); }

  // Today panel
  function renderToday() {
    const host = $("today");
    if (!S.date) { host.hidden = true; return; }
    host.hidden = false;
    const meta = S.index.find((d) => d.date === S.date) || {};
    const day = S.days.get(S.date);
    const c = meta.counts || {};
    const kws = arr((day && day.keywords.length ? day.keywords : meta.keywords));
    const failed = arr(day ? day.failed : meta.failed).filter((s) => SRC_LABEL[s]);
    host.replaceChildren(...[
      el("div", { class: "head" },
        el("h2", { text: fmtDate(S.date) + " 오늘의 키워드" }),
        el("div", { class: "counts" }, el("span", null, el("b", { text: c.paper ?? "–" }), "논문"), el("span", null, el("b", { text: c.news ?? "–" }), "뉴스"))),
      kws.length
        ? el("ul", { class: "kwlist" }, kws.slice(0, 5).map((k) => el("li", null,
            el("button", { class: "term" + (S.kw === str(k.term) ? " on" : ""), onclick: () => setKw(str(k.term)), text: str(k.term) }),
            el("span", { class: "note", text: str(k.note) }))))
        : el("p", { class: "notice", text: "이 날짜의 키워드 요약이 없어요." }),
      failed.length ? el("p", { class: "failed", text: "수집 실패: " + failed.map((s) => SRC_LABEL[s]).join(", ") }) : null,
    ].filter(Boolean));
  }

  // Rows
  function flowFigure(steps) {
    const s = arr(steps).filter((x) => typeof x === "string").slice(0, 5);
    if (s.length < 2) return null;
    const arrow = () => { const a = el("span", { class: "arrow", "aria-hidden": "true" }); a.innerHTML = '<svg viewBox="0 0 14 14"><path d="M2 7h9M8 3.5 11.5 7 8 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; return a; };
    const flow = el("div", { class: "flow" });
    s.forEach((t, i) => { if (i) flow.append(arrow()); flow.append(el("div", { class: "step" + (i === s.length - 1 ? " last" : "") }, el("span", { class: "n", text: i === s.length - 1 ? "OUTPUT" : "STEP " + (i + 1) }), t)); });
    return el("figure", { class: "fig" }, flow, el("figcaption", { text: "방법 흐름 · 초록을 바탕으로 Claude가 정리한 도식" }));
  }

  function brokenImage(id) { if (!S.broken.has(id)) { S.broken.add(id); renderFeed(); } }
  function markRead(id) { if (!S.marks.read[id]) { S.marks.read[id] = 1; saveMarks(); } }
  function toggleStar(id) { if (S.marks.star[id]) delete S.marks.star[id]; else S.marks.star[id] = 1; saveMarks(); renderFeed(); }
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

  function row(i) {
    const isPaper = i.kind === "paper";
    const url = safeUrl(i.url);
    const read = !!S.marks.read[i.id], star = !!S.marks.star[i.id], open = S.open.has(i.id);
    const srcs = arr(i.sources).length ? arr(i.sources) : [i.source];
    const img = isPaper ? imageOf(i) : null;

    const title = el("h3", { class: "title" },
      url ? el("a", { href: url, target: "_blank", rel: "noopener", text: str(i.title), onclick: () => { markRead(i.id); setTimeout(renderFeed, 0); } }) : str(i.title),
      !isPaper && url ? el("span", { class: "domain", text: hostOf(url) }) : null);
    const meta = el("div", { class: "meta" },
      i.venue ? el("span", { class: "venue", text: str(i.venue) }) : null,
      srcs.filter((s) => SRC_LABEL[s]).map((s) => el("span", { class: "src " + s, text: SRC_LABEL[s] })),
      i.scoreLabel ? el("span", { class: "score", text: str(i.scoreLabel) }) : null,
      arr(i.keywords).slice(0, 3).map((k) => (typeof k === "string" ? el("button", { class: "kw", onclick: () => setKw(k), text: "#" + k }) : null)));

    const side = el("div", { class: "side" },
      img ? el("button", { class: "thumb", "aria-label": "그림 크게 보기", onclick: () => lightbox(img, str(i.title)) },
        el("img", { src: img, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: () => brokenImage(i.id) })) : null,
      el("div", { class: "tools" },
        el("button", { class: "mini star", "aria-pressed": String(star), "aria-label": "별표", onclick: () => toggleStar(i.id), text: star ? "★" : "☆" }),
        el("button", { class: "mini", "aria-expanded": String(open), onclick: () => toggleOpen(i.id), text: open ? "접기 ▴" : "자세히 ▾" })));

    const li = el("li", { class: "row" + (read ? " read" : "") },
      el("div", { class: "row-main" },
        el("span", { class: "rank", text: i.rank ?? "" }),
        el("div", { class: "row-body" }, title, i.oneLine ? el("p", { class: "oneline", text: str(i.oneLine) }) : null, meta),
        side));
    if (open) li.append(detail(i, img));
    return li;
  }

  function detail(i, img) {
    const isPaper = i.kind === "paper";
    const url = safeUrl(i.url);
    const bullets = arr(i.bullets).filter((b) => b && typeof b.text === "string");
    const list = bullets.length ? el("ul", { class: "details" }, bullets.map((b) => b.label
      ? el("li", null, el("span", { class: "k", text: str(b.label) }), el("span", { text: b.text }))
      : el("li", { class: "plain" }, el("span", { class: "k", text: "·" }), el("span", { text: b.text })))) : null;

    const links = [];
    if (isPaper) {
      const fig = safeUrl(i.figureUrl), alt = safeUrl(i.altUrl);
      if (fig) links.push(el("a", { class: "btn primary", href: fig, target: "_blank", rel: "noopener", text: "원문 Figure 전체" }));
      if (alt) links.push(el("a", { class: "btn", href: alt, target: "_blank", rel: "noopener", text: "alphaXiv" }));
      if (url) links.push(el("a", { class: "btn", href: url, target: "_blank", rel: "noopener", text: "arXiv" }));
    } else {
      if (url) links.push(el("a", { class: "btn", href: url, target: "_blank", rel: "noopener", text: "원문" }));
      const d = safeUrl(i.discussUrl);
      if (d) links.push(el("a", { class: "btn", href: d, target: "_blank", rel: "noopener", text: i.source === "hn" ? "HN 토론" : i.source === "geeknews" ? "GeekNews 글" : "토론" }));
    }

    let visual = null;
    if (isPaper) {
      visual = img
        ? el("figure", { class: "figure" },
            el("img", { src: img, alt: str(i.title) + " 대표 그림", loading: "lazy", referrerpolicy: "no-referrer", onerror: () => brokenImage(i.id) }),
            el("figcaption", { text: safeUrl(i.image) ? "논문 본문의 대표 Figure" : "Hugging Face 썸네일" }))
        : flowFigure(i.flow);
    }
    return el("div", { class: "detail" }, visual, list, links.length ? el("div", { class: "links" }, links) : null);
  }

  // Feed
  function filtered() {
    const q = S.q.trim().toLowerCase();
    const pool = crossDay() ? loadedItems() : ((S.days.get(S.date) || {}).items || []);
    return pool.filter((i) => {
      if (S.kind === "paper" && i.kind !== "paper") return false;
      if (S.kind === "news" && i.kind === "paper") return false;
      if (S.star && !S.marks.star[i.id]) return false;
      if (S.unread && S.marks.read[i.id]) return false;
      if (S.kw && !arr(i.keywords).includes(S.kw)) return false;
      if (q) {
        const hay = [i.title, i.oneLine, i.venue, ...arr(i.keywords), ...arr(i.bullets).map((b) => b && b.text)].map(str).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || (a.rank || 99) - (b.rank || 99));
  }

  function section(label, unit, list, emptyText) {
    const head = el("h2", { class: "section-head" }, el("span", { text: label }), el("span", { text: list.length ? list.length + unit : "" }));
    if (!list.length) return el("section", { class: "section" }, head, el("div", { class: "empty" }, el("span", { text: emptyText })));
    const multiDay = new Set(list.map((i) => i.date)).size > 1;
    const out = []; let ul = null, last = null;
    list.forEach((i) => {
      if (!ul || (multiDay && i.date !== last)) {
        if (multiDay) out.push(el("div", { class: "daylabel", text: fmtDate(i.date) }));
        ul = el("ol", { class: "list" }); out.push(ul); last = i.date;
      }
      ul.append(row(i));
    });
    return el("section", { class: "section" }, head, out);
  }

  function renderFeed() {
    const feed = $("feed");
    if (!S.loaded) { feed.replaceChildren(el("div", { class: "empty" }, el("span", { text: "불러오는 중…" }))); return; }
    if (!S.index.length) {
      feed.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "아직 수집된 항목이 없어요" }), el("span", { text: "매일 오전 8시(KST)에 논문과 뉴스가 자동으로 채워져요." })));
      return;
    }
    const list = filtered();
    const papers = list.filter((i) => i.kind === "paper"), news = list.filter((i) => i.kind !== "paper");
    const out = [];
    if (S.kind !== "news") out.push(section("논문", "편", papers, "조건에 맞는 논문이 없어요."));
    if (S.kind !== "paper") out.push(section("뉴스", "건", news, "조건에 맞는 뉴스가 없어요."));
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
    $("starOnly").setAttribute("aria-pressed", String(S.star));
    $("unreadOnly").setAttribute("aria-pressed", String(S.unread));
    const kf = $("kwFilter"); kf.hidden = !S.kw; kf.textContent = S.kw ? "#" + S.kw + "  ✕" : "";
  }

  function renderStatus() {
    if (!S.updated) { $("status").textContent = ""; return; }
    const t = new Date(S.updated);
    $("status").textContent = isNaN(t) ? "" : "마지막 업데이트 " + t.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function render() { renderDates(); renderToday(); renderToolbar(); renderFeed(); renderHeat(); renderStatus(); }

  // Navigation and filters
  async function goDate(d) {
    if (!dates().includes(d)) return;
    S.date = d; S.kw = null; S.q = ""; S.star = false; $("q").value = "";
    if (location.hash !== "#" + d) history.replaceState(null, "", "#" + d);
    await loadDay(d);
    render();
  }
  async function ensureCrossDay() { if (crossDay()) { await loadDays(dates().slice(0, MAX_DAYS)); } render(); }
  function setKw(k) { S.kw = S.kw === k ? null : k; ensureCrossDay(); }

  $("dateSel").addEventListener("change", (e) => goDate(e.target.value));
  $("prevDay").addEventListener("click", () => { const d = dates(), i = d.indexOf(S.date); if (i < d.length - 1) goDate(d[i + 1]); });
  $("nextDay").addEventListener("click", () => { const d = dates(), i = d.indexOf(S.date); if (i > 0) goDate(d[i - 1]); });
  $("kindSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.kind = b.dataset.k; try { localStorage.setItem("tr.kind", S.kind); } catch (x) {} render(); });
  $("starOnly").addEventListener("click", () => { S.star = !S.star; ensureCrossDay(); });
  $("unreadOnly").addEventListener("click", () => { S.unread = !S.unread; render(); });
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
