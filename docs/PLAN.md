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
| Despliegue | Local: Docker en Raspberry Pi 4 (8 GB, arm64), MacBook (Docker Desktop), y k8s local (k3s/kind) |
| Lenguaje | TypeScript |
| Uso | Personal, mono-usuario |
| Concurrencia | **1 sesión por réplica**; más sesiones = más réplicas |
| Servicios | El agente ejecuta tests, pero **no** levanta servicios (sin Docker-in-Docker) |
| Push / PR | Se **aprueban** fuera del contenedor del agente (en `edge`), salvo `autoPush: true` |
| Alcance funcional | Un "Claude Code lite": ver [Funcionalidades tipo Claude Code](#funcionalidades-tipo-claude-code) |
| Red saliente | Todo el tráfico sale por un proxy propio. Modo por defecto **`ask`**: dominios fuera de la allowlist se preguntan al usuario |
| Secretos | **Ninguno** dentro del contenedor del agente: `edge` los guarda y los inyecta (ADR-0006) |

## Arquitectura

```
 Web UI / CLI / curl                                        internet
        │  REST + SSE (Bearer token)                            ▲
        ▼                                                       │
┌──────────────────────────── edge (TS) — de confianza ─────────┴────┐
│ :8080 API pública: valida el Bearer, sirve la web UI,              │
│        aprobaciones y red (propias), y reenvía /session/* al       │
│        gateway                                                     │
│ :3128 proxy de salida (CONNECT + HTTP) con política y registro     │
│ :8081 upstreams internos con credenciales inyectadas:              │
│        /git (GitHub smart HTTP) /github (PR) /llm/<prov> /search   │
│ Secretos: AGENT_API_TOKEN, GITHUB_TOKEN, API keys. Volumen propio. │
└──────────────┬─────────────────────────────────▲───────────────────┘
  red interna  │ /session/*                      │ proxy, git, LLM,
  (sin salida) ▼                                 │ búsqueda, avisos
┌───────────────────── agent (contenedor) — NO fiable ───────────────┐
│ gateway (TS, Node) :8090, sin autenticación, no publicado          │
│  · API de sesión + SSE · SessionManager (máx. 1 sesión)            │
│  · checkpoints, diff y registro de tools                           │
│  · RpcBridge ── spawn ──► pi --mode rpc (subproceso)               │
│                              │ JSONL stdin/stdout                  │
│                              ▼                                     │
│                    Pi + extensiones propias:                       │
│                     ask_user, git, todo, plan-mode, guard, web     │
│ Toolchains (mise): Java+Maven/Gradle, Node+pnpm, Python+uv, Go     │
│ /data/workspace  /data/sessions  /data/cache  (volumen)            │
│ Sin secretos en el entorno ni en disco.                            │
└────────────────────────────────────────────────────────────────────┘
```

### Decisiones clave
- **Pi como dependencia, no fork** (ADR-0001, ADR-0005). Paquete
  `@earendil-works/pi-coding-agent`, versión exacta `1.5.2`. Se amplía con extensiones.
- **Pi en modo RPC como subproceso** del gateway (ADR-0002). Aísla fallos del agente y el
  protocolo RPC ya traduce los diálogos de extensiones a `extension_ui_request`.
- **Una sesión por réplica** (ADR-0003). Escalar = más réplicas.
- **Imagen única multi-arch** (`linux/amd64`, `linux/arm64`) con toolchains vía `mise`.
  Si el repo trae `.tool-versions`/`mise.toml`, se respetan.
- **Proxy de salida propio** (ADR-0004). El agente está en una red interna sin salida.
- **`edge` es la única pieza de confianza** (ADR-0006). Todo lo que corre en el contenedor
  `agent` comparte usuario con un agente que puede estar bajo inyección de prompt, así que
  ni guarda secretos ni decide nada relevante para la seguridad:
  - `edge` valida el Bearer; el contenedor `agent` no conoce `AGENT_API_TOKEN`.
  - `edge` guarda `GITHUB_TOKEN` y las API keys y los inyecta en *upstreams* internos
    (`/git`, `/github`, `/llm/<proveedor>`, `/search`). No hace falta interceptar TLS.
  - Las aprobaciones de **red** y de **push/PR** se crean, se responden y se aplican en
    `edge`. Las preguntas que resuelve Pi (`ask_user`, plan) son ayudas de uso, no
    barreras: un agente hostil podría contestárselas a sí mismo.
- **El gateway observa; las extensiones solo aportan tools** (ADR-0007). Checkpoints, diff
  y registro de tools los hace el gateway a partir de los eventos RPC. Cuando una
  extensión necesita avisar al gateway usa `pi.appendEntry()`, que llega por RPC como
  evento `entry_appended`.

## API REST (borrador v1)

Todo se sirve en `edge:8080`. Exige `Authorization: Bearer <AGENT_API_TOKEN>` salvo
`GET /health` y los ficheros estáticos de la web UI.

**Sesión** (edge reenvía al gateway):
```
GET    /health
GET    /models                          modelos/proveedores configurados
GET    /session                         sesión actual (o 404)
POST   /session                         {repo, baseBranch?, prompt, model?, thinking?,
                                         mode?: "plan"|"auto", autoPush?}
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
POST   /session/checkpoints/:id/restore {conversation?: boolean}
DELETE /session                         cierra y limpia el workspace. 409 si hay cambios
                                        sin subir, salvo ?force=true
```

**Aprobaciones y red** (los atiende `edge`, nunca llegan al gateway):
```
GET    /approvals                       aprobaciones pendientes
POST   /approvals/:id                   {decision: "once"|"always"|"deny"}
GET    /edge/events                     SSE: approval, approval_resolved, network
GET    /network/log                     conexiones (host, puerto, decisión, bytes)
GET    /network/policy                  modo + allowlist/denylist efectivas
PUT    /network/policy                  cambiar modo o listas
```

`edge` lee el cuerpo de `POST /session` y `DELETE /session` al reenviarlos y guarda la
política de la sesión (`repo`, `baseBranch`, `autoPush`). Así la política viene siempre
del cliente autenticado y no de lo que diga el contenedor `agent`.

Como hay una sesión por réplica, la API usa `/session` en singular. Un hub futuro
expondría `/sessions/:id` y redirigiría a la réplica correspondiente.

**Estados:** `idle → cloning → running ⇄ waiting_input → ready → closed` (+ `error`).
- `running → ready` ocurre con el evento `agent_settled` de Pi, no con `agent_end` (tras
  `agent_end` Pi aún puede reintentar, compactar o seguir con mensajes en cola).
- `waiting_input` mientras haya **al menos una** pregunta pendiente; puede haber varias a
  la vez porque Pi ejecuta tools en paralelo.
- Fallo al clonar o muerte del proceso Pi → `error`, con el motivo en el evento `status`.
- Hasta la fase 4, un reinicio del contenedor pierde la sesión: el gateway arranca en
  `idle` y conserva el workspace anterior hasta que se crea una sesión nueva.

**Eventos SSE de `/session/events`** (normalizados desde los eventos RPC de Pi):
`status`, `message_delta`, `thinking_delta`, `message`, `tool_start`, `tool_update`,
`tool_end`, `question`, `question_resolved`, `todo`, `checkpoint`, `compaction`, `retry`,
`notify`, `error`.
- Pi solo envía deltas en `message_update`; el mensaje definitivo es el de `message_end`.
- `question.kind`: `ask_user`, `confirm` o `plan` (opciones: *aprobar*, *pedir cambios*).
  `extension_ui_request` no lleva metadatos, así que las extensiones marcan el tipo con un
  prefijo en el título (`cna:<kind>:`), definido en `@cna/shared`; el gateway lo quita.

**Eventos SSE de `/edge/events`:** `approval` (`kind`: `network`, `push` o `pr`),
`approval_resolved`, `network` (una conexión registrada).

La web UI no puede usar `EventSource` (no permite cabeceras): lee SSE con `fetch`.

## Extensiones de Pi

Pi se arranca con `--no-approve --no-extensions --no-mcp` y nuestras extensiones con
`-e`: así no se carga nada ejecutable del repo clonado (`.pi/extensions`,
`.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`). El `AGENTS.md`/`CLAUDE.md` del
repo sí se carga, como texto no fiable.

| Extensión | Qué hace |
|---|---|
| `ask_user` | Tool `ask_user({question, options?, multiline?})`. Usa `ctx.ui.select` / `ctx.ui.input` / `ctx.ui.editor`; el gateway lo publica como `question{kind:"ask_user"}`. |
| `git` | Tools `git_status`, `git_commit`, `git_push`, `create_pr`. El remoto es `http://edge:8081/git/<owner>/<repo>.git`; `create_pr` llama a `edge:8081/github`. La aprobación la pide `edge`: la tool solo espera el resultado. Ramas siempre `agent/<slug>`. |
| `todo` | Tool `todo` (crear/actualizar/completar). El estado va en `details` del resultado; el gateway lo lee de `tool_execution_end` y emite `todo`. Basada en `examples/extensions/todo.ts`. |
| `plan-mode` | Con `mode: "plan"` (flag `--plan`) solo activa tools de lectura y añade `submit_plan`. El plan se presenta como `question{kind:"plan"}`; al aprobarlo se activan el resto de tools. Avisa del cambio de modo con `pi.appendEntry("cna.mode", …)`. Basada en `examples/extensions/plan-mode`. |
| `guard` | Hook `tool_call` que bloquea comandos peligrosos evidentes (`rm -rf /`, `docker run`, `git push --force`…). Es una ayuda contra despistes del modelo, **no** una barrera de seguridad. |
| `web` | Tools `web_search` (llama a `edge:8081/search`, que consulta SearXNG o Brave/Tavily) y `web_fetch` (descarga por el proxy y convierte a texto). El resultado se marca como contenido externo no fiable. |

No hay extensión `audit` ni `checkpoint`: lo hace el gateway (ADR-0007).

Además se añade un prompt de sistema (`--append-system-prompt <fichero>`) que explica el
entorno: toolchains disponibles, que no hay Docker ni servicios externos, que la red
pregunta por dominios nuevos y la política de ramas y PR.

## Proveedores y modelos

Fichero `config/providers.yaml`, **sin secretos**, montado en solo lectura en `edge` y
`agent`. Las API keys son variables de entorno de `edge` únicamente.

```yaml
default: ollama/qwen3-coder:30b               # o <proveedor>/<modelo> de los built-in de Pi
providers:
  anthropic: {}                               # built-in; la key vive en edge
  ollama:
    baseUrl: http://192.168.1.50:11434/v1     # Ollama en otra máquina
    api: openai-completions
    models:
      - id: qwen3-coder:30b
        contextWindow: 65536                  # debe coincidir con el num_ctx de Ollama
```

- El gateway genera `models.json` con cada proveedor apuntando a
  `http://edge:8081/llm/<proveedor>` y `apiKey: "edge"` (Pi exige el campo aunque no se
  use). Para los built-in basta con sobrescribir `baseUrl`.
- `edge` reenvía a la URL real añadiendo la cabecera de autenticación del proveedor.
- Para Ollama y similares, `compat.supportsDeveloperRole: false` y
  `compat.supportsReasoningEffort: false` por defecto, configurables.

> En la Raspberry Pi 4 no es viable ejecutar un modelo útil con Ollama local:
> Ollama debería correr en el MacBook u otra máquina de la red, o usar API keys.

## Funcionalidades tipo Claude Code

| # | Funcionalidad | Fase | Cómo |
|---|---|---|---|
| 1 | **Lista de tareas visible** | 2 | Extensión `todo` + evento SSE `todo` + `GET /session/todos`. |
| 2 | **Modo plan** | 2 | Extensión `plan-mode`. Investiga en solo lectura, propone plan, espera aprobación y ejecuta. |
| 3 | **Diff de cambios en la UI** | 2 (API), 3 (UI) | `GET /session/diff` (frente a la rama base o a un checkpoint); vista en la web y `cna diff`. |
| 4 | **Checkpoints y deshacer** | 2 | El gateway crea un snapshot git al terminar cada ejecución con cambios. Restaura ficheros y, opcionalmente, la conversación (`fork` de Pi). |
| 5 | **Notificaciones push** | 2 | Las envía `edge` (ntfy o Telegram) cuando hay una aprobación pendiente o cuando el gateway le avisa de que la sesión espera respuesta, termina o falla. `config/notifications.yaml`. |
| 6 | **Instrucciones del proyecto** | 1 | Pi carga el `AGENTS.md`/`CLAUDE.md` del repo. Añadimos un `AGENTS.md` global en el directorio de configuración de Pi. |
| 7 | **Trabajar sobre un PR existente** | 4 | `POST /session` con `pr: <número>`: checkout de la rama del PR; el agente lee los comentarios de revisión por `edge:8081/github` y los atiende. |
| 8 | **Procesos en segundo plano** | Backlog | Tool `bash_bg` (`start`, `logs`, `stop`, `list`). Limitado a 1–2 procesos por la RAM de la Pi. |
| 9 | **Tokens y coste por sesión** | 4 | `get_session_stats` de Pi expuesto en `GET /session/stats`. |
| 10 | **Historial de sesiones** | 4 | Listar y retomar sesiones pasadas de la réplica. |
| 11 | **Comandos y skills** | Backlog | Exponer prompt templates y skills de Pi en la UI y el CLI, montados desde la configuración global. |
| 12 | **Imágenes en el prompt** | Backlog | Adjuntar capturas en la web UI y `--image` en el CLI. |

**Descartado conscientemente:**
- **MCP:** Pi 1.x ya lo soporta, pero cada servidor es un proceso más y más destinos de
  red que controlar. Se arranca con `--no-mcp`; queda en el backlog.
- **Subagentes:** demasiado caros en memoria para una Raspberry Pi 4.
- **Permisos por tool:** el contenedor, el proxy y las aprobaciones de `edge` cumplen ese
  papel. Las únicas confirmaciones son push/PR, el plan y la red.

## Frontera de confianza y secretos

Detalle en ADR-0006.

- **Qué es fiable:** `edge` y el cliente autenticado. **Qué no:** todo el contenedor
  `agent` (gateway incluido), el contenido del repo y lo que llegue de la web.
- **Upstream `/git`:** proxy inverso de GitHub smart HTTP para el repo de la sesión y
  ningún otro. Inyecta el token. En `git-receive-pack` lee los comandos de refs (van en
  claro al principio de la petición) y solo deja pasar actualizaciones de
  `refs/heads/agent/*`: nada de la rama base, tags ni borrados. Antes de reenviar un push
  pide una aprobación `push`, salvo `autoPush: true`.
- **Upstream `/github`:** crear el PR (cabeza `agent/*`, base = rama base de la sesión;
  aprobación `pr` salvo `autoPush`) y leer comentarios de un PR del repo de la sesión.
  No se instala `gh` en la imagen.
- **Upstreams `/llm/<proveedor>` y `/search`:** reenvío con la key inyectada.
- **Permisos del PAT fine-grained:** *Contents* (lectura y escritura), *Pull requests*
  (lectura y escritura), *Metadata* (lectura). Sin *Workflows*: GitHub rechazará los push
  que toquen `.github/workflows`. Recomendado además un ruleset que proteja la rama base.
- **Identidad de los commits:** `CNA_GIT_USER_NAME` / `CNA_GIT_USER_EMAIL`.
- **Colisión de rama:** si `agent/<slug>` ya existe en el remoto se añade un sufijo (`-2`, `-3`…).
- **Limitación aceptada:** un dominio permitido que acepte subidas (un registry, GitHub
  con un token ajeno, el propio proveedor LLM) sigue siendo un canal de exfiltración
  posible. Los registries privados con credenciales quedan fuera de alcance.

## Control de red saliente (egress)

Detalle en ADR-0004.

- **Topología (compose):** red `internal` (`internal: true`, sin salida) con `agent` y
  `edge`; red `external` solo con `edge`, que publica el `8080`.
- **Proxy:** `CONNECT` sin interceptar TLS (se ve host y puerto, no URL ni contenido) y
  proxy HTTP normal para peticiones `http://`. La política se aplica a **host y puerto**;
  por defecto solo 80 y 443.
- **Destinos internos:** se deniegan siempre, sin preguntar, los que resuelvan a
  loopback, rangos privados, link-local o al propio `edge`. La comprobación se hace
  sobre la IP ya resuelta, que es la que se usa para conectar. Ollama en la LAN no
  necesita excepción porque se llega por `/llm/ollama`.
- **Clientes:** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY=edge,localhost`; `NODE_USE_ENV_PROXY=1`
  para el `fetch` de Node; `settings.xml` de Maven y `gradle.properties` con el proxy.
  Lo que ignore el proxy no tiene ruta de salida: **falla cerrado**.
- **Modos:** `ask` (**por defecto**), `allowlist` y `audit`.
- **Allowlist:** entradas `host[:puerto]`, con comodín solo como prefijo (`*.dominio`).
  Base: descargas de GitHub (`github.com`, `codeload.github.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `raw.githubusercontent.com`), registries (`registry.npmjs.org`, `pypi.org`,
  `files.pythonhosted.org`, `repo.maven.apache.org`, `repo1.maven.org`,
  `plugins.gradle.org`, `proxy.golang.org`, `sum.golang.org`) y descargas de toolchains
  (`services.gradle.org`, `downloads.gradle.org`, `nodejs.org`, `go.dev`,
  `dl.google.com`, `api.adoptium.net`, `mise.jdx.dev`). La lista exacta se cierra en la
  fase 0 ejecutando cada stack en modo `audit`. Los proveedores LLM, el buscador y el
  servicio de notificaciones **no** están: se llega a ellos solo a través de `edge`.
