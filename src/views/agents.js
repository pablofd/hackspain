import { el, mount, svg } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, toggle } from "../components/ui.js";
import { openDrawer } from "../components/drawer.js";
import { agents, calls, statusLabels } from "../data/mock.js";

export const meta = {
  title: "Agentes",
  sub: "Recepcionistas virtuales, su voz, sus permisos y sus acciones",
};

export function render() {
  let mapOpen = false;
  let focused = agents[0];

  const board = el("div", { class: "grid grid--3 grid--agents" });
  const mapHost = el("aside", { class: "map", hidden: true });

  function renderBoard() {
    if (mapOpen) mount(board, agentList(), mapHost);
    else mount(board, ...agents.map(agentCard));
    board.classList.toggle("is-map", mapOpen);
    board.classList.toggle("grid--3", !mapOpen);
    mapHost.hidden = !mapOpen;
    if (mapOpen) mount(mapHost, mapPanel(focused));
  }

  function agentList() {
    return card(
      { flush: true },
      ...agents.map((a) =>
        el(
          "button",
          {
            class: `agent-row${a.id === focused.id ? " is-active" : ""}`,
            onclick: () => {
              focused = a;
              renderBoard();
            },
          },
          el("span", { class: "avatar" }, a.name[0]),
          el(
            "span",
            { style: { minWidth: 0 } },
            el("span", { class: "agent-row__name", style: { display: "block" } }, a.name),
            el("span", { class: "agent-row__meta truncate", style: { display: "block" } }, a.role),
          ),
          el("span", { class: "agent-row__count" }, `${graphFor(a).length} pacientes`),
        ),
      ),
    );
  }

  const mapBtn = el(
    "button",
    {
      class: "btn",
      onclick: () => {
        mapOpen = !mapOpen;
        mapBtn.classList.toggle("btn--primary", mapOpen);
        mapBtn.lastChild.textContent = mapOpen ? "Ocultar mapa" : "Ver mapa";
        renderBoard();
      },
    },
    icon("relations", "nav__icon"),
    el("span", {}, "Ver mapa"),
  );

  renderBoard();

  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "row row--wrap" },
      el(
        "div",
        { class: "segmented" },
        el("button", { class: "is-active" }, "Todos"),
        el("button", {}, "En línea"),
        el("button", {}, "En pausa"),
        el("button", {}, "Borradores"),
      ),
      mapBtn,
    ),
    board,
  );
}

function agentCard(a) {
  const status = statusLabels[a.status];
  return el(
    "article",
    { class: "agent-card grain" },
    el(
      "div",
      { class: "agent-card__top" },
      el("div", { class: `agent-card__avatar agent-card__avatar--${a.tone}` }, a.name[0]),
      el(
        "div",
        { style: { minWidth: "0" } },
        el("div", { class: "agent-card__name" }, a.name),
        el("div", { class: "agent-card__role truncate" }, a.role),
      ),
      el(
        "div",
        { class: "ml-auto" },
        pill(status.text, status.pill.replace("pill--", ""), a.status === "online"),
      ),
    ),
    el(
      "div",
      { class: "row" },
      el("span", { class: "text-sm muted" }, a.calls ? `${a.calls} llamadas · ${a.resolution}%` : "Sin actividad"),
      el(
        "button",
        { class: "btn btn--sm ml-auto", onclick: () => editAgentDrawer(a) },
        "Editar agente",
      ),
    ),
  );
}

function editAgentDrawer(a) {
  openDrawer({
    title: a.name,
    sub: a.role,
    body: () => [
      el(
        "div",
        { class: "agent-card__metrics", style: { marginBottom: "22px", borderTop: "0", paddingTop: "0" } },
        metric("Llamadas", a.calls),
        metric("Resolución", `${a.resolution}%`),
        metric("Media", a.avgHandle),
      ),
      field("Nombre", el("input", { class: "input", value: a.name })),
      field("Rol", el("input", { class: "input", value: a.role })),
      field(
        "Voz",
        el(
          "select",
          { class: "select" },
          el("option", {}, a.voice),
          el("option", {}, "Sofía Neural"),
          el("option", {}, "Álvaro Neural"),
        ),
      ),
      field("Idiomas", el("input", { class: "input", value: a.language })),
      el("div", { class: "section-title" }, "Acciones habilitadas"),
      el(
        "div",
        { class: "chips", style: { marginBottom: "22px" } },
        ...a.skills.map((s) => el("span", { class: "chip" }, s)),
        el("button", { class: "btn btn--sm btn--ghost" }, "Añadir"),
      ),
      el("div", { class: "section-title" }, "Canales"),
      el(
        "div",
        { class: "chips", style: { marginBottom: "22px" } },
        ...a.channels.map((s) => el("span", { class: "chip" }, s)),
      ),
      el("div", { class: "section-title" }, "Comportamiento"),
      ...[
        ["Agente activo", "Atiende llamadas entrantes", a.status === "online"],
        ["Escalado automático", "Transfiere ante banderas rojas", true],
        ["Grabación", "Requerido para auditoría clínica", true],
      ].map(([t, d, on]) =>
        el(
          "div",
          { class: "toggle-row" },
          el(
            "div",
            { class: "toggle-row__body" },
            el("div", { class: "toggle-row__title" }, t),
            el("div", { class: "toggle-row__desc" }, d),
          ),
          toggle(on),
        ),
      ),
    ],
    footer: (close) => [
      el("button", { class: "btn btn--primary", onclick: close }, "Guardar cambios"),
      el("button", { class: "btn btn--ghost" }, "Probar voz"),
      el("button", { class: "btn btn--ghost ml-auto", onclick: close }, "Cancelar"),
    ],
  });
}

