import { lineChart, columnChart, calibrationChart, legend, seriesColor } from "./charts.js";

// ------------------------------------------------------------------ utils

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $("#app");
const cache = new Map();

async function api(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(`/api${path}`).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`);
    return r.json();
  });
  cache.set(path, p);
  p.catch(() => cache.delete(path));
  return p;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = {
  int: (v) => v == null ? "–" : Math.round(v).toLocaleString("en-GB"),
  dec: (v, d = 2) => v == null ? "–" : (+v).toFixed(d),
  pct: (v, d = 0) => v == null ? "–" : `${(v * 100).toFixed(d)}%`,
  eur: (v) => {
    if (v == null) return "–";
    const a = Math.abs(v);
    if (a >= 1e9) return `€${(v / 1e9).toFixed(2)}bn`;
    if (a >= 1e6) return `€${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
    if (a >= 1e3) return `€${Math.round(v / 1e3)}k`;
    return `€${v}`;
  },
  season: (s) => `${s}/${String(s + 1).slice(-2)}`,
  date: (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–",
  dateShort: (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
};
const initials = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const crest = (code) => `<span class="crest" aria-hidden="true">${esc(code ?? "")}</span>`;
const club = (id, name, code) => `<a class="club-chip" href="#/team/${id}">${crest(code)}<span>${esc(name)}</span></a>`;
const formPills = (f) => `<span class="form">${(f ?? []).map((r) => `<i class="${r}">${r}</i>`).join("")}</span>`;
const info = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4.2M8 4.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function params() {
  const [path, qs = ""] = location.hash.slice(1).split("?");
  return { path: path || "/", q: new URLSearchParams(qs) };
}
function setQuery(updates) {
  const { path, q } = params();
  for (const [k, v] of Object.entries(updates)) (v === "" || v == null) ? q.delete(k) : q.set(k, v);
  const s = q.toString();
  history.replaceState(null, "", `#${path}${s ? `?${s}` : ""}`);
}

function skeleton(n = 3) {
  app.innerHTML = `<div class="view stack"><div class="skeleton" style="height:64px;max-width:420px"></div>
    <div class="grid g-${n}">${'<div class="skeleton"></div>'.repeat(n)}</div><div class="skeleton" style="min-height:300px"></div></div>`;
}

// Critically damped spring (damping 1.0). Starts from the live value and
// carries velocity through re-targets, so it can be interrupted any time.
function spring(get, set, { response = 0.35 } = {}) {
  let target = get(), v = 0, raf = 0, last = 0;
  const w = (2 * Math.PI) / response;
  const step = (t) => {
    const dt = Math.min(0.032, (t - last) / 1000 || 0.016); last = t;
    const x = get();
    const a = -w * w * (x - target) - 2 * w * v;
    v += a * dt;
    const nx = x + v * dt;
    if (Math.abs(nx - target) < 0.05 && Math.abs(v) < 0.5) { set(target); v = 0; raf = 0; return; }
    set(nx);
    raf = requestAnimationFrame(step);
  };
  return (to) => {
    target = to;
    if (reduceMotion.matches) { set(to); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
  };
}

/** Segmented control with a spring-driven thumb. */
function segmented(container, options, value, onChange) {
  container.classList.add("seg");
  container.setAttribute("role", "radiogroup");
  container.innerHTML = `<span class="thumb"></span>` + options.map(([v, l]) =>
    `<button type="button" role="radio" data-v="${esc(v)}" aria-checked="${v === value}" class="${v === value ? "on" : ""}">${esc(l)}</button>`).join("");
  const thumb = $(".thumb", container);
  let x = 0, w = 0;
  const apply = () => { thumb.style.transform = `translateX(${x}px)`; thumb.style.width = `${w}px`; };
  const sx = spring(() => x, (n) => { x = n; apply(); });
  const sw = spring(() => w, (n) => { w = n; apply(); });
  const place = (btn, animate) => {
    if (!animate) { x = btn.offsetLeft; w = btn.offsetWidth; apply(); return; }
    sx(btn.offsetLeft); sw(btn.offsetWidth);
  };
  const btns = $$("button", container);
  requestAnimationFrame(() => place(btns.find((b) => b.dataset.v === value) ?? btns[0], false));
  container.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    btns.forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    place(b, true);
    onChange(b.dataset.v);
  });
}

function seasonSelect(seasons, value, id = "season") {
  return `<label class="field"><span>Season</span><select class="select" id="${id}">${seasons.map((s) =>
    `<option value="${s}" ${s === value ? "selected" : ""}>${fmt.season(s)}</option>`).join("")}</select></label>`;
}

let META;
const meta = async () => (META ??= await api("/meta"));

// ------------------------------------------------------------------ views

const views = {};

views["/"] = async ({ q }) => {
  const m = await meta();
  const season = +(q.get("season") ?? m.last_season);
  const d = await api(`/overview?season=${season}`);
  const champ = d.table[0];
  const t = d.totals;
  app.innerHTML = `<div class="view stack">
    <div class="page-head">
      <div><p class="eyebrow">Premier League · ${fmt.season(season)}</p>
        <h1>Season overview</h1>
        <p class="sub">${m.counts.matches.toLocaleString()} matches, ${m.counts.players.toLocaleString()} players and ${m.counts.valuations.toLocaleString()} market valuations from ${fmt.season(m.first_season)} to ${fmt.season(m.last_season)}. Data runs to ${fmt.date(m.data_cutoff)}.</p></div>
      <div class="controls">${seasonSelect(m.seasons, season)}</div>
    </div>
    <div class="grid g-4">
      <a class="card tile press" href="#/team/${champ.club_id}?season=${season}"><div class="label">Champions</div><div class="value">${esc(champ.name)}</div><div class="note">${champ.points} pts · ${champ.won}W ${champ.drawn}D ${champ.lost}L</div></a>
      <div class="card tile"><div class="label">Goals per match</div><div class="value">${fmt.dec(t.goals_per_match)}</div><div class="note">${fmt.int(t.goals)} goals in ${t.matches} matches</div></div>
      <div class="card tile"><div class="label">Home win rate</div><div class="value">${fmt.pct(t.home_win)}</div><div class="note">Draw ${fmt.pct(t.draw)} · Away ${fmt.pct(t.away_win)}</div></div>
      <div class="card tile"><div class="label">Average attendance</div><div class="value">${fmt.int(t.attendance)}</div><div class="note">Recorded attendances only</div></div>
    </div>
    <div class="grid g-main">
      <section class="card flush"><div class="card-head"><div><h2>League table</h2><p>Computed from results. Blue marks the top four, orange the bottom three.</p></div></div>
        <div class="table-wrap">${tableHTML(d.table, season)}</div></section>
      <div class="stack">
        <section class="card"><div class="card-head"><h2>Top scorers</h2></div>${leaderList(d.scorers, "goals", "assists", "A")}</section>
        <section class="card"><div class="card-head"><h2>Top assists</h2></div>${leaderList(d.creators, "assists", "goals", "G")}</section>
      </div>
    </div>
    <section class="card"><div class="card-head"><div><h2>Results by season</h2><p>Share of matches won by the home side, drawn, or won by the away side</p></div></div>
      ${legend([{ name: "Home win", color: seriesColor(0) }, { name: "Draw", color: seriesColor(1) }, { name: "Away win", color: seriesColor(2) }])}
      <div id="trend"></div>
      <div class="callout" style="margin-top:12px">${info}<span>The ${fmt.season(2020)} dip in home wins coincides with matches played without crowds.</span></div></section>
  </div>`;
  $("#season").onchange = (e) => (location.hash = `#/?season=${e.target.value}`);
  const tr = d.trend;
  lineChart($("#trend"), [
    { name: "Home win", color: seriesColor(0), points: tr.map((r) => ({ x: r.season, y: r.home_win })) },
    { name: "Draw", color: seriesColor(1), points: tr.map((r) => ({ x: r.season, y: r.draw })) },
    { name: "Away win", color: seriesColor(2), points: tr.map((r) => ({ x: r.season, y: r.away_win })) },
  ], { yFormat: (v) => fmt.pct(v), xFormat: (s) => `${String(s).slice(-2)}/${String(s + 1).slice(-2)}`, tipTitle: fmt.season, yMin: 0, yMax: 0.5, endLabels: true });
};

function leaderList(rows, main, second, secondLabel) {
  return `<ol class="list">${rows.map((r, i) => `<li><span class="rank">${i + 1}</span>
    <a href="#/player/${r.player_id}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(r.name)} <span class="muted small">${esc(r.club)}</span></a>
    <span class="muted small num">${r[second]} ${secondLabel}</span><b class="num">${r[main]}</b></li>`).join("")}</ol>`;
}

function tableHTML(rows, season) {
  const n = rows.length;
  return `<table><thead><tr><th class="pos-cell">#</th><th>Club</th><th class="r">P</th><th class="r">W</th><th class="r">D</th><th class="r">L</th><th class="r">GD</th><th class="r">Pts</th><th>Form</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="link ${i < 4 ? "zone-cl" : i >= n - 3 ? "zone-rel" : ""}" data-href="#/team/${r.club_id}?season=${season}">
      <td class="pos-cell">${i + 1}</td><td>${crest(r.code)} ${esc(r.name)}</td><td class="r">${r.played}</td><td class="r">${r.won}</td><td class="r">${r.drawn}</td><td class="r">${r.lost}</td>
      <td class="r">${r.gd > 0 ? "+" : ""}${r.gd}</td><td class="r"><b>${r.points}</b></td><td>${formPills(r.form)}</td></tr>`).join("")}
  </tbody></table>`;
}

// ---------------- players

const PLAYER_COLS = [
  ["name", "Player"], ["club", "Club", false], ["age", "Age"], ["apps", "Apps"], ["minutes", "Min"],
  ["goals", "G"], ["assists", "A"], ["ga_p90", "G+A /90"], ["clean_sheets_90", "CS"], ["market_value_eur", "Value"],
];

views["/players"] = async ({ q }) => {
  const m = await meta();
  const st = {
    season: +(q.get("season") ?? m.last_season), position: q.get("position") ?? "",
    search: q.get("search") ?? "", min: +(q.get("min") ?? 450), sort: q.get("sort") ?? "ga",
    order: q.get("order") ?? "desc", page: +(q.get("page") ?? 0),
  };
  const PAGE = 50;
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Player performance</p><h1>Players</h1>
      <p class="sub">League output by season. Per-90 rates are only shown alongside minutes, since small samples swing wildly.</p></div></div>
    <div class="controls">
      ${seasonSelect(m.seasons, st.season)}
      <label class="field"><span>Name</span><input class="input" id="f-search" value="${esc(st.search)}" placeholder="Filter by name"></label>
      <div class="field"><span>Position</span><div id="f-pos"></div></div>
      <label class="field"><span>Min. minutes · <b id="min-v">${st.min}</b></span><input type="range" id="f-min" min="0" max="3000" step="90" value="${st.min}"></label>
    </div>
    <section class="card flush"><div class="table-wrap" id="ptable"><div class="skeleton" style="margin:16px"></div></div><div class="pager" id="pager"></div></section>
  </div>`;

  const load = async () => {
    setQuery({ season: st.season, position: st.position, search: st.search, min: st.min, sort: st.sort, order: st.order, page: st.page || "" });
    const d = await api(`/players?season=${st.season}&position=${encodeURIComponent(st.position)}&search=${encodeURIComponent(st.search)}&min_minutes=${st.min}&sort=${st.sort}&order=${st.order}&limit=${PAGE}&offset=${st.page * PAGE}`);
    $("#ptable").innerHTML = d.rows.length ? `<table><thead><tr>${PLAYER_COLS.map(([k, l, s]) =>
      `<th class="${s === false ? "" : "sortable"} ${k === st.sort ? `sorted ${st.order}` : ""} ${["name", "club"].includes(k) ? "" : "r"}" data-k="${k}">${l}</th>`).join("")}</tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="link" data-href="#/player/${r.player_id}">
        <td><b>${esc(r.name)}</b> <span class="muted small">${esc(r.sub_position ?? "")}</span></td>
        <td>${crest(r.club_code)} ${esc(r.club)}</td><td class="r">${r.age ?? "–"}</td><td class="r">${r.apps}</td><td class="r">${fmt.int(r.minutes)}</td>
        <td class="r">${r.goals}</td><td class="r">${r.assists}</td><td class="r"><b>${fmt.dec(r.ga_p90)}</b></td><td class="r">${r.clean_sheets_90}</td><td class="r">${fmt.eur(r.market_value_eur)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty-state">No players match these filters.</div>`;
    const from = st.page * PAGE;
    $("#pager").innerHTML = `<span>${d.total ? `${from + 1}–${Math.min(from + PAGE, d.total)} of ${d.total}` : "0 results"} · current value is the latest recorded, not for that season</span>
      <span class="controls" style="margin:0"><button class="btn" id="prev" ${st.page ? "" : "disabled"}>Previous</button><button class="btn" id="next" ${from + PAGE < d.total ? "" : "disabled"}>Next</button></span>`;
    $("#prev").onclick = () => { st.page--; load(); };
    $("#next").onclick = () => { st.page++; load(); };
    $$("th.sortable", $("#ptable")).forEach((th) => th.onclick = () => {
      const k = th.dataset.k;
      st.order = st.sort === k ? (st.order === "desc" ? "asc" : "desc") : (k === "name" ? "asc" : "desc");
      st.sort = k; st.page = 0; load();
    });
  };
  $("#season").onchange = (e) => { st.season = +e.target.value; st.page = 0; load(); };
  let deb;
  $("#f-search").oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { st.search = e.target.value; st.page = 0; load(); }, 150); };
  $("#f-min").oninput = (e) => { $("#min-v").textContent = e.target.value; };
  $("#f-min").onchange = (e) => { st.min = +e.target.value; st.page = 0; load(); };
  segmented($("#f-pos"), [["", "All"], ["Attack", "FWD"], ["Midfield", "MID"], ["Defender", "DEF"], ["Goalkeeper", "GK"]], st.position,
    (v) => { st.position = v; st.page = 0; load(); });
  load();
};

