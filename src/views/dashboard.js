import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, pill, barChart, donut, legend, bar } from "../components/ui.js";
import { kpis, volumeByHour, reasonsBreakdown, activity, agents, calls, outcomeLabels } from "../data/mock.js";

export const meta = {
  title: "Inicio",
  sub: "Resumen operativo de la recepción agéntica · hoy, 18 sep",
};

export function render() {
  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "grid grid--4" },
      stat({
        label: "Llamadas hoy",
        value: kpis.callsToday.value,
        trend: kpis.callsToday.trend,
        foot: "vs. ayer",
        spark: kpis.callsToday.spark,
      }),
      stat({
        label: "Automatización",
        value: kpis.automation.value,
        unit: "%",
        trend: kpis.automation.trend,
        foot: "sin intervención humana",
        spark: kpis.automation.spark,
        tint: "green",
      }),
      stat({
        label: "Duración media",
        value: kpis.avgHandle.value,
        trend: kpis.avgHandle.trend,
        foot: "por llamada",
        spark: kpis.avgHandle.spark,
      }),
      stat({
        label: "Escalados a humano",
        value: kpis.escalations.value,
        trend: kpis.escalations.trend,
        foot: "6,7% del total",
        spark: kpis.escalations.spark,
        tint: "flame",
      }),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        {
          title: "Volumen por franja horaria",
          sub: "Llamadas atendidas por los agentes · últimas 24 h",
          actions: el(
            "div",
            { class: "segmented" },
            el("button", { class: "is-active" }, "Hoy"),
            el("button", {}, "7 días"),
            el("button", {}, "30 días"),
          ),
        },
        barChart(volumeByHour),
      ),
      card(
        { title: "Motivos de llamada", sub: "Distribución del día" },
        el(
          "div",
          { class: "row", style: { justifyContent: "flex-start", gap: "22px" } },
          donut(reasonsBreakdown, { center: "342" }),
          el(
            "div",
            { class: "stack stack--sm", style: { flex: "1" } },
            ...reasonsBreakdown.map((r) =>
              el(
                "div",
                { class: "stack stack--sm" },
                el(
                  "div",
                  { class: "row text-sm" },
                  el("span", {}, r.label),
                  el("span", { class: "ml-auto muted" }, `${r.value}%`),
                ),
                el(
                  "div",
                  { class: "bar" },
                  el("i", {
                    class: "bar__fill",
                    style: { width: `${r.value * 2.4}%`, background: r.color, display: "block" },
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        {
          title: "Últimas llamadas",
          sub: "Registro en tiempo real",
          flush: true,
          actions: el(
            "a",
            { class: "btn btn--sm btn--ghost", href: "#/llamadas" },
            "Ver todas",
            icon("arrowUpRight", "nav__icon"),
          ),
        },
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
                el("th", {}, "Estado"),
                el("th", {}, "Duración"),
              ),
            ),
            el(
              "tbody",
              {},
              ...calls.slice(0, 5).map((c) =>
                el(
                  "tr",
                  { onclick: () => (location.hash = "#/llamadas") },
                  el(
                    "td",
                    {},
                    el("div", { class: "cell-main" }, c.caller),
                    el("div", { class: "cell-sub" }, c.time),
                  ),
                  el("td", {}, c.reason),
                  el("td", { class: "secondary" }, c.agent),
                  el("td", {}, pill(outcomeLabels[c.outcome].text, outcomeLabels[c.outcome].pill.replace("pill--", ""))),
                  el("td", { class: "mono" }, c.duration),
                ),
              ),
            ),
          ),
        ),
      ),
      el(
        "div",
        { class: "stack stack--lg" },
        card(
          { title: "Actividad del sistema", sub: "Acciones ejecutadas por agentes" },
          el(
            "div",
            { class: "timeline" },
            ...activity.map((a) =>
              el(
                "div",
                { class: `timeline__item${a.kind === "alert" ? " timeline__item--flame" : ""}` },
                el("div", { class: "timeline__time" }, a.time),
                el("div", { class: "timeline__title" }, a.title),
                el("div", { class: "timeline__desc" }, a.desc),
              ),
            ),
          ),
        ),
        card(
          { title: "Agentes en servicio", tint: "coffee" },
          el(
            "div",
            { class: "list" },
            ...agents
              .filter((a) => a.status === "online")
              .map((a) =>
                el(
                  "div",
                  { class: "list__item" },
                  el("span", { class: "avatar avatar--green" }, a.name[0]),
                  el(
                    "div",
                    { class: "list__body" },
                    el("div", { class: "list__title" }, a.name),
                    el("div", { class: "list__meta truncate" }, a.role),
                  ),
                  el("div", { style: { width: "72px" } }, bar(a.resolution)),
                  el("span", { class: "mono" }, `${a.resolution}%`),
                ),
              ),
          ),
        ),
      ),
    ),
  );
}
