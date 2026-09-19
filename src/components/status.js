import { el, svg } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { TRAITS, POLICIES, behaviourDefaults } from "../data/mock.js";

const SIZE = 260;
const CENTER = SIZE / 2;
const RADIUS = 94;
const EASE = (t) => 1 - (1 - t) ** 3;

/** Telaraña viva de rasgos: se anima al cambiar y traduce el ajuste a lenguaje llano. */
export function statusCard(state) {
  const shown = { ...state.traits };
  let raf = null;

  const shape = svg("polygon", {
    class: "status__shape",
    fill: "url(#status-fill)",
    stroke: "var(--pitch-black)",
    "stroke-width": 1.6,
    "stroke-linejoin": "round",
  });

  const ghost = svg("polygon", {
    class: "status__ghost",
    points: pointsFor(behaviourDefaults.traits),
    fill: "none",
    stroke: "rgba(var(--ink-rgb), 0.32)",
    "stroke-width": 1,
    "stroke-dasharray": "3 4",
  });

  const dots = TRAITS.map(() => svg("circle", { r: 3.2, fill: "var(--pitch-black)" }));
  const cellValues = TRAITS.map(() => el("span", { class: "status__cell-value mono" }, "0"));
  const taglineNode = el("div", { class: "status__tagline" });
  const notesHost = el("div", { class: "status__notes" });
  const stats = {
    duracion: el("strong", {}, "—"),
    escalado: el("strong", {}, "—"),
    satisfaccion: el("strong", {}, "—"),
  };

  function paintShape() {
    shape.setAttribute("points", pointsFor(shown));
    TRAITS.forEach(([key], i) => {
      const [x, y] = point(i, shown[key]);
      dots[i].setAttribute("cx", x.toFixed(1));
      dots[i].setAttribute("cy", y.toFixed(1));
      cellValues[i].textContent = String(Math.round(shown[key]));
    });
  }

  function animateTo(target) {
    const from = { ...shown };
    const start = performance.now();
    cancelAnimationFrame(raf);
    const step = (now) => {
      const t = EASE(Math.min(1, (now - start) / 460));
      for (const [key] of TRAITS) shown[key] = from[key] + (target[key] - from[key]) * t;
      paintShape();
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function update(next) {
    animateTo(next.traits);
    taglineNode.textContent = profileName(next.traits);
    const f = forecast(next);
    stats.duracion.textContent = f.duracion;
    stats.escalado.textContent = f.escalado;
    stats.satisfaccion.textContent = f.satisfaccion;
    notesHost.replaceChildren(
      el("div", { class: "section-title" }, "Cómo se comporta ahora"),
      ...insights(next).map((t) =>
        el("p", { class: "status__note" }, el("span", { class: "status__bullet" }), t),
      ),
    );
  }

  const node = el(
    "section",
    { class: "status" },
    el(
      "header",
      { class: "status__head brand-wash" },
      icon("maio", "status__logo"),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "status__name" }, "maio"),
        taglineNode,
      ),
      el(
        "span",
        { class: "status__eq" },
        el("i", {}),
        el("i", {}),
        el("i", {}),
        el("i", {}),
        el("i", {}),
      ),
    ),
    el(
      "div",
      { class: "status__body" },
      svg(
        "svg",
        { class: "status__radar", viewBox: `-24 -10 ${SIZE + 48} ${SIZE + 20}`, role: "img" },
        svg(
          "defs",
          {},
          svg(
            "radialGradient",
            { id: "status-fill", cx: "50%", cy: "50%", r: "50%" },
            svg("stop", { offset: "0%", "stop-color": "var(--dusty-denim)", "stop-opacity": "0.55" }),
            svg("stop", { offset: "100%", "stop-color": "var(--dusty-denim)", "stop-opacity": "0.14" }),
          ),
          svg(
            "linearGradient",
            { id: "status-sweep", x1: "0", y1: "0", x2: "1", y2: "0" },
            svg("stop", { offset: "0%", "stop-color": "var(--pitch-black)", "stop-opacity": "0" }),
            svg("stop", { offset: "100%", "stop-color": "var(--pitch-black)", "stop-opacity": "0.16" }),
          ),
        ),
        ...[0.25, 0.5, 0.75, 1].map((f) =>
          svg("polygon", {
            points: ringPoints(f),
            fill: "none",
            stroke: "rgba(var(--ink-rgb), 0.12)",
            "stroke-width": 1,
          }),
        ),
        ...TRAITS.map((_, i) => {
          const [x, y] = point(i, 100);
          return svg("line", {
            x1: CENTER,
            y1: CENTER,
            x2: x,
            y2: y,
            stroke: "rgba(var(--ink-rgb), 0.12)",
            "stroke-width": 1,
          });
        }),
        svg(
          "g",
          { class: "status__sweep", style: `transform-origin:${CENTER}px ${CENTER}px` },
          svg("path", {
            d: `M${CENTER} ${CENTER} L${CENTER + RADIUS} ${CENTER - RADIUS * 0.42} A${RADIUS} ${RADIUS} 0 0 1 ${CENTER + RADIUS} ${CENTER} Z`,
            fill: "url(#status-sweep)",
          }),
          svg("line", {
            x1: CENTER,
            y1: CENTER,
            x2: CENTER + RADIUS,
            y2: CENTER,
            stroke: "rgba(var(--ink-rgb), 0.4)",
            "stroke-width": 1,
          }),
        ),
        ghost,
        shape,
        ...dots,
        ...TRAITS.map(([, label], i) => {
          const [x, y] = point(i, 130);
          return svg(
            "text",
            {
              x,
              y: y + 3,
              "text-anchor": x > CENTER + 6 ? "start" : x < CENTER - 6 ? "end" : "middle",
              class: "status__axis",
            },
            label,
          );
        }),
        svg("circle", { cx: CENTER, cy: CENTER, r: 3, fill: "var(--pitch-black)" }),
        svg("circle", { class: "status__ping", cx: CENTER, cy: CENTER, r: 3, fill: "none", stroke: "var(--pitch-black)" }),
      ),
      el(
        "div",
        { class: "status__grid" },
        ...TRAITS.map(([, label], i) =>
          el(
            "div",
            { class: "status__cell" },
            el("span", { class: "status__cell-label" }, label),
            cellValues[i],
          ),
        ),
      ),
    ),
    el(
      "div",
      { class: "status__stats" },
      statBlock("Duración media", stats.duracion),
      statBlock("Escalado previsto", stats.escalado),
      statBlock("Satisfacción", stats.satisfaccion),
    ),
    notesHost,
    el(
      "div",
      { class: "status__foot" },
      el("span", { class: "dot dot--pulse" }),
      el("span", {}, "Simulación sobre las últimas 965 llamadas"),
    ),
  );

  node.update = update;
  update(state);
  paintShape();
  return node;
}

