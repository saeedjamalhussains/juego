// Dependency-free SVG charts. Thin marks, recessive grid, one y-axis,
// crosshair + tooltip on lines, per-mark tooltip on columns and dots.

const NS = "http://www.w3.org/2000/svg";
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
export const seriesColor = (i) => SERIES[i % SERIES.length];

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function tooltip(container) {
  let t = container.querySelector(":scope > .tooltip");
  if (!t) { t = document.createElement("div"); t.className = "tooltip"; container.appendChild(t); }
  return {
    show(html, x, y) {
      t.innerHTML = html;
      t.classList.add("show");
      const w = t.offsetWidth, cw = container.clientWidth;
      const left = Math.min(Math.max(x + 14, 0), cw - w);
      t.style.left = `${x + 14 + w > cw ? Math.max(x - w - 14, 0) : left}px`;
      t.style.top = `${Math.max(y - t.offsetHeight - 10, 0)}px`;
    },
    hide() { t.classList.remove("show"); },
  };
}

function responsive(container, draw) {
  let lastW = 0;
  const run = () => {
    const w = container.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    container.querySelector("svg")?.remove();
    draw(w);
  };
  run();
  const ro = new ResizeObserver(run);
  ro.observe(container);
}

export function legend(items) {
  return `<div class="legend">${items.map((s) =>
    `<span><i class="${s.square ? "sq" : ""}" style="background:${s.color}"></i>${s.name}</span>`).join("")}</div>`;
}

/**
 * Line chart. series: [{name, color, points: [{x, y, label?}]}]
 * opts: {height, yFormat, xFormat, yMin, yMax, invertY, area, xTicks}
 */
export function lineChart(container, series, opts = {}) {
  const H = opts.height ?? 220;
  const fmtY = opts.yFormat ?? ((v) => v);
  const fmtX = opts.xFormat ?? ((v) => v);
  container.classList.add("chart");
  const all = series.flatMap((s) => s.points).filter((p) => p.y != null);
  if (!all.length) { container.innerHTML = `<div class="empty-state small">No data for this view</div>`; return; }
  const xs = [...new Set(all.map((p) => +p.x))].sort((a, b) => a - b);
  const ymin = opts.yMin ?? Math.min(...all.map((p) => p.y));
  const ymax = opts.yMax ?? Math.max(...all.map((p) => p.y));
  const ticks = opts.yTicks ?? niceTicks(opts.yMin ?? Math.min(0, ymin), ymax);
  const tip = tooltip(container);

  responsive(container, (W) => {
    const yLabelW = Math.max(...ticks.map((t) => String(fmtY(t)).length)) * 6.5 + 10;
    const m = { t: 10, r: opts.endLabels ? 70 : 12, b: 26, l: yLabelW };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const sx = (x) => m.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
    const t0 = ticks[0], t1 = ticks[ticks.length - 1];
    const sy = (y) => opts.invertY ? m.t + ((y - t0) / (t1 - t0)) * ih : m.t + ih - ((y - t0) / (t1 - t0)) * ih;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.label ?? "Line chart" });
    const g = el("g", { class: "grid" }, svg);
    for (const t of ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }, g);
      el("text", { x: m.l - 8, y: sy(t) + 4, "text-anchor": "end" }, svg).textContent = fmtY(t);
    }
    const xt = opts.xTicks ?? xs.filter((_, i) => i % Math.ceil(xs.length / Math.max(2, Math.floor(iw / 70))) === 0);
    for (const x of xt) el("text", { x: sx(x), y: H - 6, "text-anchor": "middle" }, svg).textContent = fmtX(x);

    series.forEach((s) => {
      const pts = s.points.filter((p) => p.y != null).sort((a, b) => a.x - b.x);
      if (!pts.length) return;
      // Break the line where a series skips an x (e.g. a season with no data).
      const xi = (p) => xs.indexOf(+p.x);
      const d = pts.map((p, i) => `${i && xi(p) === xi(pts[i - 1]) + 1 ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
      if (opts.area && !d.slice(1).includes("M")) {
        el("path", { d: `${d}L${sx(pts.at(-1).x)},${sy(t0)}L${sx(pts[0].x)},${sy(t0)}Z`, fill: s.color, "fill-opacity": 0.1 }, svg);
      }
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const last = pts.at(-1);
      if (pts.length <= 40) {
        for (const p of pts) el("circle", { cx: sx(p.x), cy: sy(p.y), r: p === last ? 4 : 2.5, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2 }, svg);
      }
      if (opts.endLabels) {
        el("text", { x: sx(last.x) + 8, y: sy(last.y) + 4, class: "label-sec" }, svg).textContent = s.name;
      }
    });

    // crosshair
    const cross = el("line", { y1: m.t, y2: m.t + ih, stroke: "var(--hairline-strong)", "stroke-width": 1, opacity: 0 }, svg);
    const hit = el("rect", { x: m.l, y: 0, width: iw, height: H, fill: "transparent" }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const xv = xs.reduce((best, x) => Math.abs(sx(x) - px) < Math.abs(sx(best) - px) ? x : best, xs[0]);
      cross.setAttribute("x1", sx(xv)); cross.setAttribute("x2", sx(xv)); cross.setAttribute("opacity", 1);
      const rows = series.map((s) => {
        const p = s.points.find((q) => +q.x === xv);
        return p && p.y != null ? `<div class="row"><i class="sw" style="background:${s.color}"></i>${s.name}<b>${p.label ?? fmtY(p.y)}</b></div>` : "";
      }).join("");
      tip.show(`<div class="t">${opts.tipTitle ? opts.tipTitle(xv) : fmtX(xv)}</div>${rows}`, (sx(xv) / W) * r.width, ev.clientY - r.top);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { tip.hide(); cross.setAttribute("opacity", 0); });
    container.appendChild(svg);
  });
}

/**
 * Columns from one baseline. data: [{label, value, color?, tip?}]
 * Diverging (negative values) grow downward from zero.
 */
export function columnChart(container, data, opts = {}) {
  const H = opts.height ?? 200;
  const fmt = opts.format ?? ((v) => v);
  container.classList.add("chart");
  if (!data.length) { container.innerHTML = `<div class="empty-state small">No data</div>`; return; }
  const vals = data.map((d) => d.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const tip = tooltip(container);

  responsive(container, (W) => {
    const yLabelW = Math.max(...ticks.map((t) => String(fmt(t)).length)) * 6.5 + 10;
    const m = { t: 10, r: 8, b: 26, l: yLabelW };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const t0 = ticks[0], t1 = ticks.at(-1);
    const sy = (y) => m.t + ih - ((y - t0) / (t1 - t0)) * ih;
    const band = iw / data.length;
    const bw = Math.min(24, band * 0.7);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.label ?? "Column chart" });
    const g = el("g", { class: "grid" }, svg);
    for (const t of ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }, g);
      el("text", { x: m.l - 8, y: sy(t) + 4, "text-anchor": "end" }, svg).textContent = fmt(t);
    }
    const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 44)));
    data.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      const y0 = sy(0), y1 = sy(d.value);
      const h = Math.abs(y1 - y0);
      const r = Math.min(4, h / 2, bw / 2);
      const up = d.value >= 0;
      const x = cx - bw / 2, top = Math.min(y0, y1);
      // rounded data-end, square at the baseline
      const path = up
        ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
        : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 - r}V${y0}Z`;
      el("path", { d: h < 0.5 ? "" : path, fill: d.color ?? "var(--series-1)" }, svg);
      if (i % every === 0) el("text", { x: cx, y: H - 6, "text-anchor": "middle" }, svg).textContent = d.short ?? d.label;
      const hit = el("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent" }, svg);
      const show = (ev) => {
        const rr = svg.getBoundingClientRect();
        tip.show(d.tip ?? `<div class="t">${d.label}</div><div class="row">${opts.name ?? "Value"}<b>${fmt(d.value)}</b></div>`,
          (cx / W) * rr.width, ev.clientY - rr.top);
      };
      hit.addEventListener("pointermove", show);
      hit.addEventListener("pointerdown", show);
      hit.addEventListener("pointerleave", () => tip.hide());
    });
    container.appendChild(svg);
  });
}