- **Flujo `ask`:** `edge` retiene la conexión, crea una aprobación `network` (*permitir
  esta vez*, *permitir siempre*, *denegar*) y espera. Sin respuesta en el timeout
  (2 min por defecto) o sin sesión activa → **denegar**. Peticiones concurrentes al mismo
  host y puerto comparten la misma aprobación.
- **Persistencia:** *permitir siempre*, la política y el registro
  (`network.jsonl`: timestamp, host, puerto, decisión, bytes, duración) viven en el
  volumen de `edge`, fuera del alcance del agente.
- **Limitación aceptada:** la resolución DNS la hace Docker; la exfiltración por DNS es
  posible en teoría.

## Contenedor

- Base: `debian:bookworm-slim` + Node 22 LTS (≥ 22.21, por Pi y por `NODE_USE_ENV_PROXY`).
- Paquetes: git, curl, ripgrep, fd, jq, build-essential, unzip.
- `mise` con versiones LTS preinstaladas de Java (Temurin) + Maven + Gradle, Node + pnpm,
  Python + uv, Go.
- Usuario `agent` (uid 1000), sin privilegios, todas las capabilities retiradas.
- Volumen `/data`: `workspace/`, `sessions/` (JSONL de Pi), `cache/` (Maven, Gradle, npm,
  uv, Go), `config/` (configuración de Pi generada), `logs/tools.jsonl`.
