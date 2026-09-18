import { el } from "../lib/dom.js";
import { card, toggle, pill } from "../components/ui.js";

export const meta = {
  title: "Ajustes",
  sub: "Organización, telefonía, cumplimiento y sistema de diseño",
};

const PALETTE = [
  ["Ink Black", "#0D1B1E", "Texto principal y superficies oscuras"],
  ["Platinum", "#EFEFEF", "Base de la interfaz"],
  ["Dusty Mauve", "#A54657", "Color principal para destacar"],
  ["Tropical Teal", "#48A9A6", "Detalle: estados correctos"],
  ["Coral Glow", "#FF8552", "Detalle: alertas y urgencias"],
];

export function render() {
  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "grid grid--2" },
      card(
        { title: "Organización", sub: "Datos de la clínica" },
        field("Nombre comercial", el("input", { class: "input", value: "Clínica Vera Salud" })),
        field("Teléfono principal", el("input", { class: "input mono", value: "+34 960 112 340" })),
        field(
          "Zona horaria",
          el(
            "select",
            { class: "select" },
            el("option", {}, "Europe/Madrid (GMT+2)"),
            el("option", {}, "Atlantic/Canary (GMT+1)"),
          ),
        ),
        field(
          "Idiomas de atención",
          el(
            "div",
            { class: "chips" },
            el("span", { class: "chip" }, "Español"),
            el("span", { class: "chip" }, "Català"),
            el("span", { class: "chip" }, "English"),
            el("button", { class: "btn btn--sm btn--ghost" }, "Añadir"),
          ),
        ),
      ),
      card(
        { title: "Telefonía", sub: "Enrutado de llamadas entrantes" },
        field(
          "Proveedor",
          el("select", { class: "select" }, el("option", {}, "Twilio Voice"), el("option", {}, "Vonage")),
        ),
        field("Número asignado", el("input", { class: "input mono", value: "+34 960 112 340" })),
        field(
          "Desbordamiento",
          el(
            "select",
            { class: "select" },
            el("option", {}, "Transferir a recepción humana"),
            el("option", {}, "Buzón con devolución de llamada"),
          ),
        ),
        field("Horario de atención", el("input", { class: "input", value: "L-V 08:00-20:00 · S 09:00-14:00" })),
      ),
    ),

    el(
      "div",
      { class: "grid grid--2" },
      card(
        { title: "Cumplimiento y privacidad", sub: "RGPD y normativa sanitaria" },
        el(
          "div",
          {},
          ...[
            ["Consentimiento de grabación", "Mensaje obligatorio al inicio", true],
            ["Cifrado en reposo", "AES-256 sobre transcripciones y audio", true],
            ["Retención de audio", "Borrado automático a los 90 días", true],
            ["Anonimización analítica", "Sin identificadores en reportes", true],
            ["Residencia de datos", "Servidores en la UE", true],
          ].map(([t, d, on]) =>
            el(
              "div",
              { class: "toggle-row" },
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
      card(
        { title: "Equipo", sub: "Acceso a la plataforma" },
        el(
          "div",
          { class: "list" },
          ...[
            ["Vicente Ferri", "Director de operaciones", "Admin"],
            ["Bea Ramos", "Enfermería · escalados", "Editor"],
            ["Sergio Lazo", "Admisión", "Editor"],
            ["Dra. Nadal", "Dermatología", "Lectura"],
          ].map(([n, r, role]) =>
            el(
              "div",
              { class: "list__item" },
              el("span", { class: "avatar" }, n[0]),
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, n),
                el("div", { class: "list__meta" }, r),
              ),
              pill(role, role === "Admin" ? "accent" : "neutral"),
            ),
          ),
          el(
            "div",
            { class: "list__item" },
            el("button", { class: "btn btn--sm" }, "Invitar miembro"),
          ),
        ),
      ),
    ),

    card(
      { title: "Sistema de diseño", sub: "Paleta guardada en /design/palette.json", tint: "accent" },
      el(
        "div",
        { class: "grid grid--3", style: { gap: "12px" } },
        ...PALETTE.map(([name, hex, role]) =>
          el(
            "div",
            {
              class: "grain",
              style: {
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px",
                borderRadius: "var(--r-md)",
                border: "1px solid var(--stroke-soft)",
                background: "var(--glass-1)",
              },
            },
            el("span", {
              class: "grain",
              style: {
                position: "relative",
                width: "38px",
                height: "38px",
                flex: "none",
                borderRadius: "12px",
                background: hex,
                border: "1px solid var(--stroke-strong)",
              },
            }),
            el(
              "div",
              { style: { minWidth: 0 } },
              el("div", { class: "list__title" }, name),
              el("div", { class: "mono" }, hex),
              el("div", { class: "list__meta truncate" }, role),
            ),
          ),
        ),
      ),
    ),
  );
}

function field(label, control, hint) {
  return el(
    "div",
    { class: "field" },
    el("label", {}, label),
    control,
    hint && el("span", { class: "hint" }, hint),
  );
}
