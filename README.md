# maio · Plataforma agéntica

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
| `src/views/` | Inicio (reportes), Llamadas, Agentes, Clientes |
| `src/components/ui.js` | Tarjetas, KPIs, gráficos SVG, switches |
| `src/styles/tokens.css` | Variables de diseño (paleta, radios, blur, grano, tipografía) |
| `src/data/mock.js` | Datos de demostración |
| `design/palette.json` | Paleta canónica |
| `design/brand/` | Logo, icono y normas de marca |

Las vistas de Agenda, Acciones, Conocimiento y Ajustes siguen en `src/views/` pero no están
enrutadas: basta con volver a añadirlas a `ROUTES` en [src/main.js](src/main.js).

## Marca

**maio**. Wordmark en Space Grotesk Medium en minúsculas con tracking cerrado; el símbolo es una
burbuja de conversación con onda de voz trazada a mano. Especificaciones y variantes en
`design/brand/brand.json`.

## Tipografía

SF Pro Regular (400) para toda la interfaz; SF Pro Light (300) reservado a textos grandes
(títulos de vista y cifras de KPI).

## Paleta

La interfaz es **monocroma**: Ink Black sobre blanco y Platinum, con una escala de grises
derivada. La jerarquía de estados se resuelve con el relleno, no con el color:
negro sólido = crítico, contorno negro = destacado, gris = correcto.

| Nombre | Hex | Uso |
| --- | --- | --- |
| Ink Black | `#0D1B1E` | Texto, acento, botones sólidos, gráficos y avatares |
| Platinum | `#EFEFEF` | Base de la interfaz |
| White | `#FFFFFF` | Superficies de tarjeta y paneles de vidrio |

Grises derivados: `#232C2F`, `#4F5759`, `#8B9294`, `#B7BCBD`, `#D9DCDC`.
Los colores cromáticos anteriores quedan archivados en `design/palette.json` bajo `reserved`.

## Conectar agentes reales

Sustituir los exports de `src/data/mock.js` por llamadas a la API. Las vistas leen los datos
en el momento del render, así que basta con devolver las mismas formas de objeto.

