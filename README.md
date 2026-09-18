# Aurea Health · Plataforma agéntica

Interfaz para operar agentes de voz que actúan como recepcionistas del sector sanitario.
Solo front-end: datos simulados en `src/data/mock.js`, listos para sustituir por la API real.

## Ejecutar

Sin dependencias ni build (ES modules nativos):

```bash
python3 -m http.server 4321
# http://127.0.0.1:4321/
```

## Estructura

| Ruta | Contenido |
| --- | --- |
| `index.html` | Punto de entrada |
| `src/main.js` | Shell, menú lateral y router por hash |
| `src/views/` | Inicio, Llamadas, Agentes, Agenda, Clientes, Acciones, Reportes, Conocimiento, Ajustes |
| `src/components/ui.js` | Tarjetas, KPIs, gráficos SVG, switches |
| `src/styles/tokens.css` | Variables de diseño (paleta, radios, blur, grano) |
| `src/data/mock.js` | Datos de demostración |
| `design/palette.json` | Paleta canónica |

## Paleta

| Nombre | Hex | Uso |
| --- | --- | --- |
| Ink Black | `#0D1B1E` | Texto principal, avatares, bordes y sombras |
| Platinum | `#EFEFEF` | Base de la interfaz junto al blanco |
| Dusty Mauve | `#A54657` | Color principal para destacar y acciones primarias |
| Tropical Teal | `#48A9A6` | Detalle: estados correctos y agentes en línea |
| Coral Glow | `#FF8552` | Detalle: alertas, urgencias y escalados |
| White | `#FFFFFF` | Superficies de tarjeta y paneles de vidrio |

Sobre fondo claro se usan tres sombras derivadas para asegurar contraste de texto:
`--mauve-deep: #8B3849`, `--teal-deep: #2C7A77` y `--coral-deep: #C2542A`.

## Conectar agentes reales

Sustituir los exports de `src/data/mock.js` por llamadas a la API. Las vistas leen los datos
en el momento del render, así que basta con devolver las mismas formas de objeto.

