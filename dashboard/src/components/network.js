import { el, mount, svg } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { calls as allCalls, clients, outcomeLabels, riskLabels } from "../data/api.js";
import { DEFAULT_RANGE, rangeById, stateLabel } from "../data/insights.js";
/** Only a patient_id from a BOOK receipt can link separate calls to the same patient. */
export function people(list) {
  const byCaller = new Map();
  for (const c of list) {
    const key = c.personKey;
    const e = byCaller.get(key) || {
      id: key,
      name: c.caller,
      count: 0,
      booked: 0,
      missed: 0,
      escalated: false,
      calls: [],
    };
    e.count += 1;
    e.booked += c.booked ? 1 : 0;
    e.missed += c.missed ? 1 : 0;
    e.escalated = e.escalated || c.outcome === "escalated";
    e.calls.push(c);
    byCaller.set(key, e);
  }
  return [...byCaller.values()].sort((a, b) => b.missed - a.missed || b.count - a.count);
}

export function networkPanel(list = allCalls, opts = {}) {
  const { state = "all", range = DEFAULT_RANGE } = opts;
  const host = el("div", { class: "map-full" });
  const nodes = people(list);
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let selected = null;
  const stage = el("div", { class: "map-full__stage" });
  const personHost = el("div", { class: "map-person", hidden: true });
  const zoomLabel = el("span", { class: "mono" }, "100%");

  function paint() {
    mount(stage, graph(nodes, zoom, pan, selected, pick));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  /* Mover el mapa sólo reescribe el transform: repintarlo entero en cada gesto iría a tirones */
  function applyPan() {
    stage.querySelector(".map__viewport")?.setAttribute("transform", viewport(zoom, pan));
  }

  function pick(person) {
    selected = selected?.id === person.id ? null : person;
    personHost.hidden = !selected;
    if (selected) mount(personHost, personCard(selected, range, () => pick(person)));
    paint();
  }

  function setZoom(next) {
    zoom = Math.min(2.2, Math.max(0.6, Number(next.toFixed(2))));
    paint();
  }

  function reset() {
    zoom = 1;
    pan = { x: 0, y: 0 };
    paint();
  }

  const totals = nodes.reduce(
    (acc, n) => ({ booked: acc.booked + n.booked, missed: acc.missed + n.missed }),
    { booked: 0, missed: 0 },
  );

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
        el(
          "div",
          { class: "chat-card__sub truncate" },
          `${stateLabel(state)} · ${rangeById(range).short} · ${nodes.length} identificadores · ${list.length} llamadas`,
        ),
      ),
      el(
        "span",
        { class: "map-full__tally ml-auto" },
        `${totals.booked} con reserva comunicada · `,
        el("strong", { class: "text-alert" }, `${totals.missed} sin acción`),
      ),
      el(
        "div",
        { class: "row", style: { gap: "6px" } },
        el("button", { class: "btn btn--icon", onclick: () => setZoom(zoom - 0.2), title: "Alejar" }, "−"),
        zoomLabel,
        el("button", { class: "btn btn--icon", onclick: () => setZoom(zoom + 0.2), title: "Ampliar" }, "+"),
        el("button", { class: "btn btn--sm", onclick: reset }, "Centrar"),
      ),
    ),
    el("div", { class: "map-full__canvas-wrap" }, stage, personHost),
    el(
      "footer",
      { class: "map-full__legend" },
      el("span", {}, "Pulsa un identificador para desplegar sus llamadas"),
      el("span", {}, "Una línea por llamada con el agente"),
      el("span", { class: "text-alert" }, "Rojo = NO_ACTION recibido"),
      el("span", { class: "ml-auto" }, "Arrastra para moverte · rueda o + / − para ampliar"),
    ),
  );

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  });

  let drag = null;
  let dragged = false;

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, from: { ...pan }, moved: false };
  });

  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;
      // Capturar antes de tiempo desviaría al lienzo el clic que selecciona a una persona
      drag.moved = true;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("is-grabbing");
    }
    const k = unitsPerPixel(stage);
    pan = { x: drag.from.x + dx * k, y: drag.from.y + dy * k };
    applyPan();
  });

  const endDrag = (e) => {
    if (!drag) return;
    if (drag.moved) {
      stage.releasePointerCapture?.(e.pointerId);
      stage.classList.remove("is-grabbing");
    }
    dragged = drag.moved;
    drag = null;
  };

  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // Arrastrar sobre una persona no debe abrir su ficha
  stage.addEventListener(
    "click",
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );

  if (nodes.length) paint();
  else mount(stage, el("div", { class: "empty" }, "Ninguna llamada con este filtro."));

  return host;
}

