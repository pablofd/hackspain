import { el, mount, svg } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { calls } from "../data/mock.js";

/** Personas con las que ha hablado maio, agregadas por nombre. */
export function people() {
  const byCaller = new Map();
  for (const c of calls) {
    const e = byCaller.get(c.caller) || { name: c.caller, count: 0, escalated: false };
    e.count += 1;
    e.escalated = e.escalated || c.outcome === "escalated";
    byCaller.set(c.caller, e);
  }
  return [...byCaller.values()];
}

export function networkPanel() {
  const host = el("div", { class: "map-full" });
  const nodes = people();
  let zoom = 1;
  const stage = el("div", { class: "map-full__stage" });
  const zoomLabel = el("span", { class: "mono" }, "100%");

  function paint() {
    mount(stage, graph(nodes, zoom));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(next) {
    zoom = Math.min(2.2, Math.max(0.6, Number(next.toFixed(2))));
    paint();
  }

  mount(
    host,
    el(
      "header",
      { class: "map-full__bar" },
      icon("maio", "map-full__logo"),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "chat-card__title" }, "Red de maio"),
        el("div", { class: "chat-card__sub" }, `${nodes.length} personas · ${calls.length} conversaciones`),
      ),
      el(
        "div",
        { class: "row ml-auto", style: { gap: "6px" } },
        el("button", { class: "btn btn--icon", onclick: () => setZoom(zoom - 0.2), title: "Alejar" }, "−"),
        zoomLabel,
        el("button", { class: "btn btn--icon", onclick: () => setZoom(zoom + 0.2), title: "Ampliar" }, "+"),
        el("button", { class: "btn btn--sm", onclick: () => setZoom(1) }, "Ajustar"),
      ),
    ),
    stage,
    el(
      "footer",
      { class: "map-full__legend" },
      el("span", {}, "Grosor del trazo = número de llamadas"),
      el("span", { class: "text-alert" }, "Aro rojo = hubo escalado a humano"),
      el("span", { class: "ml-auto" }, "Rueda del ratón o + / − para ampliar"),
    ),
  );

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  });

  paint();
  return host;
}

function graph(nodes, zoom) {
  const w = 1200;
  const h = 760;
  const cx = w / 2;
  const cy = h / 2;
  const clips = [];
  const edges = [];
  const dots = [];

  const inner = nodes.slice(0, Math.ceil(nodes.length / 2));
  const outer = nodes.slice(Math.ceil(nodes.length / 2));

  const place = (list, rx, ry, phase) =>
    list.forEach((n, i) => {
      const angle = -Math.PI / 2 + phase + (i / list.length) * Math.PI * 2;
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry;
      const from = { x: cx + Math.cos(angle) * 62, y: cy + Math.sin(angle) * 62 };
      const to = { x: x - Math.cos(angle) * 26, y: y - Math.sin(angle) * 26 };
      const bend = (i % 2 ? 1 : -1) * (18 + (i % 3) * 9);
      const mid = {
        x: (from.x + to.x) / 2 - Math.sin(angle) * bend,
        y: (from.y + to.y) / 2 + Math.cos(angle) * bend,
      };

      edges.push(
        svg("path", {
          d: `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${mid.x.toFixed(1)} ${mid.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
          fill: "none",
          stroke: "rgba(var(--ink-rgb), 0.26)",
          "stroke-width": 0.6 + Math.min(n.count, 4) * 0.25,
          "stroke-linecap": "round",
        }),
      );

      const clipId = `mf-${Math.random().toString(36).slice(2, 7)}`;
      clips.push(svg("clipPath", { id: clipId }, svg("circle", { cx: x, cy: y, r: 23 })));

      dots.push(
        svg(
          "g",
          {},
          svg("circle", { cx: x, cy: y, r: 23, fill: "var(--white)" }),
          svg(
            "text",
            { x, y: y + 5, "text-anchor": "middle", "font-size": "13", fill: "var(--text-secondary)" },
            n.name[0],
          ),
          photo(n.name, x, y, 23, clipId),
          svg("circle", {
            cx: x,
            cy: y,
            r: 23,
            fill: "none",
            stroke: n.escalated ? "var(--lipstick-red)" : "rgba(var(--ink-rgb), 0.35)",
            "stroke-width": n.escalated ? 1.8 : 1,
          }),
          svg("text", { x, y: y + 41, "text-anchor": "middle", class: "map__node-label" }, n.name),
          svg(
            "text",
            { x, y: y + 54, "text-anchor": "middle", class: "map__node-sub" },
            `${n.count} ${n.count === 1 ? "llamada" : "llamadas"}`,
          ),
        ),
      );
    });

  place(inner, 300, 210, 0);
  place(outer, 500, 330, Math.PI / outer.length);

  return svg(
    "svg",
    { class: "map-full__canvas", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Red de maio" },
    svg("defs", {}, ...clips),
    svg(
      "g",
      { transform: `translate(${cx} ${cy}) scale(${zoom}) translate(${-cx} ${-cy})` },
      ...edges,
      ...dots,
      svg("circle", { cx, cy, r: 56, fill: "var(--pitch-black)" }),
      svg(
        "g",
        { transform: `translate(${cx - 20} ${cy - 20}) scale(1.65)` },
        svg("path", {
          d: "M7.5 4.5h9a4.5 4.5 0 0 1 4.5 4.5v4.5a4.5 4.5 0 0 1-4.5 4.5H11l-4.5 3.5 1.25-3.5A4.5 4.5 0 0 1 3 13.5V9a4.5 4.5 0 0 1 4.5-4.5Z",
          fill: "none",
          stroke: "var(--white)",
          "stroke-width": "1.8",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
        svg("path", {
          d: "M7.75 13q1.375-3.75 2.75 0 1.375 3.75 2.75 0 1.375-3.75 2.75 0",
          fill: "none",
          stroke: "var(--white)",
          "stroke-width": "1.8",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      ),
      svg(
        "text",
        { x: cx, y: cy + 78, "text-anchor": "middle", "font-size": "13", fill: "var(--text-primary)" },
        "maio",
      ),
    ),
  );
}

/* Retrato estable por nombre; si no carga, queda la inicial dibujada debajo */
function photo(name, x, y, r, clipId) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 70;
  return svg("image", {
    href: `https://i.pravatar.cc/160?img=${hash + 1}`,
    x: x - r,
    y: y - r,
    width: r * 2,
    height: r * 2,
    "clip-path": `url(#${clipId})`,
    preserveAspectRatio: "xMidYMid slice",
  });
}
