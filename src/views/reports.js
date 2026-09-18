import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, barChart, stackedBars, donut, legend, bar } from "../components/ui.js";
import { volumeByHour, reasonsBreakdown, weeklyTrend, agents } from "../data/mock.js";

export const meta = {
  title: "Reportes",
  sub: "Rendimiento de la recepción agéntica, calidad y cumplimiento",
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
        el("button", {}, "7 días"),
        el("button", { class: "is-active" }, "30 días"),
        el("button", {}, "Trimestre"),
      ),
      el("button", { class: "btn btn--ghost" }, icon("filter", "nav__icon"), "Segmentar por sede"),
      el("button", { class: "btn btn--ghost ml-auto" }, icon("download", "nav__icon"), "Exportar PDF"),
    ),

    el(
      "div",
      { class: "grid grid--4" },
      stat({ label: "Llamadas atendidas", value: "8.412", trend: 9.2, foot: "últimos 30 días" }),
      stat({ label: "Coste por llamada", value: "0,42", unit: "€", trend: -21.5, foot: "vs. 1,90 € humano", tint: "ok" }),
      stat({ label: "Citas generadas", value: "3.196", trend: 14.8, foot: "38% del volumen" }),
      stat({ label: "Horas liberadas", value: "486", unit: "h", trend: 11.3, foot: "equipo de recepción", tint: "accent" }),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Automatizado vs. humano", sub: "Porcentaje de llamadas por día de la semana" },
        stackedBars(weeklyTrend),
        legend([
          { label: "Resuelto por agente", color: "var(--pitch-black)" },
          { label: "Escalado a humano", color: "var(--dusty-denim)" },
        ]),
      ),
      card(
        { title: "Motivos", sub: "Top 5 del periodo" },
        el("div", { class: "row", style: { justifyContent: "center" } }, donut(reasonsBreakdown, { center: "100%" })),
        legend(reasonsBreakdown),
      ),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card({ title: "Volumen por franja", sub: "Media del periodo" }, barChart(volumeByHour, { color: "var(--blue-slate)" })),
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
      { class: "grid grid--3" },
      card(
        { title: "Satisfacción (NPS)", tint: "ok" },
        el("div", { class: "stat__value", style: { fontSize: "38px" } }, "62"),
        el("p", { class: "card__sub" }, "Promotores 71% · Pasivos 20% · Detractores 9%"),
      ),
      card(
        { title: "Cumplimiento", tint: "accent" },
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