/* Ficha rápida de la persona seleccionada en el mapa */
function personCard(person, range, onClose) {
  const history = person.calls;
  const last = history[0];
  const client = findClient(person, last);
  const missed = history.filter((c) => c.missed);

  return el(
    "article",
    { class: "map-person__card" },
    el(
      "header",
      { class: "map-person__head" },
      el("span", { class: "avatar", "aria-hidden": "true" }, person.name[0]),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "map-person__name" }, person.name),
        el("div", { class: "map-person__meta" }, client ? `${client.id} · ${client.insurer}` : "Sin ficha de paciente"),
      ),
      el("button", { class: "btn btn--icon btn--ghost ml-auto", onclick: onClose, "aria-label": "Cerrar" }, "✕"),
    ),
    el(
      "dl",
      { class: "kv" },
      el("dt", {}, "Teléfono"),
      el("dd", { class: "mono" }, client?.phone || last?.phone || "—"),
      el("dt", {}, "Llamadas"),
      el("dd", {}, `${person.count} · ${rangeById(range).short}`),
      el("dt", {}, "Reservas comunicadas"),
      el("dd", {}, String(person.booked)),
      el("dt", {}, "Sin acción"),
      el("dd", { class: person.missed ? "text-alert" : "" }, String(person.missed)),
      el("dt", {}, "Próxima cita"),
      el("dd", {}, "Consultar ficha; no se infiere de /submit"),
    ),
    client &&
      el(
        "div",
        { class: "row row--wrap", style: { marginTop: "12px" } },
        ...client.tags.map((t) => el("span", { class: "chip" }, t)),
        pill(riskLabels[client.risk].text, riskLabels[client.risk].pill.replace("pill--", "")),
      ),
    missed.length > 0 &&
      el(
        "div",
        { class: "map-person__history" },
        el("div", { class: "section-title" }, `Sin acción (${missed.length})`),
        ...missed.slice(0, 6).map((h) =>
          el(
            "div",
            { class: "map-person__row" },
            el(
              "div",
              { style: { minWidth: 0 } },
              el("div", { class: "truncate" }, h.reason),
              el("div", { class: "map-person__why truncate" }, h.missReason || "NO_ACTION"),
            ),
            el("span", { class: "map-person__tag" }, h.time),
          ),
        ),
      ),
    history.length > 0 &&
      el(
        "div",
        { class: "map-person__history" },
        el("div", { class: "section-title" }, "Últimas llamadas"),
        ...history.slice(0, 3).map((h) =>
          el(
            "div",
            { class: "map-person__row" },
            el("span", { class: "truncate" }, h.reason),
            el("span", { class: "map-person__tag" }, outcomeLabels[h.outcome].text),
          ),
        ),
      ),
    el(
      "button",
      {
        class: "btn btn--primary btn--sm",
        style: { marginTop: "14px", width: "100%" },
        disabled: !client,
        onclick: () => client && openClient(client.id),
      },
      client ? "Ver más en Clientes" : "Sin ficha en Clientes",
    ),
  );
}

function findClient(person, last) {
  return last?.patientIds.length === 1 ? clients.find((client) => client.id === person.id) : undefined;
}

/* Si ya estamos en la ficha destino el hash no cambia, así que forzamos el repintado */
function openClient(id) {
  const target = `#/clientes/${encodeURIComponent(id)}`;
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = target;
}

function pill(text, variant) {
  return el("span", { class: `pill pill--${variant}` }, text);
}

const W = 1200;
const H = 760;

const viewport = (zoom, pan) =>
  `translate(${pan.x.toFixed(1)} ${pan.y.toFixed(1)}) translate(${W / 2} ${H / 2}) scale(${zoom}) translate(${-W / 2} ${-H / 2})`;

/* Un píxel de pantalla vale más de una unidad del viewBox: el lienzo se escala para caber */
function unitsPerPixel(stage) {
  const box = stage.querySelector("svg")?.getBoundingClientRect();
  if (!box?.width) return 1;
  return 1 / Math.min(box.width / W, box.height / H);
}

const edgeColor = (c) =>
  c.missed ? "var(--lipstick-red)" : c.booked ? "var(--pitch-black)" : "rgba(var(--ink-rgb), 0.45)";

/* Curva centro -> persona; devuelve también el punto en el parámetro t para colgar la etiqueta */
function curve(cx, cy, x, y, angle, bend, t = 0.5) {
  const mx = (cx + x) / 2 - Math.sin(angle) * bend;
  const my = (cy + y) / 2 + Math.cos(angle) * bend;
  const k = (1 - t) ** 2;
  const k2 = 2 * (1 - t) * t;
  const k3 = t ** 2;
  return {
    d: `M${cx} ${cy} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`,
    at: { x: k * cx + k2 * mx + k3 * x, y: k * cy + k2 * my + k3 * y },
  };
}

