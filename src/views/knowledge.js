import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill } from "../components/ui.js";
import { knowledge } from "../data/mock.js";

export const meta = {
  title: "Conocimiento",
  sub: "La fuente de verdad que consultan los agentes durante la llamada",
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
        { class: "search", style: { width: "320px" } },
        icon("search", "nav__icon"),
        el("input", { type: "search", placeholder: "Buscar en la base de conocimiento" }),
      ),
      el("button", { class: "btn btn--ghost ml-auto" }, icon("download", "nav__icon"), "Importar"),
      el("button", { class: "btn btn--primary" }, icon("plus", "nav__icon"), "Nueva colección"),
    ),

    el(
      "div",
      { class: "grid grid--3" },
      ...knowledge.map((k) =>
        card(
          {},
          el(
            "div",
            { class: "row" },
            el("span", { class: "avatar" }, icon("knowledge", "nav__icon")),
            el(
              "div",
              { style: { minWidth: 0 } },
              el("div", { class: "card__title" }, k.title),
              el("div", { class: "card__sub" }, `${k.items} entradas · ${k.owner}`),
            ),
          ),
          el(
            "div",
            { class: "row", style: { marginTop: "18px" } },
            pill(`Actualizado ${k.updated}`, "neutral"),
            el("button", { class: "btn btn--sm btn--ghost ml-auto" }, "Abrir"),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--aside" },
      card(
        { title: "Preguntas sin respuesta", sub: "Detectadas en llamadas reales", tint: "flame" },
        el(
          "div",
          { class: "list" },
          ...[
            ["«¿Hacen segunda opinión médica?»", "23 veces esta semana"],
            ["«¿Tienen parking gratuito?»", "16 veces esta semana"],
            ["«¿Aceptan Cigna internacional?»", "11 veces esta semana"],
          ].map(([q, m]) =>
            el(
              "div",
              { class: "list__item" },
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, q),
                el("div", { class: "list__meta" }, m),
              ),
              el("button", { class: "btn btn--sm" }, "Responder"),
            ),
          ),
        ),
      ),
      card(
        { title: "Instrucciones globales", sub: "Prompt base compartido por todos los agentes" },
        el(
          "textarea",
          { class: "textarea", style: { minHeight: "190px" } },
          `Eres un recepcionista virtual de Clínica Vera Salud.
Identifícate siempre como asistente virtual al inicio de la llamada.
Nunca ofrezcas diagnóstico, tratamiento ni interpretación clínica.
Verifica identidad con nombre completo y fecha de nacimiento antes de tratar datos de salud.
Ante síntomas de alarma, activa el protocolo de triaje y transfiere a enfermería.
Confirma verbalmente cualquier cita antes de registrarla.
Responde en el idioma del paciente (es / ca / en), con frases breves y tono cálido.`,
        ),
        el(
          "div",
          { class: "row", style: { marginTop: "14px" } },
          el("span", { class: "text-sm muted" }, "Última edición: hoy 08:12 · Vicente Ferri"),
          el("button", { class: "btn btn--primary btn--sm ml-auto" }, "Guardar"),
        ),
      ),
    ),
  );
}
