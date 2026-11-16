# AGENTS.md — guía para agentes que implementan este repo

Agente de programación "Claude Code lite" auto-hospedado, basado en Pi
(`@earendil-works/pi-coding-agent`), que corre en Docker (Raspberry Pi 4 arm64, MacBook)
y más adelante en k8s local. Uso personal, solo GitHub.

## Desarrollo con agentes (Claude Code)
El desarrollo se hace con dos agentes definidos en `.claude/agents/`:
- **`tech-lead`** (Opus): agente principal de la sesión (`.claude/settings.json`, o
  `claude --agent tech-lead`). Trocea la fase en curso, delega, revisa y hace los commits.
- **`implementer`** (Haiku): subagente que escribe el código y los tests de cada tarea.

Si eres `implementer`, sigue el encargo recibido y esta guía; no replanifiques.

## Antes de escribir código
1. Lee `docs/PLAN.md` entero y los ADR de `docs/adr/`. Son la fuente de verdad.
2. Identifica la **fase** en la que estás (sección "Fases" del plan). Implementa **solo esa
   fase**. No adelantes trabajo de fases posteriores ni del backlog.
3. Si algo del plan no se puede hacer como está escrito, para y explícalo. Si se acuerda un
   cambio, actualiza `docs/PLAN.md` y, si es una decisión de arquitectura, añade un ADR nuevo
   (`docs/adr/NNNN-titulo.md`, mismo formato que los existentes).
