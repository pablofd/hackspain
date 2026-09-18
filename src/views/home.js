import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, pill, barChart, stackedBars, donut, legend, bar } from "../components/ui.js";
import {
  kpis,
  volumeByHour,
  reasonsBreakdown,
  weeklyTrend,
  activity,
  agents,
  calls,
  outcomeLabels,
} from "../data/mock.js";

export const meta = {
  title: "Inicio",
  sub: "Reportes y actividad de la recepción agéntica · hoy, 18 sep",
};

export function render() {
  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "row row--wrap" },
      el(
        "div",
        { class: "segmented" },
        el("button", { class: "is-active" }, "Hoy"),
        el("button", {}, "7 días"),
        el("button", {}, "30 días"),
        el("button", {}, "Trimestre"),
      ),
      el("button", { class: "btn btn--ghost ml-auto" }, icon("download", "nav__icon"), "Exportar informe"),
    ),

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
        tint: "ok",
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
        tint: "alert",
      }),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Volumen por franja horaria", sub: "Llamadas atendidas por los agentes · últimas 24 h" },
        barChart(volumeByHour),
      ),
      card(
        { title: "Motivos de llamada", sub: "Distribución del día" },
        el(
          "div",
          { class: "row", style: { justifyContent: "center" } },
          donut(reasonsBreakdown, { center: "342" }),
        ),
        legend(reasonsBreakdown),
      ),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Automatizado vs. humano", sub: "Porcentaje de llamadas por día de la semana" },
        stackedBars(weeklyTrend),
        legend([
          { label: "Resuelto por agente", color: "var(--ink-black)" },
          { label: "Escalado a humano", color: "var(--gray-300)" },
        ]),
      ),
      card(
        { title: "Calidad por agente", sub: "Resolución en primera llamada" },
        el(
          "div",
          { class: "list" },
          ...agents
            .filter((a) => a.calls > 0)
            .sort((a, b) => b.resolution - a.resolution)
            .map((a) =>
              el(
                "div",
                { class: "list__item" },
                el("span", { class: "avatar" }, a.name[0]),
                el(
                  "div",
                  { class: "list__body" },
                  el("div", { class: "list__title" }, a.name),
                  el("div", { style: { marginTop: "6px" } }, bar(a.resolution)),
                ),
                el("span", { class: "mono" }, `${a.resolution}%`),
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
              ...calls.slice(0, 6).map((c) =>
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
                { class: `timeline__item${a.kind === "alert" ? " timeline__item--alert" : ""}` },
                el("div", { class: "timeline__time" }, a.time),
                el("div", { class: "timeline__title" }, a.title),
                el("div", { class: "timeline__desc" }, a.desc),
              ),
            ),
          ),
        ),
        card(
          { title: "Agentes en servicio", tint: "accent" },
          el(
            "div",
            { class: "list" },
            ...agents
              .filter((a) => a.status === "online")
              .map((a) =>
                el(
                  "div",
                  { class: "list__item" },
                  el("span", { class: "avatar avatar--accent" }, a.name[0]),
                  el(
                    "div",
                    { class: "list__body" },
                    el("div", { class: "list__title" }, a.name),
                    el("div", { class: "list__meta truncate" }, a.role),
                  ),
                  el("span", { class: "mono" }, `${a.resolution}%`),
                ),
              ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--3" },
      card(
        { title: "Satisfacción (NPS)", tint: "ok" },
        el("div", { class: "stat__value", style: { fontSize: "38px" } }, "62"),
        el("p", { class: "card__sub" }, "Promotores 71% · Pasivos 20% · Detractores 9%"),
      ),
      card(
        { title: "Cumplimiento" },
        el(
          "dl",
          { class: "kv" },
          el("dt", {}, "Aviso de IA"),
          el("dd", {}, "100% de llamadas"),
          el("dt", {}, "Consentimiento"),
          el("dd", {}, "99,4% registrado"),
          el("dt", {}, "Retención"),
          el("dd", {}, "90 días"),
          el("dt", {}, "Incidencias"),
          el("dd", {}, "0 abiertas"),
        ),
      ),
      card(
        { title: "Alertas del periodo", tint: "alert" },
        el(
          "div",
          { class: "list" },
          ...[
            ["Pico de abandono", "Viernes 12:00 · 14 llamadas en cola"],
            ["Latencia de mutua", "Adeslas API > 2 s en 37 consultas"],
            ["Intención sin cobertura", "«segunda opinión médica» × 23"],
          ].map(([t, d]) =>
            el(
              "div",
              { class: "list__item" },
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, t),
                el("div", { class: "list__meta" }, d),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
