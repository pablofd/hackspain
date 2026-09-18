import { el, mount } from "./lib/dom.js";
import { icon } from "./lib/icons.js";
import { clinic } from "./data/mock.js";

import * as home from "./views/home.js";
import * as calls from "./views/calls.js";
import * as config from "./views/config.js";
import * as clients from "./views/clients.js";

const ROUTES = {
  "/": { view: home, icon: "reports", label: "Inicio" },
  "/llamadas": { view: calls, icon: "phone", label: "Llamadas", badge: "12" },
  "/clientes": { view: clients, icon: "clients", label: "Clientes" },
  "/configuracion": { view: config, icon: "settings", label: "Configuración" },
};

const NAV = [{ label: "maio", items: ["/", "/llamadas", "/clientes", "/configuracion"] }];

const contentHost = el("div", { class: "content", id: "content" });
const titleNode = el("h1", { class: "topbar__title" });
const subNode = el("p", { class: "topbar__sub" });
const navLinks = new Map();

function currentPath() {
  const path = location.hash.replace(/^#/, "") || "/";
  return ROUTES[path] ? path : "/";
}

/* La barra superior reserva el ancho de la barra de scroll para alinearse con las tarjetas */
function syncScrollGutter() {
  const gutter = contentHost.offsetWidth - contentHost.clientWidth;
  document.documentElement.style.setProperty("--scroll-gutter", `${gutter}px`);
}

function renderRoute() {
  const path = currentPath();
  const route = ROUTES[path];
  titleNode.textContent = route.view.meta.title;
  subNode.textContent = route.view.meta.sub;
  document.title = `${route.view.meta.title} · maio`;
  mount(contentHost, route.view.render());
  contentHost.scrollTop = 0;
  navLinks.forEach((link, key) => link.classList.toggle("is-active", key === path));
  document.body.classList.remove("nav-open");
  syncScrollGutter();
}

function sidebar() {
  return el(
    "aside",
    { class: "sidebar grain" },
    el(
      "div",
      { class: "brand" },
      icon("maio", "brand__mark"),
      el("div", { class: "brand__name" }, "maio"),
    ),
    el(
      "nav",
      { class: "nav" },
      ...NAV.map((group) =>
        el(
          "div",
          { class: "nav__group" },
          el("div", { class: "nav__label" }, group.label),
          ...group.items.map((path) => {
            const r = ROUTES[path];
            const link = el(
              "a",
              { class: "nav__item", href: `#${path}` },
              icon(r.icon),
              el("span", {}, r.label),
              r.badge && el("span", { class: `nav__badge${r.soft ? " nav__badge--soft" : ""}` }, r.badge),
            );
            navLinks.set(path, link);
            return link;
          }),
        ),
      ),
    ),
    el(
      "div",
      { class: "sidebar__footer grain" },
      el("h4", {}, "maio en servicio"),
      el("p", {}, "2 llamadas en curso · 0 en cola"),
      el(
        "div",
        { class: "row" },
        el("span", { class: "pill pill--ok" }, el("span", { class: "dot dot--pulse" }), "En directo"),
        el("button", { class: "btn btn--sm btn--ghost ml-auto" }, "Pausar"),
      ),
    ),
    el(
      "div",
      { class: "user-chip" },
      el("span", { class: "user-chip__avatar" }, clinic.user.initials),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "user-chip__name" }, clinic.user.name),
        el("div", { class: "user-chip__role truncate" }, clinic.user.role),
      ),
    ),
  );
}

function topbar() {
  const input = el("input", { type: "search", placeholder: "Buscar llamadas, pacientes, agentes" });
  const search = el("div", { class: "search" }, icon("search", "nav__icon"), input, el("kbd", {}, "⌘K"));

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
    }
  });

  return el(
    "header",
    { class: "topbar" },
    el(
      "button",
      {
        class: "btn btn--icon btn--ghost nav-toggle",
        title: "Menú",
        "aria-label": "Abrir menú",
        onclick: () => document.body.classList.toggle("nav-open"),
      },
      icon("menu", "nav__icon"),
    ),
    el("div", { class: "topbar__titles" }, titleNode, subNode),
    el(
      "div",
      { class: "topbar__actions" },
      search,
      el("button", { class: "btn btn--icon btn--ghost", title: "Notificaciones" }, icon("bell", "nav__icon")),
    ),
  );
}

mount(
  document.getElementById("app"),
  el("div", { class: "app-bg", "aria-hidden": "true" }),
  el(
    "div",
    { class: "shell" },
    sidebar(),
    el("main", { class: "main" }, topbar(), contentHost),
    el("div", {
      class: "scrim",
      "aria-hidden": "true",
      onclick: () => document.body.classList.remove("nav-open"),
    }),
  ),
);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.body.classList.remove("nav-open");
});

window.addEventListener("resize", syncScrollGutter);
window.addEventListener("hashchange", renderRoute);
renderRoute();
