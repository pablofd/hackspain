import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, toggle } from "../components/ui.js";
import { actionsCatalog, riskLabels } from "../data/mock.js";

export const meta = {
  title: "Acciones",
  sub: "Herramientas que los agentes pueden ejecutar sobre los sistemas de la clínica",
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
        el("button", { class: "is-active" }, "Catálogo"),
        el("button", {}, "Conexiones"),
        el("button", {}, "Registro de ejecución"),
      ),
      el("button", { class: "btn btn--primary ml-auto" }, icon("plus", "nav__icon"), "Nueva acción"),
    ),

    el(
      "div",
      { class: "grid grid--2" },
      ...actionsCatalog.map((a) =>
        card(
          { class: "stack" },
          el(
            "div",
            { class: "row" },
            el("span", { class: "avatar avatar--green" }, icon("actions", "nav__icon")),
            el(
              "div",
              { style: { minWidth: 0 } },
              el("div", { class: "card__title" }, a.name),
              el("div", { class: "card__sub" }, a.system),
            ),
            el("div", { class: "ml-auto" }, toggle(a.enabled)),
          ),
          el("p", { class: "text-sm secondary", style: { margin: "14px 0" } }, a.desc),
          el(
            "div",
            { class: "row row--wrap" },
            pill(`${a.runs.toLocaleString("es-ES")} ejecuciones`, "neutral"),
            pill(a.latency, "neutral"),
            pill(`Riesgo ${riskLabels[a.risk].text.toLowerCase()}`, riskLabels[a.risk].pill.replace("pill--", "")),
            el("button", { class: "btn btn--sm btn--ghost ml-auto" }, "Probar"),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--aside" },
      card(
        { title: "Sistemas conectados", sub: "Estado de las integraciones", tint: "coffee" },
        el(
          "div",
          { class: "list" },
          ...[
            ["Doctoralia", "Agenda y profesionales", "green", "Operativo"],
            ["HIS · HL7 FHIR", "Historia clínica", "green", "Operativo"],
            ["Adeslas API", "Coberturas y autorizaciones", "coffee", "Latencia alta"],
            ["Twilio Voice", "Telefonía SIP", "green", "Operativo"],
            ["Stripe", "Cobros", "neutral", "Desconectado"],
          ].map(([n, d, tone, label]) =>
            el(
              "div",
              { class: "list__item" },
              el("span", { class: "avatar" }, icon("building", "nav__icon")),
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, n),
                el("div", { class: "list__meta" }, d),
              ),
              pill(label, tone),
            ),
          ),
        ),
      ),
      card(
        { title: "Barandillas de seguridad", sub: "Se aplican antes de ejecutar cualquier acción" },
        el(
          "div",
          {},
          ...[
            ["Verificación de identidad", "Nombre completo + fecha de nacimiento", true],
            ["Confirmación verbal", "El paciente debe confirmar antes de escribir en la agenda", true],
            ["Límite de acciones por llamada", "Máximo 3 escrituras", true],
            ["Bloqueo de consejo clínico", "El agente nunca diagnostica ni prescribe", true],
            ["Registro inmutable", "Cada ejecución queda firmada y auditada", true],
          ].map(([t, d, on]) =>
            el(
              "div",
              { class: "toggle-row" },
              el("span", { class: "avatar" }, icon("shield", "nav__icon")),
              el(
                "div",
                { class: "toggle-row__body" },
                el("div", { class: "toggle-row__title" }, t),
                el("div", { class: "toggle-row__desc" }, d),
              ),
              toggle(on),
            ),
          ),
        ),
      ),
    ),
  );
}
