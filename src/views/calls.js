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

  const detailHost = el("div", { class: "stack stack--lg" });
  const tbody = el("tbody", {});

  function renderRows() {
    const rows = calls.filter((c) => filter === "all" || c.outcome === filter);
    mount(
      tbody,
      ...rows.map((c) => {
        const tr = el(
          "tr",
          {
            class: c.id === selected?.id ? "is-selected" : "",
            onclick: () => {
              selected = c;
              renderRows();
              renderDetail();
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
          el("td", { class: "secondary" }, c.agent),
          el("td", {}, pill(outcomeLabels[c.outcome].text, outcomeLabels[c.outcome].pill.replace("pill--", ""))),
          el("td", { class: `text-sm ${sentimentLabels[c.sentiment].cls}` }, sentimentLabels[c.sentiment].text),
          el("td", { class: "mono" }, c.duration),
          el("td", { class: "cell-sub" }, c.time),
        );
        return tr;
      }),
    );
    if (!rows.length) {
      mount(tbody, el("tr", {}, el("td", { colspan: "7", class: "empty" }, "Sin llamadas con este filtro.")));
    }
  }

  function renderDetail() {
    if (!selected) return mount(detailHost, card({}, el("div", { class: "empty" }, "Selecciona una llamada.")));
    const c = selected;
    mount(
      detailHost,
      card(
        {
          title: `Llamada ${c.id}`,
          sub: `${c.caller} · ${c.time}`,
          actions: el(
            "div",
            { class: "row", style: { gap: "6px" } },
            el("button", { class: "btn btn--icon btn--ghost", title: "Reproducir" }, icon("play", "nav__icon")),
            el("button", { class: "btn btn--icon btn--ghost", title: "Descargar" }, icon("download", "nav__icon")),
          ),
        },
        el(
          "dl",
          { class: "kv" },
          el("dt", {}, "Agente"),
          el("dd", {}, c.agent),
          el("dt", {}, "Teléfono"),
          el("dd", { class: "mono" }, c.phone),
          el("dt", {}, "Dirección"),
          el("dd", {}, c.direction),
          el("dt", {}, "Duración"),
          el("dd", { class: "mono" }, c.duration),
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
      card(
        { title: "Transcripción", sub: "Generada en tiempo real" },
        el(
          "div",
          { class: "transcript" },
          ...c.transcript.map(([who, text]) =>
            el(
              "div",
              { class: `bubble bubble--${who}` },
              el("span", { class: "bubble__who" }, who === "agent" ? c.agent : "Paciente"),
              text,
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
  renderDetail();

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
      { class: "grid", style: { gridTemplateColumns: "minmax(0, 1.5fr) minmax(320px, 1fr)" } },
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
                el("th", {}, "Agente"),
                el("th", {}, "Resultado"),
                el("th", {}, "Sentimiento"),
                el("th", {}, "Duración"),
                el("th", {}, "Cuándo"),
              ),
            ),
            tbody,
          ),
        ),
      ),
      detailHost,
    ),
  );
}