/** Reliability diagram: predicted vs observed, one series per outcome. */
export function calibrationChart(container, groups, opts = {}) {
  const H = opts.height ?? 280;
  container.classList.add("chart");
  const tip = tooltip(container);
  const pct = (v) => `${Math.round(v * 100)}%`;
  responsive(container, (W) => {
    const size = Math.min(W, H);
    const m = { t: 10, r: 10, b: 30, l: 40 };
    const iw = size - m.l - m.r, ih = size - m.t - m.b;
    const sx = (v) => m.l + v * iw, sy = (v) => m.t + ih - v * ih;
    const svg = el("svg", { viewBox: `0 0 ${W} ${size}`, height: size, role: "img", "aria-label": "Calibration chart" });
    const g = el("g", { class: "grid" }, svg);
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      el("line", { x1: m.l, x2: m.l + iw, y1: sy(t), y2: sy(t) }, g);
      el("text", { x: m.l - 8, y: sy(t) + 4, "text-anchor": "end" }, svg).textContent = pct(t);
      el("text", { x: sx(t), y: size - 10, "text-anchor": "middle" }, svg).textContent = pct(t);
    }
    el("line", { x1: sx(0), y1: sy(0), x2: sx(1), y2: sy(1), stroke: "var(--text-muted)", "stroke-width": 1, opacity: 0.6 }, svg);
    groups.forEach((grp) => {
      const pts = grp.points.sort((a, b) => a.predicted - b.predicted);
      el("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${sx(p.predicted)},${sy(p.observed)}`).join(""), fill: "none", stroke: grp.color, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
      for (const p of pts) {
        const r = Math.max(4, Math.min(9, Math.sqrt(p.n) / 2));
        const c = el("circle", { cx: sx(p.predicted), cy: sy(p.observed), r, fill: grp.color, stroke: "var(--surface-1)", "stroke-width": 2 }, svg);
        const show = (ev) => {
          const rr = svg.getBoundingClientRect();
          tip.show(`<div class="t">${grp.name}</div><div class="row">Predicted<b>${pct(p.predicted)}</b></div><div class="row">Observed<b>${pct(p.observed)}</b></div><div class="row">Matches<b>${p.n}</b></div>`,
            (sx(p.predicted) / W) * rr.width, ev.clientY - rr.top);
        };
        c.addEventListener("pointermove", show);
        c.addEventListener("pointerdown", show);
        c.addEventListener("pointerleave", () => tip.hide());
      }
    });
    container.appendChild(svg);
  });
}
