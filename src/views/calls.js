import { el, mount, svg } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill } from "../components/ui.js";
import { calls, outcomeLabels, sentimentLabels } from "../data/mock.js";

export const meta = {
  title: "Llamadas",
  sub: "Historial de conversaciones, transcripciones y acciones ejecutadas",
};

const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "resolved", label: "Resueltas" },
  { id: "escalated", label: "Escaladas" },
  { id: "pending", label: "Pendientes" },
];

export function render() {
  let filter = "all";
  let selected = calls[0];
  let signalsOpen = false;

  const heroHost = el("div", { class: "stack stack--lg" });
  const signalsHost = el("aside", { class: "signals", hidden: true });
  const tbody = el("tbody", {});

  function renderRows() {
    const rows = calls.filter((c) => filter === "all" || c.outcome === filter);
    mount(
      tbody,
      ...rows.map((c) =>
        el(
          "tr",
          {
            class: c.id === selected?.id ? "is-selected" : "",
            onclick: () => {
              selected = c;
              renderRows();
              renderHero();
            },
          },
          el(
            "td",
            {},
            el(
              "div",
              { class: "row-flex" },
              el("span", { class: "avatar" }, c.caller[0]),
              el(
                "div",
                {},
                el("div", { class: "cell-main" }, c.caller),
                el("div", { class: "cell-sub" }, c.phone),
              ),
            ),
          ),
          el(
            "td",
            {},
            el("div", { class: "cell-main" }, c.reason),
            el("div", { class: "cell-sub" }, c.direction),
          ),
          el("td", { class: "secondary hide-md" }, c.agent),
          el("td", {}, pill(outcomeLabels[c.outcome].text, outcomeLabels[c.outcome].pill.replace("pill--", ""))),
          el("td", { class: `text-sm hide-lg ${sentimentLabels[c.sentiment].cls}` }, sentimentLabels[c.sentiment].text),
          el("td", { class: "mono" }, c.duration),
          el("td", { class: "cell-sub hide-lg" }, c.time),
        ),
      ),
    );
    if (!rows.length) {
      mount(tbody, el("tr", {}, el("td", { colspan: "7", class: "empty" }, "Sin llamadas con este filtro.")));
    }
  }

  function renderHero() {
    const c = selected;
    if (!c) return mount(heroHost, card({}, el("div", { class: "empty" }, "Selecciona una llamada.")));
    mount(
      heroHost,
      chatCard(c, signalsOpen, toggleSignals),
      card(
        { title: "Resumen de la llamada", sub: `${c.id} · ${c.direction}` },
        el(
          "dl",
          { class: "kv" },
          el("dt", {}, "Paciente"),
          el("dd", {}, c.caller),
          el("dt", {}, "Teléfono"),
          el("dd", { class: "mono" }, c.phone),
          el("dt", {}, "Agente"),
          el("dd", {}, c.agent),
          el("dt", {}, "Motivo"),
          el("dd", {}, c.reason),
          el("dt", {}, "Resultado"),
          el("dd", {}, outcomeLabels[c.outcome].text),
          el("dt", {}, "Sentimiento"),
          el("dd", { class: sentimentLabels[c.sentiment].cls }, sentimentLabels[c.sentiment].text),
        ),
      ),
      card(
        { title: "Acciones ejecutadas", sub: "Registro auditable" },
        el(
          "div",
          { class: "timeline" },
          ...c.actions.map((a) =>
            el(
              "div",
              { class: "timeline__item" },
              el("div", { class: "timeline__title" }, a),
              el("div", { class: "timeline__time" }, "Confirmado"),
            ),
          ),
        ),
      ),
    );
    if (signalsOpen) mount(signalsHost, ...signalsPanel(c));
  }

  const filterBar = el(
    "div",
    { class: "segmented" },
    ...FILTERS.map((f) =>
      el(
        "button",
        {
          class: f.id === filter ? "is-active" : "",
          onclick: (e) => {
            filter = f.id;
            filterBar.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
            e.currentTarget.classList.add("is-active");
            renderRows();
          },
        },
        f.label,
      ),
    ),
  );

  renderRows();

  const listCard = card(
    { flush: true },
    el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        { class: "data" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "Paciente"),
            el("th", {}, "Motivo"),
            el("th", { class: "hide-md" }, "Agente"),
            el("th", {}, "Resultado"),
            el("th", { class: "hide-lg" }, "Sentimiento"),
            el("th", {}, "Duración"),
            el("th", { class: "hide-lg" }, "Cuándo"),
          ),
        ),
        tbody,
      ),
    ),
  );

  const grid = el("div", { class: "grid grid--calls" }, listCard, heroHost, signalsHost);

  function toggleSignals() {
    signalsOpen = !signalsOpen;
    grid.classList.toggle("is-signals", signalsOpen);
    listCard.hidden = signalsOpen;
    signalsHost.hidden = !signalsOpen;
    if (signalsOpen) mount(signalsHost, ...signalsPanel(selected));
    else mount(signalsHost);
    renderHero();
  }

  renderHero();

  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "row row--wrap" },
      filterBar,
      el("button", { class: "btn btn--ghost" }, icon("filter", "nav__icon"), "Más filtros"),
      el("button", { class: "btn btn--ghost ml-auto" }, icon("download", "nav__icon"), "Exportar CSV"),
      el("button", { class: "btn btn--primary" }, icon("phone", "nav__icon"), "Nueva llamada saliente"),
    ),
    grid,
  );
}

