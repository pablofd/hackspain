import { el, svg } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { TRAITS, POLICIES } from "../data/mock.js";

/** Telaraña de rasgos + lectura en lenguaje llano del comportamiento actual. */
export function statusCard(state) {
  return el(
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
        el("div", { class: "status__tagline" }, profileName(state.traits)),
      ),
    ),
    el("div", { class: "status__body" }, radar(state.traits), legendGrid(state.traits)),
    el(
      "div",
      { class: "status__notes" },
      el("div", { class: "section-title" }, "Cómo se comporta ahora"),
      ...insights(state).map((t) =>
        el("p", { class: "status__note" }, el("span", { class: "status__bullet" }), t),
      ),
    ),
  );
}

const SIZE = 260;
const CENTER = SIZE / 2;
const RADIUS = 92;

function point(i, total, value) {
  const angle = -Math.PI / 2 + (i / total) * Math.PI * 2;
  const r = (value / 100) * RADIUS;
  return [CENTER + Math.cos(angle) * r, CENTER + Math.sin(angle) * r];
}

function radar(traits) {
  const total = TRAITS.length;
  const rings = [0.25, 0.5, 0.75, 1].map((f) =>
    svg("polygon", {
      points: TRAITS.map((_, i) => point(i, total, f * 100).map((n) => n.toFixed(1)).join(",")).join(" "),
      fill: "none",
      stroke: "rgba(var(--ink-rgb), 0.12)",
      "stroke-width": 1,
    }),
  );

  const spokes = TRAITS.map((_, i) => {
    const [x, y] = point(i, total, 100);
    return svg("line", {
      x1: CENTER,
      y1: CENTER,
      x2: x,
      y2: y,
      stroke: "rgba(var(--ink-rgb), 0.12)",
      "stroke-width": 1,
    });
  });

  const shape = TRAITS.map(([key], i) => point(i, total, traits[key]).map((n) => n.toFixed(1)).join(",")).join(" ");

  const dots = TRAITS.map(([key], i) => {
    const [x, y] = point(i, total, traits[key]);
    return svg("circle", { cx: x, cy: y, r: 3, fill: "var(--pitch-black)" });
  });

  const labels = TRAITS.map(([, label], i) => {
    const [x, y] = point(i, total, 128);
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
  });

  return svg(
    "svg",
    { class: "status__radar", viewBox: `-22 -8 ${SIZE + 44} ${SIZE + 16}`, role: "img" },
    ...rings,
    ...spokes,
    svg("polygon", {
      points: shape,
      fill: "rgba(var(--dusty-denim-rgb), 0.35)",
      stroke: "var(--pitch-black)",
      "stroke-width": 1.4,
      "stroke-linejoin": "round",
      style: "transition: all 420ms cubic-bezier(0.22,1,0.36,1)",
    }),
    ...dots,
    ...labels,
  );
}

function legendGrid(traits) {
  return el(
    "div",
    { class: "status__grid" },
    ...TRAITS.map(([key, label]) =>
      el(
        "div",
        { class: "status__cell" },
        el("span", { class: "status__cell-label" }, label),
        el("span", { class: "status__cell-value mono" }, String(traits[key])),
      ),
    ),
  );
}

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

  out.push(option("insultos", p.insultos, {
    0: "Ante un insulto mantiene la calma y continúa.",
    1: "Ante un insulto advierte una vez antes de cerrar.",
    2: "Ante un insulto finaliza la llamada.",
  }));

  out.push(option("dudas", p.dudas, {
    0: "Si algo es ambiguo, vuelve a preguntar.",
    1: "Si algo es ambiguo, asume lo más probable y confirma.",
    2: "Si algo es ambiguo, deriva a una persona.",
  }));

  out.push(option("urgencia", p.urgencia, {
    0: "Ante síntomas de alarma transfiere sin más preguntas.",
    1: "Ante síntomas de alarma confirma y transfiere.",
    2: "Ante síntomas de alarma ofrece cita urgente el mismo día.",
  }));

  return out.slice(0, 7);
}

function option(id, value, map) {
  const policy = POLICIES.find((x) => x.id === id);
  return map[value] || `${policy.label}: ${policy.options[value]}`;
}
