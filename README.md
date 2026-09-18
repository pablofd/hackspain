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
| White | `#FFFFFF` | Fondo de la plataforma y superficies |
| Charcoal | `#565656` | Texto secundario y bordes |
| Light Green | `#B2FFA9` | Acento principal, estados activos |
| Blazing Flame | `#FF4A1C` | Urgencias y acciones críticas |
| Coffee Bean | `#81523F` | Superficies cálidas elevadas |
| Deep Mocha | `#3F2A2B` | Texto oscuro, avatares y sombras |

Sobre blanco se usan dos sombras derivadas para asegurar contraste de texto:
`--green-deep: #1F5C22` y `--flame-deep: #C9350F`.

## Conectar agentes reales

Sustituir los exports de `src/data/mock.js` por llamadas a la API. Las vistas leen los datos
en el momento del render, así que basta con devolver las mismas formas de objeto.