function chatCard(c, signalsOpen, onToggle) {
  const isLive = c.outcome === "pending";
  return el(
    "section",
    { class: "chat-card grain" },
    el(
      "div",
      { class: "chat-card__head" },
      el("span", { class: "avatar avatar--accent" }, c.agent[0]),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "chat-card__title" }, `${c.agent} · ${c.caller}`),
        el("div", { class: "chat-card__sub truncate" }, `${c.reason} · ${c.time}`),
      ),
      el(
        "div",
        { class: "row ml-auto", style: { gap: "6px" } },
        isLive
          ? el("span", { class: "pill pill--alert" }, el("span", { class: "dot dot--pulse" }), "En curso")
          : pill(outcomeLabels[c.outcome].text, outcomeLabels[c.outcome].pill.replace("pill--", "")),
        el(
          "button",
          {
            class: `signal-btn${signalsOpen ? " is-on" : ""}`,
            title: "Parámetros que el agente detecta en tiempo real",
            onclick: onToggle,
          },
          el("span", { class: "signal-btn__eq" }, el("i", {}), el("i", {}), el("i", {}), el("i", {})),
          signalsOpen ? "Ocultar señales" : "Leer señales",
        ),
        el("button", { class: "btn btn--icon btn--ghost", title: "Descargar audio" }, icon("download", "nav__icon")),
      ),
    ),
    el(
      "div",
      { class: "chat" },
      ...c.transcript.map(([who, text], i) =>
        el(
          "div",
          { class: `chat__row chat__row--${who}`, style: { animationDelay: `${i * 60}ms` } },
          el(
            "span",
            { class: `chat__avatar${who === "agent" ? " chat__avatar--agent" : ""}` },
            who === "agent" ? c.agent[0] : c.caller[0],
          ),
          el(
            "div",
            {},
            el(
              "div",
              { class: "chat__meta" },
              el("span", {}, who === "agent" ? c.agent : c.caller),
              el("span", { class: "mono" }, stamp(i)),
            ),
            el("div", { class: "chat__bubble" }, text),
          ),
        ),
      ),
      isLive &&
        el(
          "div",
          { class: "chat__row chat__row--agent" },
          el("span", { class: "chat__avatar chat__avatar--agent" }, c.agent[0]),
          el(
            "div",
            { class: "chat__bubble chat__typing" },
            el("i", {}),
            el("i", {}),
            el("i", {}),
          ),
        ),
    ),
    player(c),
  );
}

