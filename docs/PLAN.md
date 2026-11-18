# Plan de desarrollo — cloud-native-agent

Agente de programación auto-hospedado, basado en [Pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`), empaquetado en un contenedor que incluye todo lo
necesario para clonar un repo de GitHub, trabajar en él (Java, Node, Python, Go),
ejecutar tests y subir los cambios. Se controla por API REST, una web UI sencilla y un CLI.

## Requisitos (decididos)

| Tema | Decisión |
|---|---|
| Entrada de tareas | API REST. Conversacional, con preguntas al usuario (`ask_user`) |
| Proveedores LLM | Varios: API keys (Anthropic, OpenAI, …) y Ollama/compatibles OpenAI |
| Git | Solo GitHub |
| Stacks | Java, Node, Python, Go |
| Interacción | Conversación multi-turno, web UI sencilla + CLI básico |
| Despliegue | Local: Docker en Raspberry Pi 4 (8 GB, arm64), MacBook y PC con Windows (Docker Desktop; en Windows con WSL2). k8s local (k3s/kind) queda en el backlog (ADR-0012) |
| Lenguaje | TypeScript |
| Uso | Personal, mono-usuario |
| Concurrencia | **1 sesión por réplica**; más sesiones = más réplicas detrás de un único `edge` (ADR-0012) |
| Servicios | El agente ejecuta tests, pero **no** levanta servicios (sin Docker-in-Docker) |
| Push / PR | El agente **pregunta** antes de hacer push/PR, salvo `autoPush: true` |
| Alcance funcional | Un "Claude Code lite": ver [Funcionalidades tipo Claude Code](#funcionalidades-tipo-claude-code) |
| Red saliente | Todo el tráfico sale por un proxy propio. Modo por defecto **`ask`**: dominios fuera de la allowlist se preguntan al usuario |
| Seguridad | Nivel de proyecto personal: contenedor + proxy de salida. Riesgos aceptados en ADR-0006 |

## Arquitectura

```
 Web UI / CLI / curl                                   internet
        │  REST + SSE (Bearer token)                       ▲
        ▼                                                  │ allowlist / ask
┌─────────────────────────── edge (TS) ────────────────────┴─────┐
│ · :8080 valida el Bearer y reenvía al gateway                  │
│ · :3128 proxy de salida (CONNECT + HTTP) · registro + política │
│ · decide las preguntas de red · única pieza con red externa    │
└──────────────┬──────────────────────────────────▲──────────────┘
  red interna  │ (sin salida a internet)          │ HTTPS_PROXY
               ▼                                  │
┌───────────────────────── agent (contenedor) ────┴──────────────┐
│ gateway (TS, Node) :8090, solo en la red interna               │
│  · API REST + SSE · sirve la web UI estática                   │
│  · SessionManager (máx. 1 sesión activa)                       │
│  · checkpoints, diff y registro de tools                       │
│  · RpcBridge ── spawn ──► pi --mode rpc (subproceso)           │
│                              │ JSONL stdin/stdout              │
│                              ▼                                 │
│                    Pi + extensiones propias:                   │
│                     ask_user, git, todo, plan-mode, guard, web │
│ Toolchains (mise): Java+Maven/Gradle, Node+pnpm, Python+uv, Go │
│ /data/workspace  /data/sessions  /data/cache  (volumen)        │
└────────────────────────────────────────────────────────────────┘
```

### Decisiones clave
- **Pi como dependencia, no fork** (ADR-0001, ADR-0005). Paquete
  `@earendil-works/pi-coding-agent`, versión exacta `1.5.2`. Se amplía con extensiones.
- **Pi en modo RPC como subproceso** del gateway (ADR-0002). Aísla fallos del agente y el
  protocolo RPC ya traduce los diálogos de extensiones a `extension_ui_request`.
- **Una sesión por réplica** (ADR-0003). Escalar = más réplicas (`agent-1`, `agent-2`…), cada
  una en su propia red interna y todas detrás de un único `edge` (ADR-0012).
- **Imagen única multi-arch** (`linux/amd64`, `linux/arm64`) con toolchains vía `mise`.
  Si el repo trae `.tool-versions`/`mise.toml`, se respetan.
- **GitHub con PAT fine-grained** limitado a los repos propios + `gh` CLI.
- **Proxy de salida propio** (ADR-0004). El agente está en una red interna sin salida;
  todo pasa por `edge`, que registra cada conexión y aplica la política.
- **Seguridad proporcionada a un proyecto personal** (ADR-0006). `edge` se queda pequeño:
  valida el Bearer y decide las preguntas de red, de modo que el agente no pueda abrirse
  la red a sí mismo. El token de GitHub y las API keys siguen en el contenedor del agente
  y las confirmaciones de push/PR son una ayuda, no una barrera; es un riesgo aceptado.
- **El gateway observa; las extensiones solo aportan tools** (ADR-0007). Checkpoints, diff
  y registro de tools los hace el gateway a partir de los eventos RPC. Cuando una
  extensión necesita avisar al gateway usa `pi.appendEntry()`, que llega por RPC como
  evento `entry_appended`.
- **Contrato interno `edge` ↔ gateway** (ADR-0008). `providers.yaml` se monta en solo
  lectura en los dos contenedores para que `edge` permita los proveedores sin fiarse del agente.
- **Servicios auxiliares** (ADR-0009). `notifications.yaml` y `web.yaml` siguen el mismo
  camino: solo lectura en los dos contenedores, y `edge` permite sus hosts.
- **Persistencia y reanudación** (ADR-0011). Pi arranca con `--session-id` igual al id de la
  sesión; el gateway guarda su estado en `/data/state`, reanuda tras un reinicio, suspende Pi por
  inactividad y lleva un historial de sesiones. Solo se trabaja sobre PRs propios (`agent/*`).
- **Varias réplicas con un `edge` compartido** (ADR-0012). `edge` identifica la réplica de cada
  conexión de salida por su IP de origen y le pregunta a ella; la API de una réplica se alcanza
  con el prefijo `/replicas/<nombre>` y las rutas sin prefijo van a la primera.
- **Web UI y CLI** (ADR-0010). Cliente común en `@cna/shared/client`; web estática sin
  framework (build con Vite) servida por el gateway en `/ui/` con CSP estricta; el contenido
  del agente se pinta siempre como texto. El CLI lee el token solo de `CNA_TOKEN`.

## API REST (borrador v1)

Se entra por `edge:8080`, que exige `Authorization: Bearer <AGENT_API_TOKEN>` salvo en
`GET /health` y en los ficheros estáticos de la web UI, y reenvía al gateway.
- Rutas públicas exactas (solo `GET`/`HEAD`): `/health` (la responde `edge`), `/`, `/ui` y
  `/ui/*`. Una ruta `/ui/*` con segmentos `.` o `..` (también `%2e`) no es pública. La web
  UI se sirve bajo `/ui/`, y el gateway debe rechazar rutas que salgan de su directorio.
- `edge` quita `Authorization` y las cabeceras hop-by-hop antes de reenviar, para que el
  token no llegue nunca al contenedor del agente.

```
GET    /health
GET    /models                          modelos/proveedores configurados
GET    /session                         sesión actual (o 404)
POST   /session                         {repo, baseBranch?, prompt, model?, thinking?,
                                         mode?: "plan"|"auto", autoPush?, pr?}
                                        con pr, prompt es opcional (ADR-0011)
                                        409 si la réplica ya está ocupada
GET    /session/events                  SSE con replay (Last-Event-ID)
GET    /session/messages                conversación completa (para reconstruir la UI)
POST   /session/messages                {text, mode?: "steer"|"followUp"}
POST   /session/answers/:questionId     {value} | {confirmed} | {cancelled:true}
                                        404 si no existe, 409 si ya está resuelta
PUT    /session/model                   {model, thinking?} cambia de modelo en caliente
POST   /session/abort                   aborta el turno y cancela las preguntas pendientes
GET    /session/todos                   lista de tareas actual del agente
GET    /session/diff                    diff frente a la rama base (?checkpoint=id)
GET    /session/checkpoints             snapshots por ejecución
GET    /session/stats                   tokens, coste y uso del contexto (Pi get_session_stats)
GET    /session/history                 sesiones de la réplica, la más reciente primero
POST   /session/history/:id/resume      {prompt?} reanuda una sesión cerrada (409 si hay otra)
POST   /session/checkpoints/:id/restore {conversation?: boolean}
DELETE /session                         cierra y limpia el workspace. 409 si hay cambios
                                        sin subir, salvo ?force=true
```

Réplicas (ADR-0012; las atiende `edge`):
```
GET    /replicas                        cada réplica de EDGE_REPLICAS: {name, reachable, session}
*      /replicas/<nombre>/<ruta>        la API de esa réplica (/<ruta>); 404 replica_not_found
```
Sin prefijo, la API es la de la réplica por defecto (la primera de `EDGE_REPLICAS`).
No hay endpoint para pedir "una réplica libre": lo resuelve el cliente con `GET /replicas`
(ADR-0013).

Endpoints de red (los atiende `edge`, no el gateway):
```
GET    /network/log?limit=N             últimas conexiones desde que arrancó edge (host, puerto,
                                        decisión, bytes); máx. 1000, por defecto 200
GET    /network/policy                  modo, allowlist del usuario, base, servicios y puertos
PUT    /network/policy                  {mode?, allow?}: cambiar el modo o reemplazar la
                                        allowlist del usuario
```

Como hay una sesión por réplica, la API usa `/session` en singular; para hablar con otra réplica
se antepone `/replicas/<nombre>` (ADR-0012).

**Estados:** `idle → cloning → running ⇄ waiting_input → ready → closed` (+ `error`).
- `running → ready` ocurre con el evento `agent_settled` de Pi, no con `agent_end` (tras
  `agent_end` Pi aún puede reintentar, compactar o seguir con mensajes en cola).
- `waiting_input` mientras haya **al menos una** pregunta pendiente; puede haber varias a
  la vez porque Pi ejecuta tools en paralelo.
- Fallo al clonar o muerte del proceso Pi → `error`, con el motivo en el evento `status`.
- Un reinicio del contenedor reanuda la sesión desde disco (ADR-0011): Pi vuelve a abrir su
  conversación y la sesión queda en `ready`; la ejecución en curso y las preguntas pendientes se
  pierden.

**Eventos SSE** (normalizados desde los eventos RPC de Pi y del proxy):
`status`, `message_delta`, `thinking_delta`, `message`, `tool_start`, `tool_update`,
`tool_end`, `question`, `question_resolved`, `network`, `todo`, `checkpoint`
(`action: created|restored`), `mode` (al aprobar el plan), `compaction`, `retry`, `notify`,
`error`, `history` (conversación al reanudar).
- Pi solo envía deltas en `message_update`; el mensaje definitivo es el de `message_end`.
- `question.kind`: `ask_user`, `confirm` (push/PR), `plan` (*aprobar*, *pedir cambios*) o
  `network` (*permitir esta vez*, *permitir siempre*, *denegar*).
- `extension_ui_request` no lleva metadatos, así que las extensiones marcan el tipo con un
  prefijo en el título (`cna:<kind>:`), definido en `@cna/shared`; el gateway lo quita.
- Las preguntas `network` las crea `edge` y las publica a través del gateway para que
  salgan en el mismo flujo SSE. Su respuesta llega a `POST /session/answers/:id` como las
  demás, pero `edge` la intercepta (ids con prefijo `net-`) y no la reenvía.
- Contrato interno `edge` → gateway (ADR-0008): `POST /internal/questions`,
  `POST /internal/questions/:id/resolved` y `POST /internal/network`. `edge` nunca reenvía
  `/internal/*` desde fuera. Las opciones de una pregunta `network` son `allow_once`,
  `allow_always` y `deny`.

La web UI no puede usar `EventSource` (no permite cabeceras): lee SSE con `fetch`.

## Extensiones de Pi

Pi se arranca con `--no-approve --no-extensions --no-mcp` y nuestras extensiones con
`-e`: así no se carga nada ejecutable del repo clonado (`.pi/extensions`,
`.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`). El `AGENTS.md`/`CLAUDE.md` del
repo sí se carga, como texto no fiable.

| Extensión | Qué hace |
|---|---|
| `ask_user` | Tool `ask_user({question, options?, multiline?})`. Usa `ctx.ui.select` / `ctx.ui.input` / `ctx.ui.editor`; el gateway lo publica como `question{kind:"ask_user"}`. |
| `git` | Tools `git_status`, `git_commit`, `git_push`, `create_pr` (con `gh`). `git_push` y `create_pr` piden confirmación con `ctx.ui.confirm` salvo `autoPush: true`. Ramas siempre `agent/<slug>`; nunca push a la rama base. |
| `todo` | Tool `todo` (crear/actualizar/completar). El estado va en `details` del resultado; el gateway lo lee de `tool_execution_end` y emite `todo`. Basada en `examples/extensions/todo.ts`. |
| `plan-mode` | Con `mode: "plan"` (flag `--cna-plan`) solo activa tools de lectura y añade `submit_plan`. El plan se presenta como `question{kind:"plan"}`; al aprobarlo se activan el resto de tools. Avisa del cambio de modo con `pi.appendEntry("cna.mode", …)`. Basada en `examples/extensions/plan-mode`. |
| `guard` | Hook `tool_call` que bloquea comandos peligrosos evidentes (`git push` directo por `bash`, `--force`, `rm -rf /`, `docker run`…). Es una ayuda contra despistes del modelo, no una barrera de seguridad. |
| `web` | Tools `web_search` (SearXNG autoalojado, Brave o Tavily según `config/web.yaml`, que recibe con `--cna-web-config`) y `web_fetch` (descarga y convierte a texto). El resultado se marca como contenido externo no fiable. Su tráfico pasa por el proxy como el resto. |

No hay extensión `audit` ni `checkpoint`: lo hace el gateway (ADR-0007).

Además se añade un prompt de sistema (`--append-system-prompt <fichero>`) que explica el
entorno: toolchains disponibles, que no hay Docker ni servicios externos, que la red
pregunta por dominios nuevos y la política de ramas y PR.

## Proveedores y modelos

Fichero `config/providers.yaml` (montado como volumen/ConfigMap) que el gateway traduce
a `models.json` de Pi al arrancar. Las API keys llegan por variables de entorno
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), que Pi ya reconoce.

```yaml
default: ollama/qwen3-coder:30b               # o <proveedor>/<modelo> de los built-in de Pi
providers:
  ollama:
    baseUrl: http://192.168.1.50:11434/v1     # Ollama en otra máquina
    api: openai-completions
    models:
      - id: qwen3-coder:30b
        contextWindow: 65536                  # debe coincidir con el num_ctx de Ollama
```

- Pi exige `apiKey` también en proveedores que no la usan: el gateway pone un valor de
  relleno si falta.
- Para Ollama y similares, `compat.supportsDeveloperRole: false` y
  `compat.supportsReasoningEffort: false` por defecto, configurables.
- Los hosts de los proveedores con `baseUrl` entran en la allowlist de red automáticamente.
  Un proveedor integrado de Pi sin `baseUrl` (Anthropic, OpenAI…) no declara su host, así
  que `edge` no lo conoce: en modo `ask` la primera llamada genera una pregunta `network`
  (p. ej. `api.anthropic.com:443`) y basta con responder *permitir siempre* una vez.
- Las API keys escritas en `providers.yaml` (literales o `$VARIABLE`) se añaden a los
  secretos que el gateway sustituye en eventos y logs.

> En la Raspberry Pi 4 no es viable ejecutar un modelo útil con Ollama local:
> Ollama debería correr en el MacBook u otra máquina de la red, o usar API keys.

## Funcionalidades tipo Claude Code

| # | Funcionalidad | Fase | Cómo |
|---|---|---|---|
| 1 | **Lista de tareas visible** | 2 | Extensión `todo` + evento SSE `todo` + `GET /session/todos`. |
| 2 | **Modo plan** | 2 | Extensión `plan-mode`. Investiga en solo lectura, propone plan, espera aprobación y ejecuta. |
| 3 | **Diff de cambios en la UI** | 2 (API), 3 (UI) | `GET /session/diff` (frente a la rama base o a un checkpoint); vista en la web y `cna diff`. |
| 4 | **Checkpoints y deshacer** | 2 | El gateway crea un snapshot git al terminar cada ejecución con cambios. Restaura ficheros y, opcionalmente, la conversación (`fork` de Pi). |
| 5 | **Notificaciones push** | 2 | El gateway avisa cuando la sesión pasa a `waiting_input`, termina o falla. Proveedor configurable: **ntfy** (autoalojable) o Telegram. `config/notifications.yaml`; el host entra en la allowlist automáticamente. |
| 6 | **Instrucciones del proyecto** | 1 | Pi carga el `AGENTS.md`/`CLAUDE.md` del repo. Añadimos un `AGENTS.md` global en el directorio de configuración de Pi. |
| 7 | **Trabajar sobre un PR existente** | 4 | `POST /session` con `pr: <número>`: checkout de la rama del PR; el agente lee los comentarios de revisión con `gh` y los atiende; push a la misma rama. Solo PRs abiertos del propio agente (rama `agent/*`, ADR-0011). |
| 8 | **Procesos en segundo plano** | Backlog | Tool `bash_bg` (`start`, `logs`, `stop`, `list`). Limitado a 1–2 procesos por la RAM de la Pi. |
| 9 | **Tokens y coste por sesión** | 4 | `get_session_stats` de Pi expuesto en `GET /session/stats`. |
| 10 | **Historial de sesiones** | 4 | Listar y retomar sesiones pasadas de la réplica. |
| 11 | **Comandos y skills** | Backlog | Exponer prompt templates y skills de Pi en la UI y el CLI, montados desde la configuración global. |
| 12 | **Imágenes en el prompt** | Backlog | Adjuntar capturas en la web UI y `--image` en el CLI. |

**Descartado conscientemente:**
- **MCP:** Pi lo soporta, pero cada servidor es un proceso más y más destinos de
  red que controlar. Se arranca con `--no-mcp`; queda en el backlog.
- **Subagentes:** demasiado caros en memoria para una Raspberry Pi 4.
- **Permisos por tool:** el contenedor y el proxy de salida cumplen ese papel. Las únicas confirmaciones son push/PR, el plan y la red.

## Seguridad: qué protege y qué no

Detalle en ADR-0006. Es un proyecto personal: se busca contener errores del modelo y
ver a dónde se conecta, no resistir a un atacante decidido.

- **Token de la API:** lo valida `edge`; el contenedor del agente no lo recibe.
- **Red:** las preguntas `network` las decide `edge`, así que el agente no puede abrirse
  la red a sí mismo. La política y el registro viven en el volumen de `edge`.
- **GitHub y API keys:** siguen en el contenedor del agente. Por tanto las confirmaciones
  de push/PR y la extensión `guard` frenan despistes, pero un agente bajo inyección de
  prompt podría saltárselas. Se acota con:
  - PAT fine-grained solo para los repos que se usen, con *Contents* y *Pull requests*
    (lectura y escritura) y *Metadata* (lectura). Sin *Workflows*.
  - Un ruleset en GitHub que proteja la rama base (recomendado; es la barrera real).
  - Límite de gasto en las cuentas de los proveedores LLM.
- **Clonado:** el token se pasa con el credential helper de `gh`, nunca en la URL del
  remoto (quedaría en `.git/config`).
- **Salida de tools:** el gateway sustituye los valores de los secretos conocidos antes
  de publicar eventos o escribir logs.
- **Identidad de los commits:** `CNA_GIT_USER_NAME` / `CNA_GIT_USER_EMAIL`.
- **Colisión de rama:** si `agent/<slug>` ya existe en el remoto se añade un sufijo (`-2`, `-3`…).

## Control de red saliente (egress)

Detalle en ADR-0004.

- **Topología (compose):** una red `internal-N` (`internal: true`, sin salida) por réplica, con
  `agent-N` y `edge`; red `external` solo con `edge`, que publica el `8080` en
  `${CNA_PUBLISH_ADDR:-127.0.0.1}` (`0.0.0.0` para la LAN). El `3128` no se publica. Un agente no
  alcanza a los demás (ADR-0012).
- **Origen:** `edge` identifica qué réplica abre cada conexión por su IP de origen. Lo que no viene
  de una réplica de `EDGE_REPLICAS` se deniega (`unknown_client`).
- **Anti DNS rebinding:** `edge` resuelve el nombre, aplica la política a **todas** las
  direcciones (si alguna es interna, deniega) y conecta a una de esas direcciones, sin
  volver a resolver.
- **Proxy:** `CONNECT` sin interceptar TLS (se ve host y puerto, no URL ni contenido) y
  proxy HTTP normal para peticiones `http://` (p. ej. Ollama). La política se aplica a
  **host y puerto**; por defecto solo 80 y 443.
- **Destinos internos:** loopback, rangos privados, link-local y el propio `edge` se
  deniegan sin preguntar, salvo los hosts de `providers.yaml` (Ollama en la LAN).
- **Clientes:** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY=edge,localhost`; `NODE_USE_ENV_PROXY=1`
  para el `fetch` de Node; `settings.xml` de Maven y `gradle.properties` con el proxy.
  Lo que ignore el proxy no tiene ruta de salida: **falla cerrado**.
- **Modos:** `ask` (**por defecto**), `allowlist` y `audit`. En la fase 0 solo existe
  `audit` (lo externo en 80/443 se permite y registra); `ask` pasa a ser el modo por
  defecto en la fase 1.
- **Allowlist:** entradas `host[:puerto]`, con comodín solo como prefijo (`*.dominio`).
  Base: GitHub (`github.com`, `api.github.com`, `codeload.github.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `raw.githubusercontent.com`), registries (`registry.npmjs.org`, `pypi.org`,
  `files.pythonhosted.org`, `repo.maven.apache.org`, `repo1.maven.org`,
  `plugins.gradle.org`, `proxy.golang.org`, `sum.golang.org`), descargas de toolchains
  (`services.gradle.org`, `downloads.gradle.org`, `nodejs.org`, `go.dev`,
  `dl.google.com`, `api.adoptium.net`, `mise.jdx.dev`), los hosts de `providers.yaml`,
  el buscador de `web_search` y el servicio de notificaciones. La lista exacta se cierra
  en la fase 0 ejecutando cada stack en modo `audit`.
- **Flujo `ask`:** `edge` retiene la conexión, crea una pregunta `network` y la envía al
  gateway de la réplica que abrió la conexión para que salga por SSE. La respuesta la recoge
  `edge` al pasar por la API.
  *Permitir siempre* se persiste en el volumen de `edge`. Sin respuesta en el timeout
  (2 min por defecto) o sin sesión activa → **denegar**. Peticiones concurrentes de una réplica
  al mismo host y puerto comparten la misma pregunta.
- **Registro:** cada conexión (timestamp, réplica, host, puerto, decisión, bytes, duración) va a
  `network.jsonl` en el volumen de `edge` y se emite como evento SSE `network` en su réplica.
- **Limitación aceptada:** la resolución DNS la hace Docker; la exfiltración por DNS es
  posible en teoría.
- **Futuro:** inyección de credenciales en `edge` para que el agente no las vea.

## Contenedor

- Base: `debian:bookworm-slim` + Node 22 LTS (≥ 22.21, por Pi y por `NODE_USE_ENV_PROXY`).
- Paquetes: git, gh, curl, ripgrep, fd, jq, build-essential, unzip.
- `mise` con versiones LTS preinstaladas de Java (Temurin) + Maven + Gradle, Node + pnpm,
  Python + uv, Go.
- Usuario `agent` (uid 1000), sin privilegios.
- Volumen `/data`: `workspace/`, `sessions/` (JSONL de Pi), `cache/` (Maven, Gradle, npm,
  uv, Go), `config/` (configuración de Pi generada), `logs/tools.jsonl`.
- Pi: `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, `PI_CODING_AGENT_DIR`.
- Variables: `GITHUB_TOKEN` y claves de proveedores. `AGENT_API_TOKEN` solo va a `edge`.
- `edge`: imagen ligera de Node, usuario no root, volumen propio `/edge-data` (política
  y registro de red).
- Tamaño estimado del agente: 2–3 GB. Build multi-arch con `docker buildx`.

### Consideraciones Raspberry Pi 4 (8 GB)
- Limitar la JVM de los tests (`MAVEN_OPTS`/`GRADLE_OPTS` con `-Xmx`), Gradle daemon desactivado.
- Usar SSD por USB para `/data` mejor que la microSD.
- Cada equipo construye su propia imagen (`docker compose up --build`); la Pi la construye
  en arm64 nativo. No hay CI ni registro de imágenes. El primer build en la Pi es lento
  (toolchains de mise) y conviene hacerlo con `/var/lib/docker` en el SSD.

## Estructura del repositorio

```
packages/
  gateway/        API de sesión + SSE, SessionManager, RpcBridge, checkpoints, config
  extensions/     extensiones de Pi (ask_user, git, todo, plan-mode, guard, web) + prompt de sistema
  cli/            cliente de terminal
  web/            web UI sencilla (estática, servida por el gateway)
  edge/           entrada con autenticación + proxy de salida con política
  shared/         tipos del protocolo API/eventos compartidos
docker/
  Dockerfile        imagen del agente (gateway + Pi + toolchains)
  Dockerfile.edge   imagen ligera de edge
deploy/
  compose/        docker-compose.yml (agent-1; agent-2 y agent-3 con el profile replicas;
                  SearXNG opcional con un profile)
config/
  providers.example.yaml, notifications.example.yaml, web.example.yaml
docs/
  PLAN.md, fase-1.5.md, adr/
```

Monorepo con npm workspaces, Node 22 LTS, TypeScript estricto, Hono (HTTP), zod (validación de la API), typebox (tools de Pi), `vitest` para tests, `biome` para lint/format. Convenciones detalladas en `AGENTS.md`.

## Fases

### Fase 0 — Esqueleto y contenedores
- Monorepo, tooling (tsconfig, biome, vitest). Sin CI: `typecheck`, `lint` y `test` se
  ejecutan en local, y las imágenes se construyen en local.
- Dockerfile multi-arch con toolchains y Pi instalado. `docker compose up` arranca gateway y `edge`.
- `edge` mínimo: entrada con Bearer y `/health`, reenvío al gateway, proxy `CONNECT` +
  HTTP con registro, y la topología de redes (el agente sin salida directa).
- Verificar que npm, pip/uv, Maven, Gradle, Go, mise, git y gh funcionan a través del
  proxy, y cerrar la allowlist base con el modo `audit` (`scripts/verify-egress.sh`, ver
  `docs/despliegue-local.md`).

### Fase 1 — MVP conversacional (API)
- RpcBridge: spawn de `pi --mode rpc`, parser JSONL conforme, correlación por `id`,
  diálogos de extensión. Reutiliza los tipos RPC que exporta Pi.
- SessionManager: clonar repo, crear rama `agent/<slug>`, arrancar Pi en el workspace.
- Endpoints `/session*` + SSE con replay; `GET /session/messages`; `PUT /session/model`.
- Extensión `ask_user`; preguntas concurrentes y cancelación al abortar.
- Configuración de proveedores (`providers.yaml` → `models.json`); sus hosts entran en la allowlist.
- Política de red en `edge` con modo `ask`: pregunta `network` por SSE, respuesta
  interceptada en `edge`, persistencia de *permitir siempre*, denegar por timeout.
- Extensión `git` con `git_status`, `git_commit` y `git_push`: el MVP ya entrega una rama.
- Prompt de sistema del entorno y `AGENTS.md` global (6).
- Tests: unitarios del parser/bridge con un Pi falso; e2e con un modelo mock; política de red.

### Fase 1.5 — Consolidación (antes de la fase 2)
Mejoras detectadas al revisar la fase 1. No añaden funcionalidad: dejan la base lista para
la fase 2. La especificación de cada tarea (qué hay, qué se quiere, ficheros, tests y
criterio de terminado) está en [`fase-1.5.md`](fase-1.5.md).

1. Verificar con Docker las imágenes y `scripts/verify-egress.sh`, y cerrar la allowlist base.
   **Pendiente:** necesita Docker con red normal (ver `fase-1.5.md`).
2. Fijar las versiones exactas de los toolchains en `docker/mise/config.toml`. **Pendiente**,
   depende de la 1.
3. Partir `SessionManager`: preguntas pendientes con sus timeouts y comprobación del
   workspace, sin cambiar el comportamiento.
4. Test conjunto de `edge` y gateway que recorra una pregunta de red de extremo a extremo.
5. Aclarar la versión de Node en ADR-0005.

### Fase 2 — PR y funcionalidades
Hecha, salvo la comprobación con las imágenes construidas (como las tareas 1 y 2 de la fase
1.5): la imagen de SearXNG del profile `search` y las notificaciones reales no se han probado.
- `create_pr` con `gh`.
- Extensiones `todo` (1), `plan-mode` (2), `guard` y `web`.
- Endpoints `/network/*`.
- Registro de tools, `GET /session/diff` (3) y checkpoints con restauración (4).
- Notificaciones push con ntfy/Telegram (5).

### Fase 3 — CLI y web UI
Hecha (ADR-0010), salvo la comprobación con las imágenes construidas: la web se ha probado con
el build de Vite servido por un backend falso, no dentro del contenedor.
- CLI: `cna run <repo> "<prompt>" [--plan]`, chat interactivo en terminal, responder preguntas,
  `cna status/diff/todos/abort/close`.
- Web UI: formulario de nueva sesión (modo plan/auto), chat con streaming, tarjetas de tool calls,
  diálogo de preguntas (incluidas plan y red), checklist de tareas, vista de diff con
  checkpoints, panel de conexiones de red, botón de abortar.

### Fase 4 — Persistencia y robustez
Hecha (ADR-0011), salvo la comprobación con las imágenes construidas (límites de recursos del
compose) y el trabajo sobre PR contra GitHub real (probado con un `gh` falso).
- Reanudar sesión tras reinicio del contenedor (JSONL de Pi + estado en disco).
- Timeouts de inactividad, límites de recursos, limpieza de workspace.
- Trabajar sobre un PR existente (7), tokens y coste por sesión (9), historial de sesiones (10).

### Fase 5 — Varias réplicas en Docker
Hecha (ADR-0012: solo Docker; Kubernetes pasa al backlog), salvo la comprobación con las
imágenes construidas (compose con el profile `replicas`); está probada con procesos locales.
- `edge` compartido por varias réplicas (`EDGE_REPLICAS`): identifica la réplica de cada conexión
  de salida por su IP de origen, le manda a ella la pregunta y el evento `network`, y deniega lo
  que no venga de una réplica (`unknown_client`).
- Entrada: `GET /replicas` y `/replicas/<nombre>/…`; sin prefijo, la réplica por defecto.
- Compose con una red interna por réplica (`agent-1`; `agent-2` y `agent-3` con el profile
  `replicas`).
- CLI: `--replica`/`CNA_REPLICA` y `cna replicas`.
- Pendiente para más adelante: selector de réplica en la web UI (pasa a la fase 6).

### Fase 6 — Réplicas en los clientes
ADR-0013. Sin cambios en `edge` ni en el gateway.
- `@cna/shared`: `isReplicaFree`, `freeReplicaNames` y `createSessionOnFreeReplica` (la asignación
  de una réplica libre la hace el cliente: `GET /replicas` y `POST /replicas/<nombre>/session`,
  pasando a la siguiente si hay `409 session_exists`; sin ninguna libre, `no_free_replica`).
- CLI: `cna run --any-replica` crea la sesión en la primera réplica libre.
- Web UI: réplica en el fragmento de la URL (`#replica=<nombre>`), selector de réplica en la
  cabecera, pestaña "Réplicas" con todas las sesiones y "Nueva sesión en una réplica libre".

## Backlog
- Kubernetes (k3s/kind): manifiestos con PVC por réplica, Secret y Service, y `edge` aparte con
  una NetworkPolicy que solo deje salir al agente hacia `edge` (ADR-0012).
- Procesos en segundo plano con `bash_bg` (8).
- Comandos y skills en UI/CLI (11).
- Imágenes en el prompt (12).
- Servidores MCP.
- Inyección de credenciales en `edge` (GitHub y API keys fuera del contenedor del agente).

## Fuera de alcance (por ahora)
- Docker-in-Docker / servicios de apoyo (bases de datos para tests de integración, Testcontainers).
- Multiusuario, GitLab/Gitea.
- Exposición a internet (solo LAN o Tailscale).
- Subagentes y permisos por tool (ver [descartado conscientemente](#funcionalidades-tipo-claude-code)).