const MAX_EDGES = 6;

function graph(nodes, zoom, pan, selected, onSelect) {
  const w = W;
  const h = H;
  const cx = w / 2;
  const cy = h / 2;
  const edges = [];
  const labels = [];
  const dots = [];

  const inner = nodes.slice(0, Math.ceil(nodes.length / 2));
  const outer = nodes.slice(Math.ceil(nodes.length / 2));

  const place = (list, rx, ry, phase) =>
    list.forEach((n, i) => {
      const angle = -Math.PI / 2 + phase + (i / list.length) * Math.PI * 2;
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry;
      const isOn = selected?.id === n.id;
      // El trazo va de centro a centro: los círculos opacos lo rematan en sus bordes
      const bend = (i % 2 ? 1 : -1) * (18 + (i % 3) * 9);

      if (isOn) {
        // Al seleccionar, la relación se abre en una línea por llamada con su desenlace
        const shown = [...n.calls].sort((a, b) => Number(b.missed) - Number(a.missed)).slice(0, MAX_EDGES);
        shown.forEach((c, j) => {
          // Las etiquetas se escalonan a lo largo del trazo: es donde hay sitio
          const t = shown.length > 1 ? 0.28 + (j / (shown.length - 1)) * 0.44 : 0.5;
          const { d, at } = curve(cx, cy, x, y, angle, (j - (shown.length - 1) / 2) * 54, t);
          edges.push(
            svg("path", {
              d,
              fill: "none",
              stroke: edgeColor(c),
              "stroke-width": c.missed ? 1.9 : 1.2,
              "stroke-dasharray": c.missed ? "6 4" : null,
              "stroke-linecap": "round",
            }),
          );
          labels.push(
            svg(
              "text",
              { x: at.x, y: at.y - 3, "text-anchor": "middle", class: `map__edge-label${c.missed ? " is-missed" : ""}` },
              `${c.reason} · ${c.time}`,
            ),
            c.missReason &&
              svg("text", { x: at.x, y: at.y + 11, "text-anchor": "middle", class: "map__edge-why" }, c.missReason),
          );
        });
        if (n.calls.length > shown.length) {
          const { at } = curve(cx, cy, x, y, angle, 0, 0.92);
          labels.push(
            svg(
              "text",
              { x: at.x, y: at.y, "text-anchor": "middle", class: "map__edge-more" },
              `+${n.calls.length - shown.length} llamadas más en el plazo`,
            ),
          );
        }
      } else {
        edges.push(
          svg("path", {
            d: curve(cx, cy, x, y, angle, bend).d,
            fill: "none",
            stroke: n.missed ? "var(--lipstick-red)" : "rgba(var(--ink-rgb), 0.26)",
            "stroke-opacity": n.missed ? 0.5 : 1,
            "stroke-width": 0.6 + Math.min(n.count, 6) * 0.22,
            "stroke-linecap": "round",
          }),
        );
      }

      dots.push(
        svg(
          "g",
          {
            class: `map__node${isOn ? " is-on" : ""}`,
            onclick: () => onSelect?.(n),
          },
          svg("circle", { cx: x, cy: y, r: 23, fill: "var(--white)" }),
          svg(
            "text",
            { x, y: y + 5, "text-anchor": "middle", "font-size": "13", fill: "var(--text-secondary)" },
            n.name[0],
          ),
          svg("circle", {
            cx: x,
            cy: y,
            r: 23,
            fill: "none",
            stroke: isOn
              ? "var(--pitch-black)"
              : n.missed
                ? "var(--lipstick-red)"
                : "rgba(var(--ink-rgb), 0.35)",
            "stroke-width": isOn ? 2.4 : n.missed ? 1.8 : 1,
          }),
          svg("text", { x, y: y + 41, "text-anchor": "middle", class: "map__node-label" }, n.name),
          svg(
            "text",
            { x, y: y + 54, "text-anchor": "middle", class: `map__node-sub${n.missed ? " is-missed" : ""}` },
            n.missed
              ? `${n.missed} sin acción de ${n.count}`
              : `${n.count} ${n.count === 1 ? "llamada" : "llamadas"}`,
          ),
        ),
      );
    });

  place(inner, 300, 210, 0);
  place(outer, 500, 330, Math.PI / Math.max(outer.length, 1));

  return svg(
    "svg",
    { class: "map-full__canvas", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Red de maio" },
    svg(
      "g",
      { class: "map__viewport", transform: viewport(zoom, pan) },
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
      ...labels,
    ),
  );
}
