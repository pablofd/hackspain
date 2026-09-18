# maio · Recepción agéntica

Interfaz para operar **maio**, el agente de voz que atiende la recepción de una clínica.
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
| `src/views/` | Inicio, Llamadas, Clientes, Configuración |
| `src/components/` | Tarjetas, KPIs, gráficos SVG, switches y drawer |
| `src/styles/tokens.css` | Variables de diseño (paleta, radios, blur, grano, tipografía) |
| `src/data/mock.js` | Perfil de maio, llamadas, pacientes y métricas de demostración |
| `design/palette.json` | Paleta canónica |
| `design/brand/` | Logo, icono y normas de marca |

## Marca

**maio**. Wordmark en Space Grotesk Medium en minúsculas con tracking cerrado; el símbolo es una
burbuja de conversación con onda de voz trazada a mano. Especificaciones y variantes en
`design/brand/brand.json`.

## Tipografía

SF Pro Regular (400) para toda la interfaz; SF Pro Light (300) reservado a textos grandes
(títulos de vista y cifras de KPI).

## Paleta

Plataforma **blanca** con aristas vivas (radio 0) y hairlines de 1 px. El color entra con
moderación: el rojo queda reservado a lo crítico.

| Nombre | Hex | Uso |
| --- | --- | --- |
| Pitch Black | `#12100E` | Texto, marca, botones primarios, serie principal de gráficos |
| Parchment | `#F6F0ED` | Superficies suaves: hover, tarjetas tintadas, burbujas del paciente |
| Dusty Denim | `#748CAB` | Acento de datos: series secundarias, sparklines, avatares |
| Blue Slate | `#646E78` | Texto secundario y etiquetas |
| Lipstick Red | `#EC0B43` | Solo crítico: escalados, riesgo alto, cola de llamadas |
| White | `#FFFFFF` | Fondo y superficies de tarjeta |

Las paletas anteriores quedan archivadas en `design/palette.json` bajo `reserved`.

## Conectar el agente real

Sustituir los exports de `src/data/mock.js` por llamadas a la API. Las vistas leen los datos
en el momento del render, así que basta con devolver las mismas formas de objeto.

