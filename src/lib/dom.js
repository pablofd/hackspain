/** Mini helper de creación de DOM: el(tag, props, ...children) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Igual que el() pero en el namespace SVG. */
export function svg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== "list") {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Sustituye el contenido de un nodo. */
export function mount(host, ...children) {
  host.replaceChildren();
  append(host, children);
  return host;
}

export const initials = (name) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
