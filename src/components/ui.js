import { el, svg } from "../lib/dom.js";

export function card(props = {}, ...children) {
  const { title, sub, actions, tint, flush, class: cls = "" } = props;
  const classes = ["card", "grain", tint ? `card--tint-${tint}` : "", flush ? "card--flush" : "", cls]
    .filter(Boolean)
    .join(" ");
  const head =
    title || actions
      ? el(
          "div",
          { class: "card__head", style: flush ? { padding: "22px 22px 16px", margin: 0 } : {} },
          el(
            "div",
            {},
            title && el("h3", { class: "card__title" }, title),
            sub && el("p", { class: "card__sub" }, sub),
          ),
          actions && el("div", { class: "card__head-actions" }, actions),
        )
      : null;
  return el("section", { class: classes }, head, ...children);
}

export function pill(text, variant = "neutral", withDot = false) {
  return el(
    "span",
    { class: `pill pill--${variant}` },
    withDot && el("span", { class: "dot dot--pulse" }),
    text,
  );
}

export function stat({ label, value, unit, trend, foot, spark, tint }) {
  const up = trend > 0;
  return el(
    "article",
    { class: `stat grain${tint ? ` card--tint-${tint}` : ""}` },
    el("span", { class: "stat__label" }, label),
    el("div", { class: "stat__value" }, String(value), unit && el("small", {}, unit)),
    el(
      "div",
      { class: "stat__foot" },
      trend != null &&
        el("span", { class: `trend trend--${up ? "up" : "down"}` }, `${up ? "▲" : "▼"} ${Math.abs(trend)}%`),
      foot && el("span", {}, foot),
    ),
    spark && sparkline(spark, "var(--dusty-denim)"),
  );
}

export function sparkline(values, color = "var(--dusty-denim)") {
  const w = 240;
  const h = 44;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 6 - ((v - min) / span) * (h - 14)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const id = `sp-${Math.random().toString(36).slice(2, 8)}`;
  return svg(
    "svg",
    { class: "stat__spark", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" },
    svg(
      "defs",
      {},
      svg(
        "linearGradient",
        { id, x1: "0", y1: "0", x2: "0", y2: "1" },
        svg("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.2" }),
        svg("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" }),
      ),
    ),
    svg("path", { d: `${line} L${w} ${h} L0 ${h} Z`, fill: `url(#${id})` }),
    svg("path", {
      d: line,
      fill: "none",
      stroke: color,
      "stroke-width": "1.4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
    }),
  );
}

/* Las barras se desvanecen hacia el fondo en lugar de cerrar con una línea base */
function fadeGradient(id, color, from = 0.85, to = 0.04) {
  return svg(
    "linearGradient",
    { id, x1: "0", y1: "0", x2: "0", y2: "1" },
    svg("stop", { offset: "0%", "stop-color": color, "stop-opacity": String(from) }),
    svg("stop", { offset: "62%", "stop-color": color, "stop-opacity": String((from + to) / 2.6) }),
    svg("stop", { offset: "100%", "stop-color": color, "stop-opacity": String(to) }),
  );
}

const uid = () => Math.random().toString(36).slice(2, 8);

export function barChart(data, { height = 190, color = "var(--pitch-black)" } = {}) {
  const w = 620;
  const max = Math.max(...data.map((d) => d.value));
  const gap = 20;
  const slot = (w - gap * (data.length - 1)) / data.length;
  const bw = Math.min(slot, 30);
  const pad = (slot - bw) / 2;
  const id = `bc-${uid()}`;
  return svg(
    "svg",
    { class: "chart", viewBox: `0 0 ${w} ${height}`, preserveAspectRatio: "none", role: "img" },
    svg("defs", {}, fadeGradient(id, color)),
    ...data.flatMap((d, i) => {
      const bh = ((d.value / max) * (height - 46)) | 0;
      const x = i * (slot + gap) + pad;
      const y = height - 26 - bh;
      return [
        svg("rect", { x, y, width: bw, height: bh, fill: `url(#${id})` }),
        svg("rect", { x, y, width: bw, height: 1.5, fill: color, opacity: 0.85 }),
        svg(
          "text",
          {
            x: x + bw / 2,
            y: height - 8,
            "text-anchor": "middle",
            fill: "var(--chart-label)",
            "font-size": "10",
            "font-family": "var(--font-ui)",
          },
          d.label,
        ),
      ];
    }),
  );
}

