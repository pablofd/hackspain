import { el, mount } from "../lib/dom.js";

/** Panel lateral efímero: se monta en <body> y se limpia al cerrar. */
export function openDrawer({ title, sub, body, footer }) {
  const scrim = el("div", { class: "drawer-scrim" });
  const panel = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true" });

  function close() {
    scrim.remove();
    panel.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  mount(
    panel,
    el(
      "header",
      { class: "drawer__head" },
      el(
        "div",
        { style: { minWidth: 0 } },
        el("h3", { class: "drawer__title" }, title),
        sub && el("p", { class: "drawer__sub" }, sub),
      ),
      el("button", { class: "btn btn--icon btn--ghost ml-auto", onclick: close, "aria-label": "Cerrar" }, "✕"),
    ),
    el("div", { class: "drawer__body" }, ...body(close)),
    footer && el("div", { class: "drawer__foot" }, ...footer(close)),
  );

  document.body.append(scrim, panel);
  return close;
}