/* Marca de tiempo aproximada por turno de conversación */
function stamp(i) {
  const total = 9 + i * 14;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function player(c) {
  const bars = Array.from({ length: 64 }, (_, i) => {
    const h = 18 + Math.abs(Math.sin(i * 1.7) * 60) + (i % 5) * 4;
    return el("i", {
      class: i < 22 ? "is-played" : "",
      style: { height: `${Math.min(h, 100)}%` },
    });
  });
  return el(
    "div",
    { class: "player" },
    el("button", { class: "player__btn", title: "Reproducir" }, icon("play", "nav__icon")),
    el("div", { class: "waveform" }, ...bars),
    el("span", { class: "mono" }, c.duration),
  );
}

/* ============================================================
   Señales en vivo · lectura del agente sobre la conversación
   ============================================================ */

const EMOTION_PROFILE = {
  positive: { calma: 88, satisfaccion: 81, confusion: 14, frustracion: 9, enfado: 4 },
  neutral: { calma: 72, satisfaccion: 48, confusion: 31, frustracion: 22, enfado: 11 },
  negative: { calma: 34, satisfaccion: 17, confusion: 46, frustracion: 74, enfado: 63 },
};

const INTENT_MAP = {
  "Cita dermatología": [["Agendar cita", 94], ["Consultar disponibilidad", 71], ["Preferencia horaria", 58]],
  "Reprogramar cita": [["Reprogramar", 96], ["Consultar disponibilidad", 62], ["Evitar penalización", 18]],
  "Resultados analítica": [["Consultar resultados", 92], ["Solicitar interpretación", 44], ["Agendar seguimiento", 27]],
  "Autorización mutua": [["Verificar cobertura", 89], ["Consultar precio", 51], ["Urgencia administrativa", 33]],
};

export function signalsPanel(c) {
  const emo = EMOTION_PROFILE[c.sentiment];
  const angerRisk = Math.round(emo.enfado * 0.6 + emo.frustracion * 0.4);
  const intents = INTENT_MAP[c.reason] || [
    [c.reason, 91],
    ["Consultar información", 54],
    ["Cerrar la llamada", 38],
  ];
  const related = calls
    .filter((k) => k.id !== c.id && (k.reason === c.reason || k.sentiment === c.sentiment))
    .slice(0, 3);

  const liveNumber = el("span", { class: "mono" }, `${angerRisk}% enfado · actualizando`);
  tick(liveNumber, angerRisk);

  return [
    el(
      "div",
      { class: "signals__strip" },
      el("span", { class: "dot dot--pulse" }),
      el("span", {}, `Lectura en vivo · ${c.agent}`),
      liveNumber,
    ),

    card(
      { title: "Estado emocional del paciente", sub: "Inferido de prosodia, léxico y ritmo" },
      el(
        "div",
        { class: "gauge-row" },
        gauge(angerRisk),
        el(
          "div",
          { style: { flex: 1, minWidth: 0 } },
          meter("Calma", emo.calma, "denim"),
          meter("Satisfacción", emo.satisfaccion, "denim"),
          meter("Confusión", emo.confusion, "slate"),
          meter("Frustración", emo.frustracion, "alert"),
          meter("Enfado", emo.enfado, "alert"),
        ),
      ),
    ),

    card(
      { title: "Intenciones detectadas", sub: "Clasificación multietiqueta por turno" },
      ...intents.map(([label, value]) => meter(label, value)),
    ),

    card(
      { title: "Patrones de comportamiento" },
      el(
        "div",
        { class: "chips" },
        ...behaviour(c).map(([label, value, hot]) =>
          el(
            "span",
            { class: `signal-chip${hot ? " signal-chip--hot" : ""}` },
            label,
            el("b", {}, value),
          ),
        ),
      ),
    ),

    card(
      { title: "Entidades extraídas", sub: "Listas para ejecutar acciones" },
      el(
        "dl",
        { class: "kv" },
        el("dt", {}, "Especialidad"),
        el("dd", {}, c.reason.split(" ").slice(-1)[0]),
        el("dt", {}, "Urgencia"),
        el("dd", {}, c.outcome === "escalated" ? "Alta" : "Ordinaria"),
        el("dt", {}, "Canal preferido"),
        el("dd", {}, "Teléfono"),
        el("dt", {}, "Identidad"),
        el("dd", {}, "Verificada"),
      ),
    ),

    card(
      {
        title: "Conversaciones parecidas",
        sub: `${related.length} llamadas con el mismo patrón esta semana`,
      },
      ...related.map((r, i) =>
        el(
          "div",
          { class: "related__item" },
          el("span", { class: "avatar" }, r.caller[0]),
          el(
            "div",
            { style: { minWidth: 0 } },
            el("div", { class: "related__name" }, r.caller),
            el("div", { class: "related__meta truncate" }, `${r.reason} · ${outcomeLabels[r.outcome].text}`),
          ),
          el("span", { class: "related__match" }, `${92 - i * 9}%`),
        ),
      ),
      el(
        "p",
        { class: "card__sub", style: { marginTop: "12px" } },
        "En 2 de 3 casos, ofrecer el primer hueco disponible cerró la llamada sin escalado.",
      ),
    ),

    el(
      "div",
      { class: "nba" },
      el("div", { class: "nba__label" }, "Siguiente mejor acción"),
      el("p", { class: "nba__text" }, nextAction(c)),
      el(
        "div",
        { class: "row row--wrap" },
        el("button", { class: "btn btn--primary btn--sm" }, "Sugerir al agente"),
        el("button", { class: "btn btn--sm" }, "Descartar"),
      ),
    ),
  ];
}

function meter(label, value, tone) {
  const fill = el("i", { class: "meter__fill" });
  requestAnimationFrame(() => {
    fill.style.width = `${value}%`;
  });
  return el(
    "div",
    { class: `meter${tone ? ` meter--${tone}` : ""}` },
    el(
      "div",
      { class: "meter__top" },
      el("span", {}, label),
      el("span", { class: "meter__val" }, `${value}%`),
    ),
    el("div", { class: "meter__track" }, fill),
  );
}

function gauge(value) {
  const size = 104;
  const r = 44;
  const c = 2 * Math.PI * r;
  const arc = svg("circle", {
    cx: size / 2,
    cy: size / 2,
    r,
    fill: "none",
    stroke: value > 45 ? "var(--lipstick-red)" : "var(--pitch-black)",
    "stroke-width": 6,
    "stroke-dasharray": `0 ${c}`,
    transform: `rotate(-90 ${size / 2} ${size / 2})`,
  });
  requestAnimationFrame(() => {
    arc.style.transition = "stroke-dasharray 1s var(--ease-out)";
    arc.setAttribute("stroke-dasharray", `${(value / 100) * c} ${c}`);
  });
  return el(
    "div",
    { class: "gauge", style: { textAlign: "center" } },
    svg(
      "svg",
      { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
      svg("circle", {
        cx: size / 2,
        cy: size / 2,
        r,
        fill: "none",
        stroke: "var(--parchment)",
        "stroke-width": 6,
      }),
      arc,
    ),
    el("div", { class: "gauge__value" }, `${value}%`),
    el("div", { class: "gauge__label" }, "riesgo de enfado"),
  );
}

function behaviour(c) {
  const fast = c.sentiment === "negative";
  return [
    ["Ritmo del habla", fast ? "+38%" : "normal", fast],
    ["Interrupciones", fast ? "4" : "0", fast],
    ["Repite información", c.outcome === "pending" ? "2 veces" : "no", c.outcome === "pending"],
    ["Silencios largos", c.sentiment === "neutral" ? "1" : "0", false],
    ["Tono elevado", fast ? "detectado" : "no", fast],
    ["Cortesía", c.sentiment === "positive" ? "alta" : "media", false],
  ];
}

function nextAction(c) {
  if (c.outcome === "escalated") return "Transferir a enfermería y avisar al médico de guardia. El paciente muestra señales de alarma y su frustración sube en cada turno.";
  if (c.outcome === "pending") return "Confirmar un plazo concreto: «le llamamos antes de las 18:00». En casos similares reduce la reapertura de la llamada un 61%.";
  return "Ofrecer el primer hueco disponible y cerrar con confirmación por SMS. El paciente está receptivo y la intención es clara.";
}

/* Jitter suave para que la lectura se sienta en vivo; se detiene al desmontar */
function tick(node, base) {
  const id = setInterval(() => {
    if (!node.isConnected) return clearInterval(id);
    const jitter = Math.max(0, Math.min(99, base + Math.round((Math.random() - 0.5) * 6)));
    node.textContent = `${jitter}% enfado · actualizando`;
  }, 1800);
}
