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

## Arquitectura

```
 Web UI / CLI / curl
        │  REST + SSE  (Bearer token)
        ▼
┌───────────────────── réplica (1 contenedor) ─────────────────────┐
│ gateway (TS, Node)                                               │
│  · API REST + SSE · sirve la web UI estática                     │
│  · SessionManager (máx. 1 sesión activa)                         │
│  · RpcBridge ── spawn ──► pi --mode rpc  (subproceso)            │
│                               │ JSONL stdin/stdout               │
│                               ▼                                  │
│                    Pi + extensiones propias:                     │
│                     · ask_user   → extension_ui_request          │
│                     · git_*/create_pr (vía gh)                   │
│                     · política de push/PR                        │
│ Toolchains (mise): Java+Maven/Gradle, Node+pnpm, Python+uv, Go   │
│ /data/workspace   /data/sessions   /data/cache  (volumen)        │
└──────────────────────────────────────────────────────────────────┘
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

## API REST (borrador v1)

```
GET    /health
GET    /models                          modelos/proveedores configurados
GET    /session                         sesión actual (o 404)
POST   /session                         {repo, baseBranch?, prompt, model?, thinking?}
                                        409 si la réplica ya está ocupada
GET    /session/events                  SSE: estado, deltas de texto, tool calls,
                                        preguntas, errores (con Last-Event-ID)
POST   /session/messages                {text, mode?: "steer"|"followUp"}
POST   /session/answers/:questionId     {value} | {confirmed} | {cancelled:true}
POST   /session/abort                   aborta el turno en curso
DELETE /session                         cierra la sesión y limpia el workspace
```

Como hay una sesión por réplica, la API usa `/session` en singular. Un hub futuro
expondría `/sessions/:id` y redirigiría a la réplica correspondiente.

**Estados:** `idle → cloning → running ⇄ waiting_input → ready → closed` (+ `error`).

**Eventos SSE** (normalizados desde los eventos RPC de Pi):
`status`, `message_delta`, `message`, `tool_start`, `tool_update`, `tool_end`,
`question`, `question_resolved`, `notify`, `error`.

## Extensiones de Pi

| Extensión | Qué hace |
|---|---|
| `ask_user` | Tool `ask_user({question, options?, multiline?})`. Usa `ctx.ui.select` / `ctx.ui.input` / `ctx.ui.editor`; en RPC se convierte en `extension_ui_request` que el gateway publica como evento `question`. |
| `git` | Tools `git_status`, `git_commit`, `git_push`, `create_pr`. `git_push` y `create_pr` piden confirmación con `ctx.ui.confirm` salvo que la sesión se haya creado con `autoPush: true` / el prompt lo autorice. Ramas siempre `agent/<slug>`; nunca push a la rama base. |
| `guard` | Hook `tool_call` que bloquea comandos peligrosos (`git push --force` a la rama base, `rm -rf /`, intentos de `docker run`…). |

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

## Contenedor

- Base: `debian:bookworm-slim` + Node LTS (para gateway y Pi).
- Paquetes: git, gh, curl, ripgrep, fd, jq, build-essential, unzip.
- `mise` con versiones LTS preinstaladas de Java (Temurin) + Maven + Gradle, Node + pnpm,
  Python + uv, Go.
- Usuario `agent` (uid 1000), sin privilegios.
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
  shared/         tipos del protocolo API/eventos compartidos
docker/
  Dockerfile
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

### Fase 1 — MVP conversacional (API)
- RpcBridge: spawn de `pi --mode rpc`, parser JSONL conforme (split solo en `\n`), correlación de respuestas.
- SessionManager: clonar repo (con `GITHUB_TOKEN`), crear rama `agent/<slug>`, arrancar Pi en el workspace.
- Endpoints `/session*` + SSE con replay (buffer de eventos y `Last-Event-ID`).
- Extensión `ask_user` y respuesta vía `/session/answers/:id`.
- Configuración de proveedores (`providers.yaml` → `models.json`).
- Tests: unitarios del parser/bridge con un Pi falso; e2e con un modelo mock.

### Fase 2 — Git y flujo de PR
- Extensión `git` (commit, push, PR con `gh`) con la política de confirmación.
- Extensión `guard`.
- Prompt de sistema del entorno.

### Fase 3 — CLI y web UI
- CLI: `cna run <repo> "<prompt>"`, chat interactivo en terminal, responder preguntas, `cna status/abort/close`.
- Web UI: formulario de nueva sesión, chat con streaming, tarjetas de tool calls, diálogo de preguntas, botón de abortar.

### Fase 4 — Persistencia y robustez
- Reanudar sesión tras reinicio del contenedor (JSONL de Pi + estado en disco).
- Timeouts de inactividad, límites de recursos, limpieza de workspace.

### Fase 5 — Kubernetes y múltiples réplicas
- Manifiestos para k3s/kind (StatefulSet con PVC por réplica, Secret, Service).
- Hub opcional: registro de réplicas, asignación de sesiones a réplicas libres, UI con todas las sesiones.

## Fuera de alcance (por ahora)
- Docker-in-Docker / servicios de apoyo (bases de datos para tests de integración, Testcontainers).
- Multiusuario, GitLab/Gitea.
- Exposición a internet (solo LAN o Tailscale).