function statBlock(label, valueNode) {
  return el("div", { class: "status__stat" }, el("span", {}, label), valueNode);
}

function point(i, value) {
  const angle = -Math.PI / 2 + (i / TRAITS.length) * Math.PI * 2;
  const r = (value / 100) * RADIUS;
  return [CENTER + Math.cos(angle) * r, CENTER + Math.sin(angle) * r];
}

const pointsFor = (traits) =>
  TRAITS.map(([key], i) => point(i, traits[key]).map((n) => n.toFixed(1)).join(",")).join(" ");

const ringPoints = (f) =>
  TRAITS.map((_, i) => point(i, f * 100).map((n) => n.toFixed(1)).join(",")).join(" ");

/* Etiqueta de personalidad a partir de los dos rasgos dominantes */
function profileName(t) {
  const sorted = [...TRAITS].sort((a, b) => t[b[0]] - t[a[0]]);
  const words = {
    asertividad: "directo",
    empatia: "cálido",
    iniciativa: "resolutivo",
    rigor: "riguroso",
    brevedad: "conciso",
    paciencia: "paciente",
  };
  return `Perfil ${words[sorted[0][0]]} y ${words[sorted[1][0]]}`;
}

/* Proyección orientativa del efecto de los ajustes */
function forecast({ traits: t, policies: p }) {
  const seconds = Math.round(96 + (100 - t.brevedad) * 1.5 + t.empatia * 0.45 + t.paciencia * 0.35);
  const escalado = clamp(4 + (t.rigor - 50) * 0.1 + [3, 1.5, 0][p.urgencia] - (t.asertividad - 50) * 0.04, 1, 24);
  const satisfaccion = clamp(58 + t.empatia * 0.28 + t.paciencia * 0.1 - Math.max(0, t.asertividad - 80) * 0.3, 40, 99);
  return {
    duracion: `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`,
    escalado: `${escalado.toFixed(1)}%`,
    satisfaccion: `${Math.round(satisfaccion)}%`,
  };
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function insights(state) {
  const { traits: t, policies: p } = state;
  const out = [];

  out.push(
    t.asertividad > 70
      ? "Lleva la iniciativa de la conversación y propone el cierre pronto."
      : t.asertividad < 40
        ? "Sigue el ritmo del paciente y evita presionar."
        : "Equilibra escucha y dirección de la llamada.",
  );

  out.push(
    t.empatia > 75
      ? "Reconoce la emoción antes de resolver: baja la tensión en llamadas difíciles."
      : "Va al grano; prioriza resolver sobre acompañar.",
  );

  out.push(
    t.brevedad > 70
      ? "Respuestas cortas: llamadas más rápidas, menos contexto."
      : "Explica con detalle: llamadas más largas y menos dudas después.",
  );

  if (t.rigor > 80) out.push("Nunca se salta el protocolo, aunque alargue la llamada.");
  if (t.paciencia < 45) out.push("Cierra antes las llamadas que se enredan.");
  if (t.iniciativa > 70) out.push("Ofrece recordatorios y revisiones sin que se los pidan.");

  out.push(
    ["Ante un insulto mantiene la calma y continúa.", "Ante un insulto advierte una vez antes de cerrar.", "Ante un insulto finaliza la llamada."][p.insultos],
  );
  out.push(
    ["Si algo es ambiguo, vuelve a preguntar.", "Si algo es ambiguo, asume lo más probable y confirma.", "Si algo es ambiguo, deriva a una persona."][p.dudas],
  );
  out.push(
    ["Ante síntomas de alarma transfiere sin más preguntas.", "Ante síntomas de alarma confirma y transfiere.", "Ante síntomas de alarma ofrece cita urgente el mismo día."][p.urgencia],
  );

  return out.slice(0, 7);
}

export { POLICIES };