export function openNewAgent() {
  openDrawer({
    title: "Nuevo agente",
    sub: "Cuatro datos y empieza a atender",
    body: () => [
      field("Nombre", el("input", { class: "input", placeholder: "Nora" })),
      field(
        "Plantilla",
        el(
          "select",
          { class: "select" },
          el("option", {}, "Recepción general"),
          el("option", {}, "Triaje clínico"),
          el("option", {}, "Resultados de pruebas"),
          el("option", {}, "Campaña saliente"),
        ),
      ),
      field(
        "Voz",
        el(
          "select",
          { class: "select" },
          el("option", {}, "Sofía Neural"),
          el("option", {}, "Álvaro Neural"),
          el("option", {}, "Lucía Neural"),
        ),
      ),
      field("Idiomas", el("input", { class: "input", value: "Español" })),
    ],
    footer: (close) => [
      el("button", { class: "btn btn--primary", onclick: close }, "Crear agente"),
      el("button", { class: "btn btn--ghost ml-auto", onclick: close }, "Cancelar"),
    ],
  });
}

function field(label, control) {
  return el("div", { class: "field" }, el("label", {}, label), control);
}

function metric(label, value) {
  return el("div", { class: "agent-card__metric" }, el("span", {}, label), el("strong", {}, String(value)));
}

/* Pacientes con los que ha hablado el agente, agregados por persona */
function graphFor(a) {
  const byCaller = new Map();
  for (const c of calls) {
    if (c.agent !== a.name) continue;
    const e = byCaller.get(c.caller) || { name: c.caller, count: 0, escalated: false, reason: c.reason };
    e.count += 1;
    e.escalated = e.escalated || c.outcome === "escalated";
    byCaller.set(c.caller, e);
  }
  return [...byCaller.values()];
}

function mapPanel(a) {
  const nodes = graphFor(a);
  const totalCalls = nodes.reduce((s, n) => s + n.count, 0);
  return card(
    {
      title: `Red de ${a.name}`,
      sub: nodes.length
        ? `${nodes.length} pacientes · ${totalCalls} conversaciones`
        : "Todavía no ha hablado con nadie",
    },
    nodes.length ? graph(a, nodes) : el("div", { class: "empty" }, "Sin conversaciones registradas."),
    nodes.length &&
      el(
        "div",
        { class: "map__legend" },
        el("span", {}, "Grosor de la flecha = número de llamadas"),
        el("span", { class: "text-alert" }, "Rojo = hubo escalado a humano"),
      ),
  );
}

function graph(a, nodes) {
  const w = 560;
  const h = 400;
  const cx = w / 2;
  const cy = h / 2;
  const rx = 200;
  const ry = 142;
  const arrow = `arrow-${Math.random().toString(36).slice(2, 7)}`;
  const arrowHot = `${arrow}-hot`;

  const edges = [];
  const dots = [];

  nodes.forEach((n, i) => {
    const angle = (-Math.PI / 2) + (i / nodes.length) * Math.PI * 2;
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;
    const from = { x: cx + Math.cos(angle) * 48, y: cy + Math.sin(angle) * 48 };
    const to = { x: x - Math.cos(angle) * 30, y: y - Math.sin(angle) * 30 };
    const mid = { x: (from.x + to.x) / 2 - Math.sin(angle) * 22, y: (from.y + to.y) / 2 + Math.cos(angle) * 22 };

    edges.push(
      svg("path", {
        d: `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${mid.x.toFixed(1)} ${mid.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
        fill: "none",
        stroke: n.escalated ? "var(--lipstick-red)" : "var(--dusty-denim)",
        "stroke-width": 1 + Math.min(n.count, 4) * 0.7,
        "marker-end": `url(#${n.escalated ? arrowHot : arrow})`,
        opacity: 0.85,
      }),
    );

    dots.push(
      svg(
        "g",
        {},
        svg("circle", {
          cx: x,
          cy: y,
          r: 21,
          fill: "var(--white)",
          stroke: n.escalated ? "var(--lipstick-red)" : "var(--stroke-strong)",
          "stroke-width": 1.2,
        }),
        svg(
          "text",
          { x, y: y + 4, "text-anchor": "middle", "font-size": "12", fill: "var(--text-primary)" },
          n.name[0],
        ),
        svg("text", { x, y: y + 38, "text-anchor": "middle", class: "map__node-label" }, n.name),
        svg(
          "text",
          { x, y: y + 51, "text-anchor": "middle", class: "map__node-sub" },
          `${n.count} ${n.count === 1 ? "llamada" : "llamadas"}`,
        ),
      ),
    );
  });

  return svg(
    "svg",
    { class: "map__canvas", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": `Red de ${a.name}` },
    svg(
      "defs",
      {},
      marker(arrow, "var(--dusty-denim)"),
      marker(arrowHot, "var(--lipstick-red)"),
    ),
    ...edges,
    svg("circle", { cx, cy, r: 46, fill: "var(--pitch-black)" }),
    svg(
      "text",
      { x: cx, y: cy + 2, "text-anchor": "middle", "font-size": "20", fill: "var(--white)" },
      a.name[0],
    ),
    svg(
      "text",
      { x: cx, y: cy + 20, "text-anchor": "middle", "font-size": "9.5", fill: "rgba(255,255,255,0.72)" },
      a.name,
    ),
    ...dots,
  );
}

function marker(id, color) {
  return svg(
    "marker",
    {
      id,
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "5",
      markerHeight: "5",
      orient: "auto-start-reverse",
    },
    svg("path", { d: "M0 1 L9 5 L0 9 z", fill: color }),
  );
}
