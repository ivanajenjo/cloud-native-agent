# Plan de desarrollo — cloud-native-agent

Agente de programación auto-hospedado, basado en [Pi](https://github.com/badlogic/pi-mono)
(`@mariozechner/pi-coding-agent`), empaquetado en un contenedor que incluye todo lo
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
| Push / PR | El agente **pregunta** antes de hacer push/PR, salvo que el prompt lo autorice |
| Alcance funcional | Un "Claude Code lite": ver [Funcionalidades tipo Claude Code](#funcionalidades-tipo-claude-code) |
| Red saliente | Todo el tráfico sale por un proxy propio. Modo por defecto **`ask`**: dominios fuera de la allowlist se preguntan al usuario |

## Arquitectura

```
 Web UI / CLI / curl                                   internet
        │  REST + SSE (Bearer token)                       ▲
        ▼                                                  │ allowlist / ask
┌─────────────────────────── edge (TS) ────────────────────┴─────┐
│ · reverse proxy de entrada :8080 → gateway                     │
│ · proxy de salida (HTTP CONNECT) :3128 · registro + política   │
│ · única pieza con acceso a la red externa                      │
└──────────────┬──────────────────────────────────▲──────────────┘
  red interna  │ (sin salida a internet)          │ HTTPS_PROXY y
               ▼                                  │ consultas "ask"
┌───────────────────────── agent (contenedor) ────┴──────────────┐
│ gateway (TS, Node)                                             │
│  · API REST + SSE · sirve la web UI estática                   │
│  · SessionManager (máx. 1 sesión activa)                       │
│  · RpcBridge ── spawn ──► pi --mode rpc (subproceso)           │
│                              │ JSONL stdin/stdout              │
│                              ▼                                 │
│                    Pi + extensiones propias:                   │
│                     · ask_user → extension_ui_request          │
│                     · git_*/create_pr (vía gh), política PR    │
│                     · guard, audit, web_search/web_fetch       │
│ Toolchains (mise): Java+Maven/Gradle, Node+pnpm, Python+uv, Go │
│ /data/workspace  /data/sessions  /data/cache  (volumen)        │
└────────────────────────────────────────────────────────────────┘
```

### Decisiones clave
- **Pi como dependencia, no fork** (ADR-0001). Se amplía con extensiones.
- **Pi en modo RPC como subproceso** del gateway (ADR-0002). Aísla fallos del agente
  (se puede matar/reiniciar sin tumbar la API) y el protocolo RPC ya traduce los diálogos
  de extensiones (`ctx.ui.select/input/confirm`) a mensajes `extension_ui_request`, que
  es exactamente lo que necesita `ask_user`.
- **Una sesión por réplica** (ADR-0003). El gateway y el agente viven en el mismo
  contenedor. Escalar = más réplicas (más servicios en compose / `replicas` en k8s).
  Un futuro "hub" opcional listaría réplicas y enviaría cada sesión a una libre.
- **Imagen única multi-arch** (`linux/amd64`, `linux/arm64`) con toolchains vía `mise`.
  Si el repo trae `.tool-versions`/`mise.toml`, se respetan.
- **GitHub con PAT fine-grained** limitado a los repos propios + `gh` CLI.
- **Control de red con proxy de salida propio** (ADR-0004). El contenedor del agente está
  en una red interna sin salida; todo pasa por el contenedor `edge`, que registra cada
  conexión y aplica la política. Modo por defecto `ask`.

## API REST (borrador v1)

```
GET    /health
GET    /models                          modelos/proveedores configurados
GET    /session                         sesión actual (o 404)
POST   /session                         {repo, baseBranch?, prompt, model?, thinking?,
                                         mode?: "plan"|"auto", autoPush?}
                                        409 si la réplica ya está ocupada
GET    /session/events                  SSE: estado, deltas de texto, tool calls,
                                        preguntas, errores (con Last-Event-ID)
POST   /session/messages                {text, mode?: "steer"|"followUp"}
POST   /session/answers/:questionId     {value} | {confirmed} | {cancelled:true}
POST   /session/abort                   aborta el turno en curso
GET    /session/todos                   lista de tareas actual del agente
GET    /session/diff                    diff del workspace frente a la rama base (?checkpoint=id)
GET    /session/checkpoints             snapshots por turno
POST   /session/checkpoints/:id/restore vuelve los ficheros (y opcionalmente la conversación) a ese punto
DELETE /session                         cierra la sesión y limpia el workspace
```

Como hay una sesión por réplica, la API usa `/session` en singular. Un hub futuro
expondría `/sessions/:id` y redirigiría a la réplica correspondiente.

**Estados:** `idle → cloning → running ⇄ waiting_input → ready → closed` (+ `error`).

**Eventos SSE** (normalizados desde los eventos RPC de Pi y del proxy):
`status`, `message_delta`, `message`, `tool_start`, `tool_update`, `tool_end`,
`question`, `question_resolved`, `network`, `todo`, `checkpoint`, `notify`, `error`.

Los eventos `question` llevan un `kind`: `ask_user` (pregunta del agente), `confirm`
(push/PR), `plan` (aprobación del plan en modo plan; opciones: *aprobar*, *pedir cambios*)
o `network` (acceso a un dominio nuevo; opciones: *permitir esta vez*,
*permitir siempre*, *denegar*).

Endpoints de red:
```
GET    /network/log                     conexiones de la sesión (host, puerto, decisión, bytes)
GET    /network/policy                  modo + allowlist/denylist efectivas
PUT    /network/policy                  cambiar modo o listas
```

## Extensiones de Pi

| Extensión | Qué hace |
|---|---|
| `ask_user` | Tool `ask_user({question, options?, multiline?})`. Usa `ctx.ui.select` / `ctx.ui.input` / `ctx.ui.editor`; en RPC se convierte en `extension_ui_request` que el gateway publica como evento `question`. |
| `git` | Tools `git_status`, `git_commit`, `git_push`, `create_pr`. `git_push` y `create_pr` piden confirmación con `ctx.ui.confirm` salvo que la sesión se haya creado con `autoPush: true` / el prompt lo autorice. Ramas siempre `agent/<slug>`; nunca push a la rama base. |
| `guard` | Hook `tool_call` que bloquea comandos peligrosos (`git push --force` a la rama base, `rm -rf /`, intentos de `docker run`…). |
| `todo` | Tool `todo` (crear/actualizar/completar tareas). El estado se guarda en la sesión y se emite como evento `todo` para mostrar un checklist en vivo. Basada en `examples/extensions/todo.ts` de Pi. |
| `plan-mode` | Con `mode: "plan"` solo activa tools de lectura (`read`, `grep`, `find`, `ls`, bash de solo lectura) y añade la tool `submit_plan`. El plan se presenta como pregunta `plan`; al aprobarlo se activan el resto de tools y el agente ejecuta. Basada en `examples/extensions/plan-mode`. |
| `checkpoint` | Al final de cada turno con cambios crea un snapshot git en una ref interna (`refs/cna/checkpoints/<n>`) sin tocar la rama ni el índice. Permite diff por turno y restaurar. Basada en `examples/extensions/git-checkpoint.ts`. |
| `audit` | Hook `tool_call`/`tool_result` que registra todas las llamadas a tools y las publica por SSE. |
| `web` | Tools `web_search` (SearXNG autoalojado o API tipo Brave/Tavily) y `web_fetch` (descarga y convierte a texto). El resultado se marca como contenido externo no fiable. Su tráfico pasa por el proxy como el resto. |

Además se añade un prompt de sistema (`--append-system-prompt`) que explica el entorno:
toolchains disponibles, que no hay Docker ni servicios externos, y la política de PR.

## Proveedores y modelos

Fichero `config/providers.yaml` (montado como volumen/ConfigMap) que el gateway traduce
a `models.json` de Pi al arrancar. Las API keys llegan por variables de entorno
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), que Pi ya reconoce.

```yaml
default: ollama/qwen3-coder:30b               # o <proveedor>/<modelo> de los built-in de Pi
providers:
  ollama:
    baseUrl: http://192.168.1.50:11434/v1   # Ollama en otra máquina
    api: openai-completions
    models: [qwen3-coder:30b]
```

> En la Raspberry Pi 4 no es viable ejecutar un modelo útil con Ollama local:
> Ollama debería correr en el MacBook u otra máquina de la red, o usar API keys.

## Funcionalidades tipo Claude Code

Pi deja fuera a propósito varias piezas de la experiencia de Claude Code (plan mode,
to-dos, subagentes, MCP, procesos en background). Estas son las que añadimos, cuándo, y
las que descartamos conscientemente.

| # | Funcionalidad | Fase | Cómo |
|---|---|---|---|
| 1 | **Lista de tareas visible** | 1 | Extensión `todo` + evento SSE `todo` + `GET /session/todos`. Checklist en vivo en la UI. |
| 2 | **Modo plan** | 1 | Extensión `plan-mode`. `mode: "plan"` al crear la sesión: investiga en solo lectura, propone plan, espera aprobación (`question{kind:"plan"}`), luego ejecuta. |
| 3 | **Diff de cambios en la UI** | 2 (API), 3 (UI) | `GET /session/diff` (frente a la rama base o a un checkpoint); vista de diff en la web y `cna diff` en el CLI. |
| 4 | **Checkpoints y deshacer** | 2 | Extensión `checkpoint`: snapshot git por turno en refs internas. `POST /session/checkpoints/:id/restore` restaura ficheros; opcionalmente también la conversación con el árbol de sesión de Pi (`fork`). |
| 5 | **Notificaciones push** | 2 | El gateway avisa cuando la sesión pasa a `waiting_input`, termina o falla. Proveedor configurable: **ntfy** (autoalojable) o Telegram. Configuración en `config/notifications.yaml`; el host entra en la allowlist automáticamente. |
| 6 | **Instrucciones del proyecto** | 1 | Pi ya carga `AGENTS.md`/`CLAUDE.md` del repo. Añadimos un `AGENTS.md` global en `/data/config/AGENTS.md` (preferencias personales: estilo de commits, idioma…), montado como directorio de configuración de Pi. |
| 7 | **Trabajar sobre un PR existente** | 4 | `POST /session` con `pr: <número>`: checkout de la rama del PR, el agente lee los comentarios de revisión con `gh` y los atiende; push a la misma rama. |
| 8 | **Procesos en segundo plano** | Backlog | Tool `bash_bg` (`start`, `logs`, `stop`, `list`) para levantar un servidor de desarrollo y probarlo con `curl`. Limitado a 1–2 procesos por la RAM de la Pi. |
| 9 | **Tokens y coste por sesión** | 4 | `get_session_stats` de Pi expuesto en `GET /session/stats` y en la UI/CLI. |
| 10 | **Historial de sesiones** | 4 | Listar y retomar sesiones pasadas de la réplica (JSONL de Pi + metadatos), no solo la activa. |
| 11 | **Comandos y skills** | Backlog | Pi ya soporta prompt templates y skills; exponerlos en la UI y el CLI (`/review`, `/test`…) y montar los propios desde `/data/config`. |
| 12 | **Imágenes en el prompt** | Backlog | Pi ya acepta imágenes; permitir pegar/adjuntar capturas en la web UI y `--image` en el CLI. |

**Descartado conscientemente:**
- **MCP:** Pi no lo soporta por diseño (prefiere CLIs + skills). Si un día hace falta, se
  añade como extensión.
- **Subagentes:** demasiado caros en memoria para una Raspberry Pi 4 con 1 sesión por réplica.
- **Permisos por tool** (preguntar antes de cada edición o comando): el sandbox del
  contenedor y el proxy de salida cumplen ese papel; preguntar a cada paso haría el uso
  remoto insoportable. Las únicas confirmaciones son push/PR, el plan y la red.

## Control de red saliente (egress)

Detalle en ADR-0004.

- **Topología (compose):** red `internal` (`internal: true`, sin salida) con `agent` y
  `edge`; red `external` solo con `edge`. El puerto de la API se publica en `edge`, que
  hace de reverse proxy hacia el gateway (Docker no publica puertos de redes internas).
- **Proxy:** HTTP `CONNECT` sin interceptar TLS: se ve dominio y puerto, no URL ni contenido.
  En el agente: `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, y para Java `JAVA_TOOL_OPTIONS`
  con `-Dhttps.proxyHost`… + configuración de Maven/Gradle en la imagen. Lo que ignore el
  proxy no tiene ruta de salida: **falla cerrado**.
- **Modos:**
  - `ask` (**por defecto**): allowlist base + preguntar por cualquier dominio nuevo.
  - `allowlist`: solo allowlist; el resto se deniega sin preguntar.
  - `audit`: permite todo y lo registra (útil para descubrir qué necesita un stack).
- **Allowlist base:** GitHub (`github.com`, `api.github.com`, `codeload.github.com`,
  `objects.githubusercontent.com`…), registries (npm, PyPI, Maven Central, Gradle plugins,
  `proxy.golang.org`, `sum.golang.org`), los hosts de los proveedores de
  `providers.yaml` (incluida la IP/host de Ollama) y el buscador configurado para `web_search`.
- **Flujo `ask`:** el proxy retiene el `CONNECT`, pregunta al gateway por un endpoint interno
  (autenticado con un secreto compartido), el gateway emite `question{kind:"network"}`
  y espera la respuesta. *Permitir siempre* se persiste en `/data/policy/network.yaml`.
  Sin respuesta en el timeout (configurable, 2 min por defecto) o sin sesión activa → **denegar**.
  Para evitar avalanchas, peticiones concurrentes al mismo dominio comparten la misma pregunta.
- **Registro:** cada conexión (timestamp, host, puerto, decisión, bytes, duración) va a
  `/data/logs/network.jsonl` y se emite como evento SSE `network`.
- **Limitación aceptada:** la resolución DNS la hace Docker, así que la exfiltración vía
  DNS es posible en teoría.
- **Futuro:** inyección de credenciales en el proxy (`GITHUB_TOKEN`, API keys) para que el
  contenedor del agente no las vea nunca (requiere terminar TLS para esos dominios).

## Contenedor

- Base: `debian:bookworm-slim` + Node LTS (para gateway y Pi).
- Paquetes: git, gh, curl, ripgrep, fd, jq, build-essential, unzip.
- `mise` con versiones LTS preinstaladas de Java (Temurin) + Maven + Gradle, Node + pnpm,
  Python + uv, Go.
- Usuario `agent` (uid 1000), sin privilegios.
- Variables de proxy apuntando a `edge:3128`; `NO_PROXY` solo para `edge`/`localhost`.
- Volumen `/data`: `workspace/` (repo clonado), `sessions/` (JSONL de Pi para reanudar),
  `cache/` (Maven, Gradle, npm, pip/uv, Go): sobrevive a reinicios.
- Tamaño estimado: 2–3 GB. Build multi-arch con `docker buildx`.
- Variables: `AGENT_API_TOKEN`, `GITHUB_TOKEN`, claves de proveedores,
  `PI_OFFLINE=1`/`PI_TELEMETRY=0`.

### Consideraciones Raspberry Pi 4 (8 GB)
- Limitar la JVM de los tests (`MAVEN_OPTS`/`GRADLE_OPTS` con `-Xmx`), Gradle daemon desactivado.
- Usar SSD por USB para `/data` mejor que la microSD.
- Builds de la imagen en el MacBook o en CI (buildx) y `docker pull` en la Pi.

## Estructura del repositorio

```
packages/
  gateway/        API REST + SSE, SessionManager, RpcBridge, config
  extensions/     extensiones de Pi (ask_user, git, guard) + prompt de sistema
  cli/            cliente de terminal (crear sesión, chatear, responder preguntas)
  web/            web UI sencilla (estática, servida por el gateway)
  edge/           reverse proxy de entrada + proxy de salida con política
  shared/         tipos del protocolo API/eventos compartidos
docker/
  Dockerfile        imagen del agente (gateway + Pi + toolchains)
  Dockerfile.edge   imagen ligera del proxy
deploy/
  compose/        docker-compose.yml (1..N réplicas)
  k8s/            manifiestos / kustomize para k3s/kind
config/
  providers.example.yaml
docs/
  PLAN.md, adr/
```

Monorepo con npm workspaces, TypeScript estricto, `vitest` para tests, `biome` para lint/format.

## Fases

### Fase 0 — Esqueleto y contenedor
- Monorepo, tooling (tsconfig, biome, vitest), CI de GitHub Actions (lint + test + build imagen).
- Dockerfile multi-arch con toolchains y Pi instalado. `docker compose up` arranca un gateway con `/health`.
- `edge` mínimo: reverse proxy de entrada + proxy `CONNECT` con registro, y la topología
  de redes de compose (el agente sin salida directa). Verificar que npm, pip, Maven,
  Gradle, Go, git y gh funcionan a través del proxy.

### Fase 1 — MVP conversacional (API)
- RpcBridge: spawn de `pi --mode rpc`, parser JSONL conforme (split solo en `\n`), correlación de respuestas.
- SessionManager: clonar repo (con `GITHUB_TOKEN`), crear rama `agent/<slug>`, arrancar Pi en el workspace.
- Endpoints `/session*` + SSE con replay (buffer de eventos y `Last-Event-ID`).
- Extensión `ask_user` y respuesta vía `/session/answers/:id`.
- Configuración de proveedores (`providers.yaml` → `models.json`); sus hosts entran en la allowlist.
- Política de red con modo `ask` por defecto: endpoint interno edge → gateway, pregunta
  `network` por SSE, persistencia de *permitir siempre*, denegar por timeout.
- Extensiones `todo` y `plan-mode` (funcionalidades 1 y 2).
- `AGENTS.md` global en `/data/config` + documentar el uso del `AGENTS.md`/`CLAUDE.md` del repo (6).
- Tests: unitarios del parser/bridge con un Pi falso; e2e con un modelo mock.

### Fase 2 — Git y flujo de PR
- Extensión `git` (commit, push, PR con `gh`) con la política de confirmación.
- Extensiones `guard` y `audit`.
- Extensión `web` (`web_search`, `web_fetch`).
- Endpoints `/network/*`.
- Prompt de sistema del entorno.
- `GET /session/diff` (3) y extensión `checkpoint` con restauración (4).
- Notificaciones push con ntfy/Telegram (5).

### Fase 3 — CLI y web UI
- CLI: `cna run <repo> "<prompt>" [--plan]`, chat interactivo en terminal, responder preguntas,
  `cna status/diff/todos/abort/close`.
- Web UI: formulario de nueva sesión (modo plan/auto), chat con streaming, tarjetas de tool calls,
  diálogo de preguntas (incluidas plan y red), checklist de tareas, vista de diff con
  checkpoints, panel de conexiones de red, botón de abortar.

### Fase 4 — Persistencia y robustez
- Reanudar sesión tras reinicio del contenedor (JSONL de Pi + estado en disco).
- Timeouts de inactividad, límites de recursos, limpieza de workspace.
- Trabajar sobre un PR existente (7), tokens y coste por sesión (9), historial de sesiones (10).

### Fase 5 — Kubernetes y múltiples réplicas
- Manifiestos para k3s/kind (StatefulSet con PVC por réplica, Secret, Service).
- `edge` como Deployment aparte + NetworkPolicy que solo permite salida del agente hacia
  `edge` (como sidecar no sirve: compartiría la red del pod y se podría esquivar).
- Hub opcional: registro de réplicas, asignación de sesiones a réplicas libres, UI con todas las sesiones.

## Backlog
- Procesos en segundo plano con `bash_bg` (8).
- Comandos y skills en UI/CLI (11).
- Imágenes en el prompt (12).
- Inyección de credenciales en el proxy de salida.

## Fuera de alcance (por ahora)
- Docker-in-Docker / servicios de apoyo (bases de datos para tests de integración, Testcontainers).
- Multiusuario, GitLab/Gitea.
- Exposición a internet (solo LAN o Tailscale).
- MCP, subagentes y permisos por tool (ver [descartado conscientemente](#funcionalidades-tipo-claude-code)).