- Pi: `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, `PI_CODING_AGENT_DIR`.
- **Sin secretos:** las únicas variables sensibles (`AGENT_API_TOKEN`, `GITHUB_TOKEN`, API
  keys, claves de búsqueda y notificaciones) se pasan solo a `edge`.
- `edge`: imagen ligera de Node, usuario no root, volumen propio `/edge-data` (política,
  registro de red, política de la sesión en curso). Incluye la web UI estática.
- Tamaño estimado del agente: 2–3 GB. Build multi-arch con `docker buildx`.

### Consideraciones Raspberry Pi 4 (8 GB)
- Limitar la JVM de los tests (`MAVEN_OPTS`/`GRADLE_OPTS` con `-Xmx`), Gradle daemon desactivado.
- Usar SSD por USB para `/data` mejor que la microSD.
- Builds de la imagen en el MacBook o en CI y `docker pull` en la Pi. En CI, usar un
  runner arm64 nativo en vez de QEMU.

## Estructura del repositorio

```
packages/
  gateway/        API de sesión + SSE, SessionManager, RpcBridge, checkpoints, config
  extensions/     extensiones de Pi (ask_user, git, todo, plan-mode, guard, web) + prompt de sistema
  cli/            cliente de terminal
  web/            web UI sencilla (estática, servida por edge)
  edge/           API pública y autenticación, aprobaciones, proxy de salida, upstreams
  shared/         tipos del protocolo API/eventos compartidos