export function stackedBars(data, { height = 190 } = {}) {
  const w = 620;
  const gap = 24;
  const slot = (w - gap * (data.length - 1)) / data.length;
  const bw = Math.min(slot, 34);
  const pad = (slot - bw) / 2;
  const usable = height - 46;
  const inkId = `sa-${uid()}`;
  const denimId = `sh-${uid()}`;
  return svg(
    "svg",
    { class: "chart", viewBox: `0 0 ${w} ${height}`, preserveAspectRatio: "none" },
    svg(
      "defs",
      {},
      fadeGradient(inkId, "var(--pitch-black)", 0.9, 0.05),
      fadeGradient(denimId, "var(--dusty-denim)", 0.55, 0.18),
    ),
    ...data.flatMap((d, i) => {
      const x = i * (slot + gap) + pad;
      const ah = (d.automated / 100) * usable;
      const hh = (d.human / 100) * usable;
      const baseY = height - 26;
      return [
        svg("rect", { x, y: baseY - ah - hh, width: bw, height: hh, fill: `url(#${denimId})` }),
        svg("rect", { x, y: baseY - ah - hh, width: bw, height: 1.5, fill: "var(--dusty-denim)", opacity: 0.8 }),
        svg("rect", { x, y: baseY - ah, width: bw, height: ah, fill: `url(#${inkId})` }),
        svg("rect", { x, y: baseY - ah, width: bw, height: 1.5, fill: "var(--pitch-black)", opacity: 0.85 }),
        svg(
          "text",
          {
            x: x + bw / 2,
            y: height - 8,
            "text-anchor": "middle",
            fill: "var(--chart-label)",
            "font-size": "10",
          },
          d.label,
        ),
      ];
    }),
  );
}

export function donut(data, { size = 180, thickness = 10, center = "" } = {}) {
  const r = size / 2 - thickness / 2 - 2;
  const c = 2 * Math.PI * r;
  const total = data.reduce((s, d) => s + d.value, 0);
  let offset = 0;
  const arcs = data.map((d) => {
    const len = (d.value / total) * c;
    const node = svg("circle", {
      cx: size / 2,
      cy: size / 2,
      r,
      fill: "none",
      stroke: d.color,
      "stroke-width": thickness,
      "stroke-dasharray": `${len - 4} ${c - len + 4}`,
      "stroke-dashoffset": -offset,
      "stroke-linecap": "butt",
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    offset += len;
    return node;
  });
  return svg(
    "svg",
    { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
    svg("circle", {
      cx: size / 2,
      cy: size / 2,
      r,
      fill: "none",
      stroke: "var(--chart-track)",
      "stroke-width": 1,
    }),
    ...arcs,
    center &&
      svg(
        "text",
        {
          x: size / 2,
          y: size / 2 + 8,
          "text-anchor": "middle",
          fill: "var(--text-primary)",
          "font-size": "28",
          "font-weight": "300",
          "letter-spacing": "-1",
        },
        center,
      ),
  );
}

export function legend(items) {
  return el(
    "div",
    { class: "legend" },
    ...items.map((it) =>
      el(
        "span",
        { class: "legend__item" },
        el("i", { class: "legend__swatch", style: { background: it.color } }),
        `${it.label}${it.value != null ? ` · ${it.value}%` : ""}`,
      ),
    ),
  );
}

export function bar(percent, variant = "") {
  return el(
    "div",
    { class: "bar" },
    el("i", { class: `bar__fill ${variant}`, style: { width: `${percent}%`, display: "block" } }),
  );
}

export function toggle(on, onChange) {
  const btn = el("button", {
    class: `switch${on ? " is-on" : ""}`,
    type: "button",
    role: "switch",
    "aria-checked": String(on),
    onclick: () => {
      const next = !btn.classList.contains("is-on");
      btn.classList.toggle("is-on", next);
      btn.setAttribute("aria-checked", String(next));
      onChange?.(next);
    },
  });
  return btn;
}

export function emptyState(title, desc) {
  return el("div", { class: "empty" }, el("strong", {}, title), el("span", {}, desc));
}