4. Para cualquier duda sobre Pi, **lee su documentación instalada** en vez de suponer:
   `node_modules/@earendil-works/pi-coding-agent/docs/` (sobre todo `rpc.md`,
   `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `extensions.md`, `models.md`,
   `security.md`) y los ejemplos de `examples/extensions/`. Si el plan no coincide con la
   documentación instalada, manda la instalada y hay que avisar.

## Stack y convenciones
- **Node 22 LTS** (≥ 22.21), **TypeScript estricto**, ESM (`"type": "module"`), npm workspaces.
- Paquetes en `packages/*` con nombre `@cna/<carpeta>` (`@cna/gateway`, `@cna/edge`,
  `@cna/extensions`, `@cna/cli`, `@cna/web`, `@cna/shared`).
- Tipos compartidos de API y eventos SSE **solo** en `@cna/shared`. No duplicarlos.
- HTTP del gateway y del edge: **Hono** + `@hono/node-server`. Validación de la API: **zod**.
- Tools de Pi: esquemas con **typebox** (`Type` se importa de `typebox`). Enums con
  `StringEnum` de `@earendil-works/pi-ai`, nunca `Type.Union`/`Type.Literal`. Pi valida
  como JSON Schema: `Type.Refine` y los codecs no se aplican; comprueba eso en `execute`.
- Lint/format: **biome**. Tests: **vitest**.
- Pi con **versión exacta** fijada (`1.5.2`), sin `^`. Actualizarla es una tarea aparte.
- Añade dependencias solo si son necesarias; prefiere la librería estándar de Node.
- Código, identificadores y comentarios en **inglés**. Documentación (`docs/`) en **español**.
- Commits: Conventional Commits en español (`feat(gateway): ...`, `fix(edge): ...`,
  `docs: ...`), pequeños y de un solo propósito.

## Comandos (cuando existan)
```
npm install
npm run build        # tsc en todos los workspaces
npm run typecheck
npm run lint         # biome check
npm test             # vitest run
docker compose -f deploy/compose/docker-compose.yml up --build
```
Una tarea está terminada solo si `typecheck`, `lint` y `test` pasan, y la documentación
afectada está actualizada.

## Trampas conocidas de Pi (no las ignores)
- **RPC:** `pi --mode rpc` habla JSONL por stdin/stdout. Separa registros **solo por `\n`**
  (quita un `\r` final si lo hay). **No uses `readline`**: corta también en U+2028/U+2029,
  que son válidos dentro de strings JSON. Lee stdout sin parar; stderr no es protocolo.
- Pi exporta `RpcClient`, pero **no responde diálogos**: escribimos el nuestro en
  `@cna/gateway` y reutilizamos los tipos RPC exportados (ADR-0002).
- Diálogos de extensiones (`ctx.ui.select/confirm/input/editor`) llegan como
  `{"type":"extension_ui_request","id",...}` y se responden con
  `{"type":"extension_ui_response","id", value | confirmed | cancelled}`. Los métodos
  `notify/setStatus/setWidget/setTitle` no esperan respuesta. Puede haber varios
  diálogos pendientes a la vez.
- El tipo de pregunta va como prefijo `cna:<kind>:` en el título (códec en `@cna/shared`).
- **Fin de ejecución = `agent_settled`**, no `agent_end`.
- `message_update` solo trae deltas; el mensaje definitivo es el de `message_end`.
- Mientras el agente está en streaming, un `prompt` necesita `streamingBehavior`
  (`"steer"` o `"followUp"`). La respuesta trae `data.disposition`.
- Una extensión avisa al gateway con `pi.appendEntry("cna.<tipo>", datos)`, que llega por
  RPC como `entry_appended` (ADR-0007).
- En tools: para marcar error, **lanza una excepción** en `execute` (devolver un objeto no
  marca error). Si una tool modifica ficheros, usa `withFileMutationQueue()`.
- `promptGuidelines` se añaden sin prefijo: cada línea debe nombrar la tool
  ("Use todo when…", nunca "Use this tool…").
- Arranca Pi con `--no-approve --no-extensions --no-mcp` y nuestras extensiones con `-e`,
  con `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1` y `PI_CODING_AGENT_DIR`
  apuntando a la configuración generada (`models.json`, `AGENTS.md` global).

## Invariantes de seguridad (nunca romper)
- El contenedor `agent` **no tiene salida directa** a internet: todo pasa por `edge`
  (ADR-0004). No añadas el agente a redes externas ni puertos que lo esquiven.
- Política de red por defecto **`ask`**; sin respuesta en el timeout o sin sesión → **denegar**.
- Las preguntas de red las decide `edge`, y su política y registro se guardan en el
  volumen de `edge`, no en `/data` (ADR-0006).
- `AGENT_API_TOKEN` solo existe en `edge`, que exige `Authorization: Bearer` en toda la
  API salvo `GET /health` y los estáticos de la web UI.
- **Nunca** montar `/var/run/docker.sock` ni ejecutar contenedores con privilegios.
- Contenedores con usuario no root (`agent`, uid 1000).
- El agente trabaja en ramas `agent/<slug>`. **Nunca** push a la rama base ni `--force`.
  `git push` y `create_pr` piden confirmación salvo `autoPush: true`.
- Los secretos (`GITHUB_TOKEN`, API keys) nunca se escriben en logs, eventos SSE ni
  ficheros del workspace; el token de GitHub no va en la URL del remoto.

## Tests
- **Nunca** llames a un LLM real en los tests.
- Bridge RPC: pruébalo contra un **proceso Pi falso** (script Node que emite JSONL) e
  incluye casos con U+2028 dentro de strings, líneas partidas entre chunks, `\r\n`,
  varios diálogos pendientes y `agent_end` seguido de reintento antes de `agent_settled`.
- e2e: Pi real con un proveedor mock (servidor HTTP local compatible con OpenAI que
  devuelve respuestas guionizadas) definido en `models.json`.
- Edge: tests de la política (allowlist con comodines y puertos, ask, deny por timeout,
  deduplicación de preguntas concurrentes al mismo destino) y de la entrada (sin Bearer
  no pasa nada salvo `/health` y los estáticos).

## Fuera de alcance
No implementes: Docker-in-Docker, MCP, subagentes, permisos por tool, multiusuario,
GitLab/Gitea, ni nada del backlog del plan, salvo que se pida explícitamente.
