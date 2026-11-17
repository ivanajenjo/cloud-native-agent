# ADR-0010: Web UI estática, CLI y cliente común de la API

- Estado: aceptado
- Fecha: 2026-11-17

## Contexto
La fase 3 añade un CLI (`cna`) y una web UI sencilla servida por el gateway. Los dos
consumen la misma API REST + SSE a través de `edge`, con el Bearer token. El plan no dice
con qué se construye la web, cómo se comparte el código de cliente entre el navegador y
Node, ni dónde guarda el navegador el token, que da acceso completo a la API.

## Decisión
1. **Cliente común en `@cna/shared/client`.** Un subpath de `@cna/shared` con el parser SSE,
   un `ApiClient` tipado, `followEvents` (reconexión con `Last-Event-ID`) y helpers de
   presentación. Solo usa APIs web estándar (`fetch`, `ReadableStream`, `TextDecoder`) e
   importa de shared únicamente tipos, para que funcione en el navegador y en Node sin
   arrastrar `zod` ni `yaml`.
2. **Web UI sin framework, construida con Vite.** TypeScript y DOM, sin dependencias de
   runtime. Vite (8.3.8) ya estaba en el árbol como dependencia de vitest; `@cna/web` lo
   declara con la misma versión exacta, así que no entra ningún paquete nuevo. El build
   deja `packages/web/dist/` con `base: "/ui/"`. La lógica (reducer de estado, parser de
   diff) es pura y se prueba con vitest en Node; las vistas son funciones finas sobre el DOM.
3. **El gateway sirve los estáticos** bajo `/ui/` (`/` y `/ui` redirigen a `/ui/`), desde
   `CNA_WEB_UI_DIR` (por defecto `packages/web/dist`). Rechaza segmentos `.`/`..` (también
   codificados), ficheros ocultos y symlinks que salgan del directorio. Si la web no está
   construida, `/ui/*` responde 404 y el gateway arranca igual.
4. **`edge` no sigue redirecciones del gateway** (`redirect: "manual"`): el navegador recibe
   el `302` tal cual y `edge` nunca pide una `Location` elegida por el contenedor del agente.
5. **Contenido no fiable en la web.** Todo lo que llega del modelo, de las tools, del repo o
   de la red se pinta con `textContent`: nunca `innerHTML`, `outerHTML`,
   `insertAdjacentHTML` ni `document.write` (un test lo comprueba en `packages/web/src`).
   No se interpreta Markdown. Las respuestas de `/ui/*` llevan una CSP estricta
   (`default-src 'none'`, scripts y estilos solo de `'self'`, `frame-ancestors 'none'`).
6. **Token en el navegador.** La web pide el token y lo guarda en `sessionStorage`; con
   "recordar en este navegador", en `localStorage`. La web lee el SSE con `fetch` (no
   `EventSource`, que no admite cabeceras). Un `401` vuelve a pedir el token.
7. **CLI en Node sin dependencias**: `node:util` `parseArgs` y `node:readline` para la
   entrada del usuario en el terminal (la trampa de `readline` es para el JSONL de Pi, no
   aplica aquí). URL con `CNA_URL` o `--url` (por defecto `http://127.0.0.1:8080`) y token
   solo con `CNA_TOKEN`, para que no quede en el historial ni en `ps`. Se instala desde el
   repo (`npm run build` y `npx cna`, o `npm link -w @cna/cli`), no va en la imagen.
8. **Textos de cara al usuario en español** en la web y el CLI; el código y los
   identificadores siguen en inglés (AGENTS.md).

## Consecuencias
- (+) Sin paquetes nuevos y sin framework que mantener; la web pesa poco y la sirve el
  mismo gateway, sin otro contenedor.
- (+) Un solo cliente de la API, probado una vez, para el CLI y la web.
- (−) El token en `localStorage` queda al alcance de cualquier script de la página: la CSP y
  la regla de `textContent` son lo que lo protege. Es coherente con ADR-0006 (uso personal,
  red local o Tailscale).
- (−) Sin Markdown la salida del modelo se ve como texto plano.
- (−) Si el gateway se reinicia, el estado de la web se reconstruye desde el replay de
  eventos; si el replay está truncado, la web ofrece recargar la conversación.