views["/player"] = async ({ id }) => {
  const d = await api(`/players/${id}`);
  const p = d.player;
  const last = d.seasons.at(-1);
  const career = d.seasons.reduce((a, s) => ({ apps: a.apps + s.apps, min: a.min + s.minutes, g: a.g + s.goals, a: a.a + s.assists }), { apps: 0, min: 0, g: 0, a: 0 });
  const f = d.forecast, vf = d.value_forecast, pc = d.percentiles;
  const meters = pc ? [
    ["Goals per 90", pc.goals_p90], ["Assists per 90", pc.assists_p90], ["G+A per 90", pc.ga_p90],
    ["Minutes played", pc.minutes], ["Team points per app", pc.points_per_app], ["Clean-sheet rate", pc.clean_sheet_rate],
  ] : [];
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div style="display:flex;gap:18px;align-items:center">
      <div class="avatar" aria-hidden="true">${initials(p.name)}</div>
      <div><p class="eyebrow">${esc(p.sub_position ?? p.position ?? "")} · ${esc(p.nationality ?? "")}</p><h1>${esc(p.name)}</h1>
      <p class="sub">${p.age_now != null ? `${p.age_now} years old · ` : ""}${esc(p.current_club_name ?? "")}${p.foot ? ` · ${esc(p.foot)} foot` : ""}${p.height_cm ? ` · ${p.height_cm} cm` : ""}${p.contract_expires ? ` · contract to ${fmt.date(p.contract_expires)}` : ""}</p></div></div>
      <div class="controls"><a class="btn" href="#/compare?ids=${p.player_id}">Compare</a></div></div>
    <div class="grid g-4">
      <div class="card tile"><div class="label">League appearances</div><div class="value">${career.apps}</div><div class="note">${fmt.int(career.min)} minutes over ${d.seasons.length} season${d.seasons.length === 1 ? "" : "s"}</div></div>
      <div class="card tile"><div class="label">Goals · assists</div><div class="value">${career.g} · ${career.a}</div><div class="note">${fmt.dec(90 * (career.g + career.a) / Math.max(career.min, 1))} G+A per 90 career</div></div>
      <div class="card tile"><div class="label">Recorded market value</div><div class="value">${fmt.eur(p.market_value_eur)}</div><div class="note">Peak ${fmt.eur(p.highest_market_value_eur)} · an estimate, not a fee</div></div>
      <div class="card tile"><div class="label">${fmt.season(last.season)}</div><div class="value">${last.goals} G · ${last.assists} A</div><div class="note">${fmt.int(last.minutes)} min for ${esc(last.club)}</div></div>
    </div>
    <div class="grid g-2">
      <section class="card"><div class="card-head"><div><h2>Output per 90 by season</h2><p>Goals + assists per 90 league minutes; hover for minutes played</p></div></div><div id="ga-chart"></div></section>
      <section class="card"><div class="card-head"><div><h2>Peer percentiles</h2><p>${pc ? `vs ${pc.peers} ${esc(pc.sub_position)}s with ≥900 min in ${fmt.season(pc.season)}` : "Not enough minutes in any season for a fair comparison"}</p></div></div>
        ${meters.map(([l, v]) => `<div class="meter"><span>${l}</span><div class="track"><div class="fill" style="width:${Math.round((v ?? 0) * 100)}%"></div></div><span class="v">${v == null ? "–" : Math.round(v * 100)}</span></div>`).join("")}
        ${pc && ["Defender", "Goalkeeper"].includes(p.position) ? `<div class="callout" style="margin-top:12px">${info}<span>Tackles, saves and other defensive actions aren't in the source data, so defenders and keepers are judged partly on team outcomes.</span></div>` : ""}
      </section>
    </div>
    <div class="grid g-2">
      <section class="card"><div class="card-head"><div><h2>Next-season forecast</h2><p>${f ? `G+A per 90 in ${fmt.season(f.target_season)}, from ${fmt.season(f.base_season)} data` : "No forecast"}</p></div></div>
        ${f ? `<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap"><span class="hero-num num">${fmt.dec(f.pred_ga_p90)}</span>
          <span class="muted">likely range ${fmt.dec(f.pred_lo)}–${fmt.dec(f.pred_hi)} · last season ${fmt.dec(f.base_ga_p90)}</span></div>
          ${f.low_sample ? `<p class="small" style="color:var(--warn)">Based on fewer than 900 minutes, so treat it with extra caution.</p>` : ""}
          <p class="small muted">A rate, not a total: it assumes the player gets minutes. The range is where 80% of past forecast errors fell.</p>`
        : `<p class="muted small">Forecasts cover players with at least 450 league minutes in ${fmt.season(META?.last_season ?? 2025)}.</p>`}
      </section>
      <section class="card"><div class="card-head"><div><h2>Market value, 12 months ahead</h2><p>${vf ? `From ${fmt.date(vf.snapshot_date)} to ${fmt.date(vf.horizon_date)}` : "No valuation forecast"}</p></div></div>
        ${vf ? `<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap"><span class="hero-num num">${fmt.eur(vf.pred_value_eur)}</span>
          <span class="muted">range ${fmt.eur(vf.pred_lo_eur)}–${fmt.eur(vf.pred_hi_eur)} · now ${fmt.eur(vf.value_eur)}</span></div>
          <p class="small muted">Forecasts the recorded valuation, not what a club would pay. Contract length and injuries aren't modelled.</p>`
        : `<p class="muted small">Only players valued at a league club in the last 12 months get a valuation forecast.</p>`}
      </section>
    </div>
    <section class="card"><div class="card-head"><div><h2>Recorded market value</h2><p>Crowd-sourced estimates over time</p></div></div><div id="val-chart"></div></section>
    <div class="grid g-2">
      <section class="card flush"><div class="card-head"><h2>Season by season</h2></div><div class="table-wrap"><table><thead><tr><th>Season</th><th>Club</th><th class="r">Apps</th><th class="r">Min</th><th class="r">G</th><th class="r">A</th><th class="r">/90</th></tr></thead><tbody>
        ${[...d.seasons].reverse().map((s) => `<tr class="link" data-href="#/team/${s.club_id}?season=${s.season}"><td>${fmt.season(s.season)}</td><td>${crest(s.club_code)} ${esc(s.club)}</td><td class="r">${s.apps}</td><td class="r">${fmt.int(s.minutes)}</td><td class="r">${s.goals}</td><td class="r">${s.assists}</td><td class="r">${fmt.dec(s.ga_p90)}</td></tr>`).join("")}
      </tbody></table></div></section>
      <section class="card flush"><div class="card-head"><h2>Transfers</h2></div><div class="table-wrap">${d.transfers.length ? `<table><thead><tr><th>Date</th><th>From → To</th><th class="r">Fee</th></tr></thead><tbody>
        ${d.transfers.map((t) => `<tr><td>${fmt.date(t.date)}</td><td>${esc(t.from_club_name)} → ${esc(t.to_club_name)}</td><td class="r">${t.fee_eur == null ? '<span class="muted">Undisclosed</span>' : t.fee_eur === 0 ? '<span class="muted">Free / loan</span>' : fmt.eur(t.fee_eur)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty-state small">No recorded transfers</div>`}</div></section>
    </div>
  </div>`;
  lineChart($("#ga-chart"), [{ name: "G+A per 90", color: seriesColor(0), points: d.seasons.map((s) => ({ x: s.season, y: s.minutes >= 270 ? s.ga_p90 : null, label: `${fmt.dec(s.ga_p90)} · ${fmt.int(s.minutes)} min` })) }],
    { yFormat: (v) => fmt.dec(v, 1), xFormat: (s) => `${String(s).slice(-2)}/${String(s + 1).slice(-2)}`, tipTitle: fmt.season, yMin: 0, area: true });
  lineChart($("#val-chart"), [{ name: "Market value", color: seriesColor(0), points: d.valuations.map((v) => ({ x: +new Date(v.date), y: v.value_eur, label: `${fmt.eur(v.value_eur)} · ${esc(v.club_name)}` })) }],
    { yFormat: fmt.eur, xFormat: (t) => new Date(t).getFullYear(), tipTitle: (t) => fmt.date(t), yMin: 0, area: true, height: 200 });
};

// ---------------- compare

views["/compare"] = async ({ q }) => {
  const ids = (q.get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Player comparison</p><h1>Compare</h1><p class="sub">Up to four players, on their latest league season and their career rates.</p></div></div>
    <div class="controls"><div class="search" style="display:block;width:min(320px,100%)"><input class="input" id="cmp-search" placeholder="Add a player…" style="width:100%;padding-left:12px" autocomplete="off"><div class="search-results" id="cmp-results"></div></div>
    <div class="chips" id="chips"></div></div>
    <div id="cmp-body"></div></div>`;
  const setIds = (n) => (location.hash = `#/compare${n.length ? `?ids=${n.join(",")}` : ""}`);
  attachSearch($("#cmp-search"), $("#cmp-results"), (pl) => { if (!ids.includes(String(pl.player_id)) && ids.length < 4) setIds([...ids, pl.player_id]); }, true);
  if (!ids.length) { $("#cmp-body").innerHTML = `<div class="card empty-state">Search for a player to start a comparison.</div>`; return; }
  const d = await api(`/compare?ids=${ids.join(",")}`);
  $("#chips").innerHTML = d.players.map((x, i) => `<span class="chip"><i class="dot" style="background:${seriesColor(i)}"></i>${esc(x.player.name)}<button aria-label="Remove ${esc(x.player.name)}" data-id="${x.player.player_id}">✕</button></span>`).join("");
  $$("#chips button").forEach((b) => b.onclick = () => setIds(ids.filter((i) => i !== b.dataset.id)));
  const rows = [
    ["Position", (x) => esc(x.player.sub_position ?? x.player.position)],
    ["Latest season", (x) => x.season ? `${fmt.season(x.season.season)} · ${esc(x.season.club)}` : "–"],
    ["Age (that season)", (x) => x.season?.age ?? "–"],
    ["Minutes", (x) => fmt.int(x.season?.minutes), (x) => x.season?.minutes],
    ["Goals", (x) => x.season?.goals ?? "–", (x) => x.season?.goals],
    ["Assists", (x) => x.season?.assists ?? "–", (x) => x.season?.assists],
    ["Goals per 90", (x) => fmt.dec(x.season?.goals_p90), (x) => x.season?.goals_p90],
    ["Assists per 90", (x) => fmt.dec(x.season?.assists_p90), (x) => x.season?.assists_p90],
    ["G+A per 90", (x) => fmt.dec(x.season?.ga_p90), (x) => x.season?.ga_p90],
    ["Team points per app", (x) => fmt.dec(x.season?.points_per_app), (x) => x.season?.points_per_app],
    ["Career seasons", (x) => x.career.seasons],
    ["Career G+A per 90", (x) => fmt.dec(x.career.ga_p90), (x) => x.career.ga_p90],
    ["Forecast G+A per 90", (x) => x.forecast ? fmt.dec(x.forecast.pred_ga_p90) : "–", (x) => x.forecast?.pred_ga_p90],
    ["Recorded value", (x) => fmt.eur(x.player.market_value_eur), (x) => x.player.market_value_eur],
  ];
  $("#cmp-body").innerHTML = `<div class="stack">
    <section class="card flush"><div class="table-wrap"><table><thead><tr><th></th>${d.players.map((x, i) => `<th class="r"><span class="club-chip" style="justify-content:flex-end"><i class="chip-dot" style="width:8px;height:8px;border-radius:50%;background:${seriesColor(i)};display:inline-block"></i><a href="#/player/${x.player.player_id}">${esc(x.player.name)}</a></span></th>`).join("")}</tr></thead><tbody>
      ${rows.map(([l, f, v]) => {
        const vals = v ? d.players.map(v) : [];
        const best = vals.length > 1 ? Math.max(...vals.filter((x) => x != null)) : null;
        return `<tr><td class="muted">${l}</td>${d.players.map((x, i) => `<td class="r">${v && vals[i] === best && best != null ? `<b>${f(x)}</b>` : f(x)}</td>`).join("")}</tr>`;
      }).join("")}
    </tbody></table></div></section>
    <section class="card"><div class="card-head"><div><h2>G+A per 90 over time</h2><p>Seasons with fewer than 450 minutes are left out</p></div></div>
      ${d.players.length > 1 ? legend(d.players.map((x, i) => ({ name: x.player.name, color: seriesColor(i) }))) : ""}<div id="cmp-chart"></div></section></div>`;
  lineChart($("#cmp-chart"), d.players.map((x, i) => ({ name: x.player.name, color: seriesColor(i), points: x.trend.map((t) => ({ x: t.season, y: t.minutes >= 450 ? t.ga_p90 : null, label: `${fmt.dec(t.ga_p90)} · ${fmt.int(t.minutes)} min` })) })),
    { yFormat: (v) => fmt.dec(v, 1), xFormat: (s) => `${String(s).slice(-2)}/${String(s + 1).slice(-2)}`, tipTitle: fmt.season, yMin: 0, height: 260 });
};

// ---------------- teams

views["/teams"] = async ({ q }) => {
  const m = await meta();
  const season = +(q.get("season") ?? m.last_season);
  const d = await api(`/teams?season=${season}`);
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Team performance</p><h1>Teams</h1><p class="sub">Standings computed directly from match results.</p></div>
      <div class="controls">${seasonSelect(m.seasons, season)}</div></div>
    <section class="card flush"><div class="table-wrap">${tableHTML(d.table, season)}</div></section></div>`;
  $("#season").onchange = (e) => (location.hash = `#/teams?season=${e.target.value}`);
};

views["/team"] = async ({ id, q }) => {
  const d = await api(`/teams/${id}${q.get("season") ? `?season=${q.get("season")}` : ""}`);
  const c = d.club, s = d.season;
  const pts = d.results.reduce((a, r) => a + (r.gf > r.ga ? 3 : r.gf === r.ga ? 1 : 0), 0);
  const gf = d.results.reduce((a, r) => a + r.gf, 0), ga = d.results.reduce((a, r) => a + r.ga, 0);
  const pos = d.history.find((h) => h.season === s)?.position;
  let cum = 0;
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div style="display:flex;gap:18px;align-items:center"><div class="avatar" aria-hidden="true">${esc(c.code)}</div>
      <div><p class="eyebrow">${esc(c.stadium ?? "")}${c.stadium_seats ? ` · ${fmt.int(c.stadium_seats)} seats` : ""}</p><h1>${esc(c.name)}</h1>
      <p class="sub">${c.seasons.length} Premier League season${c.seasons.length === 1 ? "" : "s"} in the dataset</p></div></div>
      <div class="controls">${seasonSelect([...c.seasons].reverse(), s)}<a class="btn" href="#/match-lab?home=${c.club_id}">Predict a match</a></div></div>
    <div class="grid g-4">
      <div class="card tile"><div class="label">Final position</div><div class="value">${pos ?? "–"}</div><div class="note">${fmt.season(s)}</div></div>
      <div class="card tile"><div class="label">Points</div><div class="value">${pts}</div><div class="note">${(pts / Math.max(d.results.length, 1)).toFixed(2)} per match</div></div>
      <div class="card tile"><div class="label">Goals for · against</div><div class="value">${gf} · ${ga}</div><div class="note">${gf - ga > 0 ? "+" : ""}${gf - ga} goal difference</div></div>
      <div class="card tile"><div class="label">Current Elo rating</div><div class="value">${d.state ? Math.round(d.state.elo) : "–"}</div><div class="note">As of ${d.state ? fmt.date(d.state.as_of) : "–"}; league mean is 1500</div></div>
    </div>
    <div class="grid g-2">
      <section class="card"><div class="card-head"><div><h2>Points through the season</h2><p>Cumulative league points, match by match</p></div></div><div id="cum-chart"></div></section>
      <section class="card"><div class="card-head"><div><h2>Final position by season</h2><p>1st at the top</p></div></div><div id="pos-chart"></div></section>
    </div>
    <section class="card flush"><div class="card-head"><div><h2>Results</h2><p>${d.results.some((r) => r.p_home != null) ? "With the model's pre-match probabilities. These are out-of-sample: the model never saw this season." : "Model probabilities are shown for the held-out test seasons only."}</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Opponent</th><th></th><th class="r">Score</th><th class="r">Win</th><th class="r">Draw</th><th class="r">Loss</th></tr></thead><tbody>
      ${d.results.map((r) => {
        const pw = r.is_home ? r.p_home : r.p_away, pl = r.is_home ? r.p_away : r.p_home;
        const res = r.gf > r.ga ? "W" : r.gf === r.ga ? "D" : "L";
        return `<tr><td>${fmt.dateShort(r.date)}</td><td><a href="#/team/${r.opponent_id}?season=${s}">${esc(r.opponent)}</a></td><td class="muted small">${r.is_home ? "Home" : "Away"}</td>
          <td class="r"><span class="form"><i class="${res}">${res}</i></span> <b>${r.gf}–${r.ga}</b></td>
          <td class="r">${fmt.pct(pw)}</td><td class="r">${fmt.pct(r.p_draw)}</td><td class="r">${fmt.pct(pl)}</td></tr>`;
      }).join("")}</tbody></table></div></section>
    <section class="card flush"><div class="card-head"><h2>Squad · ${fmt.season(s)}</h2></div><div class="table-wrap"><table><thead><tr><th>Player</th><th>Position</th><th class="r">Age</th><th class="r">Apps</th><th class="r">Min</th><th class="r">G</th><th class="r">A</th><th class="r">CS</th></tr></thead><tbody>
      ${d.squad.map((p) => `<tr class="link" data-href="#/player/${p.player_id}"><td><b>${esc(p.name)}</b></td><td class="muted">${esc(p.sub_position ?? "")}</td><td class="r">${p.age ?? "–"}</td><td class="r">${p.apps}</td><td class="r">${fmt.int(p.minutes)}</td><td class="r">${p.goals}</td><td class="r">${p.assists}</td><td class="r">${p.clean_sheets_90}</td></tr>`).join("")}
    </tbody></table></div></section></div>`;
  $("#season").onchange = (e) => (location.hash = `#/team/${id}?season=${e.target.value}`);
  lineChart($("#cum-chart"), [{ name: "Points", color: seriesColor(0), points: d.results.map((r, i) => { cum += r.gf > r.ga ? 3 : r.gf === r.ga ? 1 : 0; return { x: i + 1, y: cum, label: `${cum} pts · ${r.gf}–${r.ga} v ${esc(r.opponent)}` }; }) }],
    { yMin: 0, xFormat: (x) => x, tipTitle: (x) => `Match ${x}`, area: true });
  lineChart($("#pos-chart"), [{ name: "Position", color: seriesColor(0), points: d.history.map((h) => ({ x: h.season, y: h.position, label: `${h.position} · ${h.pts} pts` })) }],
    { invertY: true, yTicks: [1, 5, 10, 15, 20], xFormat: (s) => `${String(s).slice(-2)}/${String(s + 1).slice(-2)}`, tipTitle: fmt.season });
};

// ---------------- match lab

views["/match-lab"] = async ({ q }) => {
  const m = await meta();
  const t = await api(`/teams?season=${m.last_season}`);
  const clubs = [...t.table].sort((a, b) => a.name.localeCompare(b.name));
  let home = +(q.get("home") ?? t.table[0].club_id), away = +(q.get("away") ?? t.table[1].club_id);
  if (home === away) away = t.table.find((r) => r.club_id !== home).club_id;
  const opts = (sel) => clubs.map((c) => `<option value="${c.club_id}" ${c.club_id === sel ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Match prediction</p><h1>Match Lab</h1>
      <p class="sub">Probabilities for any pairing of ${fmt.season(m.last_season)} clubs, using each side's rating and form as of the last recorded match. Line-ups, injuries and transfers since then are not known to the model.</p></div></div>
    <div class="controls">
      <label class="field"><span>Home</span><select class="select" id="home">${opts(home)}</select></label>
      <button class="btn press" id="swap" aria-label="Swap home and away" style="align-self:flex-end">⇄</button>
      <label class="field"><span>Away</span><select class="select" id="away">${opts(away)}</select></label>
    </div>
    <div id="pred"></div></div>`;
  const run = async () => {
    if (home === away) { $("#pred").innerHTML = `<div class="card empty-state">Choose two different clubs.</div>`; return; }
    setQuery({ home, away });
    const p = await api(`/predict?home=${home}&away=${away}`);
    const maxG = Math.max(...p.grid.flat());
    const shade = (v) => { const k = v / maxG; return k > 0.75 ? "var(--seq-4)" : k > 0.5 ? "var(--seq-3)" : k > 0.25 ? "var(--seq-2)" : k > 0.08 ? "var(--seq-1)" : "var(--surface-2)"; };
    const ink = (v) => v / maxG > 0.5 ? "var(--seq-ink-strong)" : "var(--text-primary)";
    $("#pred").innerHTML = `<div class="stack">
      <section class="card">
        <div class="card-head"><h2>${esc(p.home.name)} v ${esc(p.away.name)}</h2><span class="badge">${esc(p.model)} · v${esc(p.version)}</span></div>
        <div class="prob-bar" role="img" aria-label="Home ${fmt.pct(p.p_home)}, draw ${fmt.pct(p.p_draw)}, away ${fmt.pct(p.p_away)}">
          <div style="flex-grow:${p.p_home};background:var(--series-1)">${fmt.pct(p.p_home)}</div>
          <div style="flex-grow:${p.p_draw};background:var(--text-muted)">${fmt.pct(p.p_draw)}</div>
          <div style="flex-grow:${p.p_away};background:var(--series-2)">${fmt.pct(p.p_away)}</div></div>
        <div class="prob-legend"><span>${esc(p.home.name)} win</span><span>Draw</span><span>${esc(p.away.name)} win</span></div>
      </section>
      <div class="grid g-3">
        <div class="card tile"><div class="label">Expected goals (model)</div><div class="value">${fmt.dec(p.exp_home_goals, 1)} – ${fmt.dec(p.exp_away_goals, 1)}</div><div class="note">From the Poisson goals model, not shot-based xG</div></div>
        <div class="card tile"><div class="label">Both teams score</div><div class="value">${fmt.pct(p.p_btts)}</div><div class="note">Over 2.5 goals: ${fmt.pct(p.p_over_2_5)}</div></div>
        <div class="card tile"><div class="label">Elo ratings</div><div class="value">${Math.round(p.home.elo)} · ${Math.round(p.away.elo)}</div><div class="note">Last-6 form: ${p.home.form_ppg.toFixed(1)} vs ${p.away.form_ppg.toFixed(1)} pts/match</div></div>
      </div>
      <div class="grid g-2">
        <section class="card"><div class="card-head"><div><h2>Scoreline probabilities</h2><p>${esc(p.home.code)} goals down, ${esc(p.away.code)} goals across</p></div></div>
          <div class="heat" style="grid-template-columns:28px repeat(6,1fr)"><div class="ax"></div>${[0, 1, 2, 3, 4, 5].map((j) => `<div class="ax">${j}</div>`).join("")}
          ${p.grid.map((row, i) => `<div class="ax">${i}</div>` + row.map((v, j) => `<div title="${i}–${j}: ${fmt.pct(v, 1)}" style="background:${shade(v)};color:${ink(v)}">${v >= 0.01 ? fmt.pct(v) : ""}</div>`).join("")).join("")}</div></section>
        <section class="card"><div class="card-head"><h2>Most likely scores</h2></div>
          <ol class="list">${p.likely_scores.map((s, i) => `<li><span class="rank">${i + 1}</span><span style="flex:1">${esc(p.home.code)} ${s.home}–${s.away} ${esc(p.away.code)}</span><b class="num">${fmt.pct(s.p, 1)}</b></li>`).join("")}</ol>
          <div class="callout" style="margin-top:12px">${info}<span>Even the likeliest exact score usually happens less than one time in eight. Treat these as odds, not calls.</span></div></section>
      </div>
      <section class="card flush"><div class="card-head"><h2>Recent head-to-heads</h2></div><div class="table-wrap">${p.head_to_head.length ? `<table><tbody>${p.head_to_head.map((h) => {
        const hn = h.home_id === p.home.club_id ? p.home.name : p.away.name, an = h.away_id === p.home.club_id ? p.home.name : p.away.name;
        return `<tr><td class="muted">${fmt.date(h.date)}</td><td class="r">${esc(hn)}</td><td style="text-align:center"><b>${h.home_goals}–${h.away_goals}</b></td><td>${esc(an)}</td></tr>`; }).join("")}</tbody></table>` : `<div class="empty-state small">No league meetings in the dataset</div>`}</div></section>
    </div>`;
  };
  $("#home").onchange = (e) => { home = +e.target.value; run(); };
  $("#away").onchange = (e) => { away = +e.target.value; run(); };
  $("#swap").onclick = () => { [home, away] = [away, home]; $("#home").value = home; $("#away").value = away; run(); };
  run();
};

// ---------------- scouting

views["/scouting"] = async ({ q }) => {
  const m = await meta();
  const st = { season: +(q.get("season") ?? m.last_season), position: q.get("position") ?? "Attack", age: +(q.get("age") ?? 23), min: +(q.get("min") ?? 900) };
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Scouting intelligence</p><h1>Scouting</h1>
      <p class="sub">Players ranked against same-position peers in one season. The score is a weighted blend of percentiles: a starting point for a closer look, not a verdict on ability.</p></div></div>
    <div class="controls">${seasonSelect(m.seasons, st.season)}
      <div class="field"><span>Position</span><div id="s-pos"></div></div>
      <label class="field"><span>Max age · <b id="age-v">${st.age}</b></span><input type="range" id="s-age" min="17" max="40" value="${st.age}"></label>
      <label class="field"><span>Min. minutes · <b id="smin-v">${st.min}</b></span><input type="range" id="s-min" min="450" max="3000" step="90" value="${st.min}"></label></div>
    <div id="s-note"></div>
    <section class="card flush"><div class="table-wrap" id="s-table"></div></section></div>`;
  const load = async () => {
    setQuery({ season: st.season, position: st.position, age: st.age, min: st.min });
    const d = await api(`/scouting?season=${st.season}&position=${st.position}&max_age=${st.age}&min_minutes=${st.min}`);
    const attacking = ["Attack", "Midfield"].includes(st.position);
    $("#s-note").innerHTML = `<div class="callout">${info}<span>${attacking
      ? "<b>Score weights:</b> G+A per 90 45%, goals per 90 20%, assists per 90 15%, team points per appearance 10%, minutes 10%."
      : "<b>Score weights:</b> clean-sheet rate 40%, team points per appearance 30%, minutes 20%, G+A per 90 10%. Tackles, saves and other defensive actions aren't in the data, so this leans on team outcomes."}</span></div>`;
    $("#s-table").innerHTML = d.rows.length ? `<table><thead><tr><th class="pos-cell">#</th><th>Player</th><th>Club</th><th class="r">Age</th><th class="r">Min</th><th class="r">${attacking ? "G+A /90" : "CS rate"}</th><th>Score</th><th class="r">Forecast /90</th><th class="r">Value</th><th class="r">Value in 12 mo</th></tr></thead><tbody>
      ${d.rows.map((r, i) => `<tr class="link" data-href="#/player/${r.player_id}"><td class="pos-cell">${i + 1}</td><td><b>${esc(r.name)}</b> <span class="muted small">${esc(r.sub_position ?? "")}</span></td>
        <td>${crest(r.club_code)} ${esc(r.club)}</td><td class="r">${r.age}</td><td class="r">${fmt.int(r.minutes)}</td><td class="r">${attacking ? fmt.dec(r.ga_p90) : fmt.pct(r.cs_rate)}</td>
        <td><div class="meter" style="grid-template-columns:90px 32px;padding:0"><div class="track"><div class="fill" style="width:${Math.round(r.score * 100)}%"></div></div><span class="v">${Math.round(r.score * 100)}</span></div></td>
        <td class="r">${r.pred_ga_p90 != null ? fmt.dec(r.pred_ga_p90) : "–"}</td><td class="r">${fmt.eur(r.market_value_eur)}</td><td class="r">${fmt.eur(r.pred_value_eur)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty-state">No players meet these filters. Try raising the age limit or lowering minutes.</div>`;
  };
  $("#season").onchange = (e) => { st.season = +e.target.value; load(); };
  $("#s-age").oninput = (e) => ($("#age-v").textContent = e.target.value);
  $("#s-age").onchange = (e) => { st.age = +e.target.value; load(); };
  $("#s-min").oninput = (e) => ($("#smin-v").textContent = e.target.value);
  $("#s-min").onchange = (e) => { st.min = +e.target.value; load(); };
  segmented($("#s-pos"), [["Attack", "Forwards"], ["Midfield", "Midfielders"], ["Defender", "Defenders"], ["Goalkeeper", "Keepers"]], st.position, (v) => { st.position = v; load(); });
  load();
};

// ---------------- transfers

views["/transfers"] = async ({ q }) => {
  const d = await api(`/transfers${q.get("s") ? `?season_label=${encodeURIComponent(q.get("s"))}` : ""}`);
  const mv = await api("/valuations/movers");
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Transfer intelligence</p><h1>Transfers</h1>
      <p class="sub">Reported fees for moves involving league clubs. Undisclosed fees are left out of totals, so real spending is higher than shown.</p></div>
      <div class="controls"><label class="field"><span>Window</span><select class="select" id="tseason">${d.labels.map((l) => `<option value="${l}" ${l === d.season_label ? "selected" : ""}>${l}${l === d.partial ? " (partial)" : ""}</option>`).join("")}</select></label></div></div>
    <section class="card"><div class="card-head"><div><h2>Reported spending by league clubs</h2><p>Sum of disclosed fees for incoming transfers, by season</p></div></div><div id="spend"></div></section>
    <div class="grid g-2">
      <section class="card flush"><div class="card-head"><h2>Biggest fees · ${esc(d.season_label)}</h2></div><div class="table-wrap">${d.top.length ? `<table><thead><tr><th>Player</th><th>From → To</th><th class="r">Fee</th><th class="r">Value then</th></tr></thead><tbody>
        ${d.top.map((t) => `<tr class="link" data-href="#/player/${t.player_id}"><td><b>${esc(t.player_name)}</b></td><td class="small">${esc(t.from_club_name)} → ${esc(t.to_club_name)}</td><td class="r"><b>${fmt.eur(t.fee_eur)}</b></td><td class="r muted">${fmt.eur(t.value_at_transfer_eur)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty-state small">No disclosed fees in this window</div>`}</div></section>
      <section class="card"><div class="card-head"><div><h2>Net spend · ${esc(d.season_label)}</h2><p>Disclosed fees paid minus received</p></div></div>
        ${legend([{ name: "Net spender", color: "var(--pos)", square: true }, { name: "Net seller", color: "var(--neg)", square: true }])}<div id="net"></div></section>
    </div>
    <div class="grid g-2">
      <section class="card"><div class="card-head"><div><h2>Forecast value risers</h2><p>Valued ≥ €5m, ${fmt.date(mv.rising[0]?.snapshot_date)} → ${fmt.date(mv.rising[0]?.horizon_date)}</p></div></div>${moverList(mv.rising)}</section>
      <section class="card"><div class="card-head"><div><h2>Forecast value fallers</h2><p>Mostly older players, where values tend to decline</p></div></div>${moverList(mv.falling)}</section>
    </div></div>`;
  $("#tseason").onchange = (e) => (location.hash = `#/transfers?s=${encodeURIComponent(e.target.value)}`);
  columnChart($("#spend"), d.trend.map((t) => ({ label: t.season_label, value: t.spend ?? 0,
    tip: `<div class="t">${t.season_label}${t.season_label === d.partial ? " · window still open at data cutoff" : ""}</div><div class="row">Disclosed spend<b>${fmt.eur(t.spend)}</b></div><div class="row">Paid transfers<b>${t.deals}</b></div><div class="row">Undisclosed<b>${t.undisclosed}</b></div>` })),
    { format: fmt.eur, height: 220 });
  const net = d.clubs.filter((c) => c.spent || c.received).map((c) => ({ label: c.name, short: c.code, value: c.spent - c.received, color: c.spent - c.received >= 0 ? "var(--pos)" : "var(--neg)",
    tip: `<div class="t">${esc(c.name)}</div><div class="row">Spent<b>${fmt.eur(c.spent)}</b></div><div class="row">Received<b>${fmt.eur(c.received)}</b></div><div class="row">Net<b>${fmt.eur(c.spent - c.received)}</b></div>` }));
  columnChart($("#net"), net, { format: fmt.eur, height: 220 });
};

function moverList(rows) {
  return `<ol class="list">${rows.slice(0, 8).map((r) => `<li><a href="#/player/${r.player_id}" style="flex:1;min-width:0">${esc(r.name)} <span class="muted small">${r.age ?? ""} · ${esc(r.club_code ?? "")}</span></a>
    <span class="muted small num">${fmt.eur(r.value_eur)} → ${fmt.eur(r.pred_value_eur)}</span><b class="num" style="width:52px;text-align:right">${r.change > 0 ? "+" : ""}${fmt.pct(r.change)}</b></li>`).join("")}</ol>`;
}

// ---------------- models

const METRIC_LABEL = {
  log_loss: ["Log loss", "lower is better", 3], brier: ["Brier score", "lower is better", 3], rps: ["RPS", "lower is better", 3],
  accuracy: ["Accuracy", "higher is better", "pct"], mae: ["MAE (G+A per 90)", "lower is better", 3],
  mae_log: ["MAE (log value)", "lower is better", 3], median_abs_pct_error: ["Median % error", "lower is better", "pct"], mae_eur_m: ["MAE (€m)", "lower is better", 2],
};
const TASK = { match_outcome: "Match outcomes", player_ga90: "Player G+A per 90", market_value: "Market value (12 months)" };

views["/models"] = async () => {
  const d = await api("/models");
  const m = await meta();
  app.innerHTML = `<div class="view stack">
    <div class="page-head"><div><p class="eyebrow">Transparency</p><h1>Models & data</h1>
      <p class="sub">Every model is trained on earlier seasons, chosen on a validation window, then scored once on later seasons it never saw, alongside simple baselines. If a model can't beat a baseline, that shows here.</p></div></div>
    ${d.registry.map((r) => modelCard(r, d.runs.filter((x) => x.task === r.task))).join("")}
    <section class="card"><div class="card-head"><div><h2>Calibration · match outcomes</h2><p>Predicted probability (across) vs how often it happened (up). Points on the grey diagonal are perfectly calibrated. Test seasons, bins with at least 8 matches.</p></div></div>
      ${legend([{ name: "Home win", color: seriesColor(0) }, { name: "Draw", color: seriesColor(1) }, { name: "Away win", color: seriesColor(2) }])}
      <div id="calib" style="max-width:520px"></div>
      <details class="table-view"><summary>Show as table</summary><table><thead><tr><th>Outcome</th><th class="r">Bin</th><th class="r">Predicted</th><th class="r">Observed</th><th class="r">n</th></tr></thead><tbody>
        ${d.calibration.map((c) => `<tr><td>${c.outcome}</td><td class="r">${fmt.pct(c.bin_lo)}–${fmt.pct(c.bin_hi)}</td><td class="r">${fmt.pct(c.predicted, 1)}</td><td class="r">${fmt.pct(c.observed, 1)}</td><td class="r">${c.n}</td></tr>`).join("")}</tbody></table></details></section>
    <div class="grid g-2">
      <section class="card"><div class="card-head"><h2>Data-quality checks</h2></div><ul class="list">${m.quality.map((q) => `<li><span>${esc(q.check_name)}</span><span class="badge ${q.status === "pass" ? "good" : "warn"}">${q.status === "pass" ? "✓ pass" : `${esc(q.status)} · ${esc(q.detail)}`}</span></li>`).join("")}</ul></section>
      <section class="card"><div class="card-head"><div><h2>Not in the data</h2><p>JUEGO does not estimate or imply these</p></div></div><ul class="list">${m.unavailable.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></section>
    </div>
    <section class="card"><div class="card-head"><h2>Privacy</h2></div><ul class="list">
      <li>No sign-up, login, cookies, analytics or advertising scripts.</li>
      <li>Searches run against the local database and aren't stored or logged.</li>
      <li>The only network requests go to this computer. The data pipeline fetches public datasets from one configured source.</li>
      <li>Player photos are left out on purpose: loading them would contact a third-party image host.</li></ul></section>
  </div>`;
  const by = (o) => d.calibration.filter((c) => c.outcome === o);
  calibrationChart($("#calib"), [
    { name: "Home win", color: seriesColor(0), points: by("H") }, { name: "Draw", color: seriesColor(1), points: by("D") }, { name: "Away win", color: seriesColor(2), points: by("A") },
  ], { height: 320 });
};

function modelCard(reg, runs) {
  const test = runs.filter((r) => r.split === "test");
  const metrics = [...new Set(test.map((r) => r.metric))].filter((k) => k !== "n" && METRIC_LABEL[k]);
  const models = [...new Set(test.map((r) => r.model))];
  const role = (mdl) => test.find((r) => r.model === mdl)?.role;
  models.sort((a, b) => ({ selected: 0, candidate: 1, baseline: 2 }[role(a)] - { selected: 0, candidate: 1, baseline: 2 }[role(b)]));
  const val = (mdl, k) => test.find((r) => r.model === mdl && r.metric === k)?.value;
  const n = test.find((r) => r.metric === "n")?.value;
  const show = (k, v) => METRIC_LABEL[k][2] === "pct" ? fmt.pct(v, 1) : fmt.dec(v, METRIC_LABEL[k][2]);
  const best = Object.fromEntries(metrics.map((k) => {
    const vs = models.map((x) => val(x, k)).filter((v) => v != null);
    return [k, METRIC_LABEL[k][1].startsWith("higher") ? Math.max(...vs) : Math.min(...vs)];
  }));
  const feats = JSON.parse(reg.features);
  return `<section class="card">
    <div class="card-head"><div><h2>${TASK[reg.task]}</h2><p>${esc(reg.target)}</p></div><span class="badge">v${esc(reg.version)}</span></div>
    <div class="grid g-4" style="margin-bottom:14px">
      <div><div class="muted small">Train</div><div class="small">${esc(reg.train)}</div></div>
      <div><div class="muted small">Validation</div><div class="small">${esc(reg.validation)}</div></div>
      <div><div class="muted small">Test (held out)</div><div class="small">${esc(reg.test)} · n=${fmt.int(n)}</div></div>
      <div><div class="muted small">Chosen by</div><div class="small">${esc(reg.selection_metric)}</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>Model</th><th></th>${metrics.map((k) => `<th class="r" title="${METRIC_LABEL[k][1]}">${METRIC_LABEL[k][0]}</th>`).join("")}</tr></thead><tbody>
      ${models.map((mdl) => `<tr><td>${mdl === reg.selected_model ? `<b>${esc(mdl)}</b>` : esc(mdl)}</td><td>${role(mdl) === "selected" ? '<span class="badge good">in use</span>' : role(mdl) === "baseline" ? '<span class="badge">baseline</span>' : ""}</td>
        ${metrics.map((k) => { const v = val(mdl, k); return `<td class="r">${v === best[k] ? `<b>${show(k, v)}</b>` : show(k, v)}</td>`; }).join("")}</tr>`).join("")}
    </tbody></table></div>
    <p class="small muted" style="margin:12px 0 0">Features: ${feats.map((f) => `<code>${esc(f)}</code>`).join(", ")}</p>
    <p class="small muted" style="margin:6px 0 0">${esc(reg.notes)}</p></section>`;
}

// ------------------------------------------------------------------ search

function attachSearch(input, box, onPick, playersOnly = false) {
  let items = [], sel = -1, deb;
  const render = () => {
    box.innerHTML = items.length ? items.map((it, i) => `<a href="${it.href}" class="${i === sel ? "sel" : ""}" data-i="${i}" role="option"><span>${esc(it.name)}</span><span class="k">${esc(it.kind)}</span></a>`).join("")
      : `<div class="empty">No matches</div>`;
    box.classList.add("open");
  };
  input.addEventListener("input", () => {
    clearTimeout(deb);
    const v = input.value.trim();
    if (v.length < 2) { box.classList.remove("open"); return; }
    deb = setTimeout(async () => {
      const d = await api(`/search?q=${encodeURIComponent(v)}`);
      items = [...d.players.map((p) => ({ ...p, href: `#/player/${p.player_id}`, kind: `${p.position ?? ""} · ${p.last_season ? fmt.season(p.last_season) : ""}` })),
        ...(playersOnly ? [] : d.clubs.map((c) => ({ ...c, href: `#/team/${c.club_id}`, kind: "Club" })))];
      sel = -1; render();
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (!box.classList.contains("open")) return;
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === "Enter" && items[Math.max(sel, 0)]) { pick(items[Math.max(sel, 0)]); e.preventDefault(); }
    else if (e.key === "Escape") box.classList.remove("open");
  });
  const pick = (it) => {
    box.classList.remove("open"); input.value = ""; input.blur();
    if (onPick && it.player_id) onPick(it); else location.hash = it.href;
  };
  box.addEventListener("pointerdown", (e) => {
    const a = e.target.closest("a"); if (!a) return;
    e.preventDefault(); pick(items[+a.dataset.i]);
  });
  input.addEventListener("blur", () => setTimeout(() => box.classList.remove("open"), 120));
}

// ------------------------------------------------------------------ router

const ROUTES = [
  [/^\/$/, "/", "overview"], [/^\/players$/, "/players", "players"], [/^\/player\/(\d+)$/, "/player", "players"],
  [/^\/compare$/, "/compare", "compare"], [/^\/teams$/, "/teams", "teams"], [/^\/team\/(\d+)$/, "/team", "teams"],
  [/^\/match-lab$/, "/match-lab", "match-lab"], [/^\/scouting$/, "/scouting", "scouting"],
  [/^\/transfers$/, "/transfers", "transfers"], [/^\/models$/, "/models", "models"],
];

let lastPath = null;
async function route() {
  const { path, q } = params();
  const hit = ROUTES.map(([re, v, nav]) => [path.match(re), v, nav]).find(([mm]) => mm);
  if (!hit) { app.innerHTML = `<div class="view card empty-state">Page not found. <a href="#/" style="color:var(--accent)">Back to overview</a></div>`; return; }
  const [mm, v, nav] = hit;
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
  const pathChanged = path !== lastPath;
  lastPath = path;
  if (pathChanged) { skeleton(); window.scrollTo({ top: 0 }); }
  try {
    await views[v]({ id: mm[1], q });
    document.title = `JUEGO · ${$("h1")?.textContent ?? ""}`;
  } catch (err) {
    app.innerHTML = `<div class="view card error-state">Couldn't load this view: ${esc(err.message)}</div>`;
  }
}

// Row links: the whole row is the target, with instant press feedback via CSS.
app.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-href]");
  if (tr && !e.target.closest("a")) location.hash = tr.dataset.href;
});

addEventListener("hashchange", () => {
  // Query-only updates made by the view itself use replaceState and don't land here.
  route();
});
addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 4), { passive: true });

// Appearance toggle: a per-viewer convenience, stored only in this browser.
const root = document.documentElement;
try { const t = localStorage.getItem("juego-theme"); if (t) root.dataset.theme = t; } catch {}
$("#theme").onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("juego-theme", root.dataset.theme); } catch {}
};

attachSearch($("#search"), $("#search-results"));
meta().then((m) => ($("#foot-meta").textContent = `Data ${fmt.season(m.first_season)}–${fmt.season(m.last_season)} · cutoff ${fmt.date(m.data_cutoff)}`));
route();
