import { el, mount, svg } from "../lib/dom.js";
import { FINN_THE_HUMAN_PATH, icon } from "../lib/icons.js";
import { api, formatDate, outcomeLabels, riskLabels } from "../data/api.js";
import { getPresentation } from "../data/presentation.js";
import { DEFAULT_RANGE, rangeById, stateLabel } from "../data/insights.js";
/** Only a patient_id from a BOOK receipt can link separate calls to the same patient. */
export function people(list) {
  const byCaller = new Map();
  for (const c of list) {
    const identities = [...new Set(c.patientIds ?? [])];
    for (const key of identities) {
    const client = getPresentation().clients.find((person) => person.id === key);
    const knownName = client?.name || (identities.length === 1 &&
      !/^(?:Llamada|Paciente)\s/.test(c.caller) ? c.caller : null);
    const e = byCaller.get(key) || {
      id: key,
      name: knownName,
      simulated: c.simulated === true,
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
  }
  return [...byCaller.values()].sort((a, b) => b.missed - a.missed || b.count - a.count)
    .map((person, index) => ({ ...person, nameKnown: Boolean(person.name), name: person.name || `Paciente ${index + 1}` }));
}

export function networkPanel(list = getPresentation().calls, opts = {}) {
  let { state = "all", range = DEFAULT_RANGE } = opts;
  const host = el("div", { class: "map-full" });
  let nodes = people(list);
  let page = 0;
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let selected = null;
  let detailRequest;
  let detailGeneration = 0;
  const agendas = new Map();
  const stage = el("div", { class: "map-full__stage" });
  const personHost = el("div", { class: "map-person", hidden: true });
  const zoomLabel = el("span", { class: "mono" }, "100%");
  const subtitle = el("div", { class: "chat-card__sub truncate" });
  const tally = el("span", { class: "map-full__tally ml-auto" });
  const pageLabel = el("span", { class: "mono", "aria-live": "polite" });
  const previous = el("button", {
    class: "btn btn--icon", title: "Identificadores anteriores", "aria-label": "Identificadores anteriores",
    onclick: () => changePage(-1),
  }, "‹");
  const next = el("button", {
    class: "btn btn--icon", title: "Identificadores siguientes", "aria-label": "Identificadores siguientes",
    onclick: () => changePage(1),
  }, "›");

  function paint() {
    const visible = nodes.slice(page * MAX_NODES, (page + 1) * MAX_NODES);
    if (visible.length) mount(stage, graph(visible, zoom, pan, selected, pick));
    else mount(stage, el("div", { class: "empty" }, list.length
      ? "Sin personas vinculadas a una ficha en este filtro. Las llamadas siguen disponibles en la lista."
      : "Ninguna llamada con este filtro."));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    subtitle.textContent = `${stateLabel(state)} · ${rangeById(range).short} · ${visible.length} de ${nodes.length} personas · ${list.length} llamadas`;
    const totals = nodes.reduce((acc, node) => ({
      booked: acc.booked + node.booked, missed: acc.missed + node.missed,
    }), { booked: 0, missed: 0 });
    mount(tally, `${totals.booked} con reserva comunicada · `,
      el("strong", { class: "text-alert" }, `${totals.missed} sin acción`));
    pageLabel.textContent = `${page + 1} / ${Math.max(1, Math.ceil(nodes.length / MAX_NODES))}`;
    previous.disabled = page === 0;
    next.disabled = (page + 1) * MAX_NODES >= nodes.length;
  }

  function changePage(direction) {
    page = Math.max(0, Math.min(Math.ceil(nodes.length / MAX_NODES) - 1, page + direction));
    selected = null;
    detailGeneration += 1;
    detailRequest?.abort();
    personHost.hidden = true;
    reset();
  }
  /* Mover el mapa sólo reescribe el transform: repintarlo entero en cada gesto iría a tirones */
  function applyPan() {
    stage.querySelector(".map__viewport")?.setAttribute("transform", viewport(zoom, pan));
  }

  function pick(person) {
    if (person && selected?.id === person.id) return;
    if (stage.classList.contains("is-grabbing")) return;
    selected = person;
    const generation = ++detailGeneration;
    detailRequest?.abort();
    personHost.hidden = !selected;
    if (selected) {
      const current = selected;
      const cached = agendas.get(current.id);
      mount(personHost, personCard(current, range, () => pick(null), cached));
      if (!current.simulated && (!cached || Date.now() - cached.at > 60_000)) {
        detailRequest = new AbortController();
        const signal = detailRequest.signal;
        void api(`/api/dashboard/patients/${encodeURIComponent(current.id)}/appointments`, signal).then((result) => {
          if (signal.aborted || generation !== detailGeneration || selected?.id !== current.id) return;
          if (!Array.isArray(result.appointments)) throw new Error("dashboard_invalid_appointments");
          const agenda = { status: "ok", appointments: result.appointments, at: Date.now() };
          agendas.set(current.id, agenda);
          mount(personHost, personCard(current, range, () => pick(null), agenda));
        }).catch((error) => {
          if (signal.aborted || generation !== detailGeneration || selected?.id !== current.id) return;
          const agenda = { status: "error", code: error.message, at: Date.now() };
          agendas.set(current.id, agenda);
          mount(personHost, personCard(current, range, () => pick(null), agenda));
        });
      }
    }
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
        subtitle,
      ),
      tally,
      el("div", { class: "row", style: { gap: "6px" } }, previous, pageLabel, next),
      el(
        "div",
        { class: "row", style: { gap: "6px" } },
        el("button", { class: "btn btn--icon", onclick: () => setZoom(zoom - 0.2), title: "Alejar", "aria-label": "Alejar" }, "−"),
        zoomLabel,
        el("button", { class: "btn btn--icon", onclick: () => setZoom(zoom + 0.2), title: "Ampliar", "aria-label": "Ampliar" }, "+"),
        el("button", { class: "btn btn--sm", onclick: reset }, "Centrar"),
      ),
    ),
    el("div", { class: "map-full__canvas-wrap" }, stage, personHost),
    el(
      "footer",
      { class: "map-full__legend" },
      el("span", {}, "Pasa el cursor, enfoca o pulsa una persona para ver su ficha"),
      el("span", {}, "La selección muestra sus llamadas con el agente; no vínculos entre personas"),
      el("span", { class: "text-alert" }, "Rojo = NO_ACTION recibido"),
      el("span", {}, "Fotos ilustrativas · alias cuando el nombre no está consultado"),
      el("span", { class: "ml-auto" }, "Arrastra · rueda o + / − para ampliar"),
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

  host.update = (nextList, nextOptions = {}) => {
    list = nextList;
    state = nextOptions.state ?? state;
    range = nextOptions.range ?? range;
    nodes = people(list);
    page = Math.min(page, Math.max(0, Math.ceil(nodes.length / MAX_NODES) - 1));
    if (selected) {
      selected = nodes.find((node) => node.id === selected.id) ?? null;
      personHost.hidden = !selected;
      if (selected) mount(personHost, personCard(selected, range, () => pick(null), agendas.get(selected.id)));
    }
    paint();
  };
  host.dispose = () => { detailGeneration += 1; detailRequest?.abort(); };
  paint();
  return host;
}

/* Ficha rápida de la persona seleccionada en el mapa */
function personCard(person, range, onClose, agenda) {
  const history = person.calls;
  const last = history[0];
  const client = findClient(person, last);
  const missed = history.filter((c) => c.missed);
  const source = getPresentation();
  const upcoming = agenda?.appointments?.slice().sort((left, right) => Date.parse(left.start) - Date.parse(right.start))[0];
  const provider = source.snapshot?.clinic?.providers.find((item) => item.id === upcoming?.providerId);
  const site = source.snapshot?.clinic?.locations.find((item) => item.id === upcoming?.locationId);
  const lastReceipt = source.snapshot?.calls.find((call) => call.id === last?.id);
  const booking = lastReceipt?.actions.find((action) => action.action === "BOOK" && action.patientId === person.id);
  const bookingProvider = source.snapshot?.clinic?.providers.find((item) => item.id === booking?.providerId);
  const bookingSite = source.snapshot?.clinic?.locations.find((item) => item.id === booking?.locationId);
  const bookingPlan = source.snapshot?.clinic?.plans?.find((item) => item.id === booking?.policyId);

  return el(
    "article",
    { class: "map-person__card" },
    el(
      "header",
      { class: "map-person__head" },
      person.simulated
        ? el("img", { class: "map-person__photo", src: portrait(person.id), alt: "Retrato ilustrativo; no es una foto del paciente" })
        : el("span", { class: "map-person__photo map-person__photo--fallback", role: "img",
          "aria-label": "Sin fotografía; icono Finn the Human" }, icon("finn", "map-person__photo-icon")),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "map-person__name" }, person.name),
        el("div", { class: "map-person__meta" }, person.nameKnown
          ? `${client?.insurer ?? "Aseguradora no consultada"}${person.simulated ? " · demo" : ""}`
          : "Alias de una ficha vinculada; nombre no consultado"),
      ),
      el("button", { class: "btn btn--icon btn--ghost ml-auto", onclick: onClose, "aria-label": "Cerrar" }, "✕"),
    ),
    el(
      "dl",
      { class: "kv" },
      el("dt", {}, "ID de paciente"),
      el("dd", { class: "mono" }, person.id),
      el("dt", {}, "Teléfono"),
      el("dd", { class: "mono" }, client?.phone || last?.phone || "—"),
      el("dt", {}, "Llamadas"),
      el("dd", {}, `${person.count} · ${rangeById(range).short}`),
      el("dt", {}, "Reservas comunicadas"),
      el("dd", {}, String(person.booked)),
      el("dt", {}, "Sin acción"),
      el("dd", { class: person.missed ? "text-alert" : "" }, String(person.missed)),
      el("dt", {}, "Próxima cita"),
      el("dd", {}, person.simulated ? `${client?.nextAppt ?? "Cita de ejemplo"} · simulada`
        : agenda?.status === "error" ? `No disponible: ${agenda.code}`
        : !agenda ? "Consultando agenda del EHR…"
        : upcoming ? formatDate(upcoming.start) : "Sin citas futuras en el EHR"),
      el("dt", {}, "Profesional / sede"),
      el("dd", {}, person.simulated ? "Profesional y sede de ejemplo"
        : upcoming ? `${provider?.name ?? upcoming.providerId} · ${site?.name ?? upcoming.locationId}`
        : "Sin cita próxima consultada"),
      el("dt", {}, "Última llamada"),
      el("dd", {}, last?.time ?? "No disponible"),
      el("dt", {}, "Duración"),
      el("dd", {}, last?.duration ?? "No disponible"),
      el("dt", {}, "Último resultado"),
      el("dd", {}, last ? outcomeLabels[last.outcome].text : "No disponible"),
      el("dt", {}, "Reserva comunicada"),
      el("dd", {}, person.simulated ? "Reserva de ejemplo · sin envío"
        : booking?.slot ? `${formatDate(booking.slot)} · ${bookingProvider?.name ?? booking.providerId} · ${bookingSite?.name ?? booking.locationId}`
        : "Sin BOOK recibido en la última llamada"),
      el("dt", {}, "Plan usado en la reserva"),
      el("dd", {}, person.simulated ? "Plan de ejemplo" : bookingPlan?.name ?? booking?.policyId ?? "No consultado"),
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
        ...history.slice(0, 6).map((h) =>
          el(
            "div",
            { class: "map-person__row" },
            el("div", { style: { minWidth: 0 } },
              el("a", { href: `#/llamadas?llamada=${encodeURIComponent(h.id)}&rango=${encodeURIComponent(range)}`,
                class: "truncate" }, h.reason),
              el("div", { class: "cell-sub mono", style: { overflowWrap: "anywhere" } }, `ID: ${h.id}`),
              el("div", { class: "cell-sub" }, `${h.time} · ${h.duration}`)),
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
  return last?.patientIds.includes(person.id) ? getPresentation().clients.find((client) => client.id === person.id) : undefined;
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
const MAP_CENTER = { x: W / 2, y: 350 };
const RADII = [235, 340, 270, 320, 220, 300, 250, 335, 230, 310, 260, 330];

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

const MAX_EDGES = 3;
const MAX_NODES = 12;

function portrait(id) {
  return `/design/portraits/portrait-${String(hash(id) % 12 + 1).padStart(2, "0")}.jpg`;
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) result = Math.imul(result ^ character.codePointAt(0), 16777619);
  return result >>> 0;
}

/** Stable radial slots with deliberately varied distances from the maio hub. */
export function layoutPeople(nodes) {
  const ordered = [...nodes].sort((left, right) => hash(left.id) - hash(right.id) ||
    String(left.id).localeCompare(String(right.id)));
  return ordered.map((node, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / ordered.length;
    const radius = RADII[index % RADII.length];
    return {
      node,
      radius,
      x: MAP_CENTER.x + Math.cos(angle) * radius * 1.35,
      y: MAP_CENTER.y + Math.sin(angle) * radius * 0.84,
    };
  });
}

function nodeLabel(node) {
  const name = node.name;
  return name.length > 23 ? `${name.slice(0, 22)}…` : name;
}

function graph(nodes, zoom, pan, selected, onSelect) {
  const w = W;
  const h = H;
  const { x: cx, y: cy } = MAP_CENTER;
  const edges = [];
  const labels = [];
  const dots = [];
  const clips = [];

  layoutPeople(nodes).forEach(({ node: n, x, y, radius }) => {
      const angle = Math.atan2(y - cy, x - cx);
      const isOn = selected?.id === n.id;
      const clipId = `portrait-${hash(n.id)}`;
      clips.push(svg("clipPath", { id: clipId }, svg("circle", { cx: x, cy: y, r: 29 })));

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
              c.reason.length > 42 ? `${c.reason.slice(0, 41)}…` : c.reason,
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
      }

      dots.push(
        svg(
          "g",
          {
            class: `map__node${isOn ? " is-on" : ""}`,
            "data-person-id": n.id, "data-x": x, "data-y": y, "data-radius": radius,
            role: "button", tabindex: 0, "aria-label": `${n.name}, ${n.count} llamadas`,
            onclick: () => onSelect?.(n),
            onmouseenter: () => onSelect?.(n),
            onfocus: () => onSelect?.(n),
            onkeydown: (event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(n); }
            },
          },
          svg("title", {}, `${n.name} · ${n.count} llamadas`),
          svg("circle", { cx: x, cy: y, r: 29, fill: "var(--white)" }),
          n.simulated
            ? svg("image", { href: portrait(n.id), x: x - 29, y: y - 29, width: 58, height: 58,
              "clip-path": `url(#${clipId})`, preserveAspectRatio: "xMidYMid slice" })
            : svg("g", { class: "map__node-fallback", transform: `translate(${x - 20} ${y - 20}) scale(0.15625)` },
              svg("path", { d: FINN_THE_HUMAN_PATH })),
          svg("circle", {
            cx: x,
            cy: y,
            r: 29,
            fill: "none",
            stroke: isOn
              ? "var(--pitch-black)"
              : n.missed
                ? "var(--lipstick-red)"
                : "rgba(var(--ink-rgb), 0.35)",
            "stroke-width": isOn ? 2.4 : n.missed ? 1.8 : 1,
          }),
          svg("text", { x, y: y + 48, "text-anchor": "middle", class: "map__node-label", style: "font-size: 14px" }, nodeLabel(n)),
          svg(
            "text",
            { x, y: y + 64, "text-anchor": "middle", class: `map__node-sub${n.missed ? " is-missed" : ""}`, style: "font-size: 12px" },
            n.missed
              ? `${n.missed} sin acción de ${n.count}`
              : `${n.count} ${n.count === 1 ? "llamada" : "llamadas"}`,
          ),
        ),
      );
    });

  return svg(
    "svg",
    { class: "map-full__canvas", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Red de maio" },
    svg("defs", {}, ...clips),
    svg(
      "g",
      { class: "map__viewport", transform: viewport(zoom, pan) },
      ...edges,
      ...dots,
      svg("circle", { cx, cy, r: 34, fill: "var(--pitch-black)", class: "map__hub" }),
      svg(
        "g",
        { transform: `translate(${cx - 12} ${cy - 12})` },
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
        { x: cx, y: cy + 52, "text-anchor": "middle", "font-size": "13", fill: "var(--text-primary)" },
        "maio",
      ),
      ...labels,
    ),
  );
}
