import { el, mount } from "../lib/dom.js";
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

  const heroHost = el("div", { class: "stack stack--lg" });
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
      chatCard(c),
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
    el(
      "div",
      { class: "grid grid--calls" },
      card(
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
      ),
      heroHost,
    ),
  );
}

function chatCard(c) {
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