docker/
  Dockerfile        imagen del agente (gateway + Pi + toolchains)
  Dockerfile.edge   imagen de edge (incluye la web UI)
deploy/
  compose/        docker-compose.yml (1..N réplicas; SearXNG opcional con un profile)
  k8s/            manifiestos / kustomize para k3s/kind
config/
  providers.example.yaml, network.example.yaml, notifications.example.yaml
docs/
  PLAN.md, adr/
```

Monorepo con npm workspaces, Node 22 LTS, TypeScript estricto, Hono (HTTP), zod (validación de la API), typebox (tools de Pi), `vitest` para tests, `biome` para lint/format. Convenciones detalladas en `AGENTS.md`.

## Fases

### Fase 0 — Esqueleto y contenedores
- Monorepo, tooling (tsconfig, biome, vitest), CI de GitHub Actions (lint + test + build de imágenes).
- Dockerfile multi-arch con toolchains y Pi instalado. `docker compose up` arranca gateway y `edge`.
- `edge` mínimo: API pública con Bearer y `/health`, reenvío al gateway, proxy
  `CONNECT` + HTTP con registro y bloqueo de destinos internos, y la topología de redes.
- Verificar que npm, pip/uv, Maven, Gradle, Go y mise funcionan a través del proxy, y
  cerrar la allowlist base con el modo `audit`.
- Test de la composición: el contenedor `agent` no recibe ninguna variable secreta.

### Fase 1 — MVP conversacional (API)
- RpcBridge: spawn de `pi --mode rpc`, parser JSONL conforme, correlación por `id`,
  diálogos de extensión. Reutiliza los tipos RPC que exporta Pi.
- `edge`: upstreams `/llm/<proveedor>` y `/git` (clone y push con filtro de refs),
  política de sesión leída de `POST /session`, aprobaciones (`/approvals`, `/edge/events`)
  y modo `ask` con persistencia de *permitir siempre* y denegación por timeout.
- SessionManager: clonar por `edge`, crear rama `agent/<slug>`, arrancar Pi en el workspace.
- Endpoints `/session*` + SSE con replay; `GET /session/messages`; `PUT /session/model`.
- Extensión `ask_user`; preguntas concurrentes y cancelación al abortar.
- Configuración de proveedores (`providers.yaml` → `models.json`).
- Extensión `git` con `git_status`, `git_commit` y `git_push`: el MVP ya entrega una rama.
- Prompt de sistema del entorno y `AGENTS.md` global (6).
- Tests: unitarios del parser/bridge con un Pi falso; e2e con un modelo mock; política
  de red y filtro de refs de `edge`.

### Fase 2 — PR y funcionalidades
- `create_pr` y upstream `/github`.
- Extensiones `todo` (1), `plan-mode` (2), `guard` y `web` (con upstream `/search`).
- Endpoints `/network/*`.
- Registro de tools, `GET /session/diff` (3) y checkpoints con restauración (4).
- Notificaciones push desde `edge` (5).

### Fase 3 — CLI y web UI
- CLI: `cna run <repo> "<prompt>" [--plan]`, chat interactivo, responder preguntas y
  aprobaciones, `cna status/diff/todos/abort/close`.
- Web UI (servida por `edge`): formulario de nueva sesión, chat con streaming, tarjetas
  de tool calls, diálogos de preguntas y de aprobaciones, checklist de tareas, vista de
  diff con checkpoints, panel de conexiones de red, botón de abortar.

### Fase 4 — Persistencia y robustez
- Reanudar sesión tras reinicio del contenedor (JSONL de Pi + estado en disco).
- Timeouts de inactividad, límites de recursos, limpieza de workspace.
- Trabajar sobre un PR existente (7), tokens y coste por sesión (9), historial de sesiones (10).

### Fase 5 — Kubernetes y múltiples réplicas
- Manifiestos para k3s/kind (StatefulSet con PVC por réplica, Secret solo para `edge`, Service).
- `edge` como Deployment aparte + NetworkPolicy que solo permite salida del agente hacia
  `edge` (como sidecar no sirve: compartiría la red del pod y se podría esquivar).
- Hub opcional: registro de réplicas, asignación de sesiones a réplicas libres, UI con todas las sesiones.

## Backlog
- Procesos en segundo plano con `bash_bg` (8).
- Comandos y skills en UI/CLI (11).
- Imágenes en el prompt (12).
- Servidores MCP.

## Fuera de alcance (por ahora)
- Docker-in-Docker / servicios de apoyo (bases de datos para tests de integración, Testcontainers).
- Multiusuario, GitLab/Gitea, registries privados con credenciales.
- Exposición a internet (solo LAN o Tailscale).
- Subagentes y permisos por tool (ver [descartado conscientemente](#funcionalidades-tipo-claude-code)).
