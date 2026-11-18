# cloud-native-agent

Agente de programación auto-hospedado, tipo "Claude Code lite", basado en
[Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Corre en
Docker en una Raspberry Pi 4, un MacBook o un PC con Windows, clona repos de GitHub,
trabaja en ellos (Java, Node, Python, Go), ejecuta tests y sube los cambios a una rama.
Uso personal, mono-usuario.

> **Estado:** fase 4 (persistencia y robustez): sobre el MVP conversacional (fase 1), los PR y
> funcionalidades de la fase 2 y la web UI y el CLI de la fase 3, la sesión sobrevive a un
> reinicio del contenedor, Pi se para tras un rato sin uso, hay historial de sesiones con
> reanudación, tokens y coste por sesión, trabajo sobre un PR existente del agente y límites de
> recursos. Con la fase 5 hay varias réplicas en Docker detrás de un único `edge` (ADR-0012);
> Kubernetes queda en el backlog. Quedan pendientes las comprobaciones que necesitan Docker con
> red normal (tareas 1 y 2 de la fase 1.5).
> Ver [`docs/PLAN.md`](docs/PLAN.md#fases).

## Cómo funciona

```
 curl / web UI / CLI ──► edge :8080 ──► agent-1 (gateway :8090 + Pi + toolchains)   red internal-1
   Bearer token          │        └───► agent-2 …                                   red internal-2
                         │ :3128 proxy ◄── todo el tráfico saliente de cada agente
                         ▼
                      internet (política + registro)
```

Cada réplica (`agent-N`) atiende una sesión; todas comparten un único `edge` (ADR-0012):

- **`edge`**: la única pieza con acceso a internet.
  - Valida el token (`Authorization: Bearer`) y reenvía la API al gateway, quitando el
    token para que nunca llegue al agente.
  - Hace de proxy de salida del agente: registra cada conexión en
    `/edge-data/network.jsonl`, deniega los destinos internos (loopback, LAN, metadatos…)
    salvo los proveedores de `config/providers.yaml`, y en modo `ask` (por defecto) pregunta
    al usuario por los dominios que no están en la allowlist.
- **`agent-N`**: gateway (API REST) + Pi + toolchains (mise). Vive en su propia red interna
  sin salida, en la que solo está `edge`: lo que no pasa por el proxy de `edge` no llega a ningún
  sitio, y no alcanza a las demás réplicas. `edge` sabe qué réplica abre cada conexión por su IP
  de origen y le pregunta a ella.

Las decisiones de diseño están en [`docs/adr/`](docs/adr/) y la seguridad (qué protege y
qué no) en [`docs/adr/0006-frontera-de-confianza.md`](docs/adr/0006-frontera-de-confianza.md).

## Requisitos

| Para | Necesitas |
|---|---|
| Ejecutar con Docker | Docker con BuildKit y `compose` (Docker Desktop en Mac/Windows, Docker Engine ≥ 24 en Linux/Raspberry) |
| Desarrollar | Node.js **22 LTS (≥ 22.21)** y npm |
| Windows | Docker Desktop con backend **WSL2**; clona el repo dentro de WSL |

Las imágenes no construyen tras un proxy que intercepte el TLS, como el de Claude Code en
la nube: ver [la limitación](docs/despliegue-local.md#limitación-entornos-con-tls-interceptado-claude-code-en-la-nube).

## Puesta en marcha con Docker

Cada equipo construye su propia imagen (amd64 o arm64 según la máquina).

### Con un comando

```sh
git clone https://github.com/ivanajenjo/cloud-native-agent.git
cd cloud-native-agent
./scripts/up.sh
```

[`scripts/up.sh`](scripts/up.sh) hace todo lo del apartado siguiente:

1. Comprueba que Docker y `docker compose` están instalados y que Docker está arrancado.
2. Si no existe `deploy/compose/.env`, lo crea a partir de `.env.example` (con permisos `600`).
   Si `AGENT_API_TOKEN` está vacío, genera uno con `openssl rand -hex 32`. Nunca lo escribe
   en pantalla: queda en ese fichero. Si ya tienes un `.env`, no toca nada más.
3. Construye las imágenes y arranca `edge` y `agent-1`
   (`docker compose -f deploy/compose/docker-compose.yml up --build -d`).
4. Espera a que `edge` responda en `/health` (como mucho 120 s, o `CNA_UP_HEALTH_TIMEOUT_S`) y
   muestra la URL de la web UI.

Abre `http://127.0.0.1:8080/ui/` y pega el token, que está en `deploy/compose/.env`:

```sh
grep '^AGENT_API_TOKEN=' deploy/compose/.env
```

Opciones:

```sh
./scripts/up.sh --replicas   # también agent-2 y agent-3 (profile replicas; CNA_REPLICAS
                             # vale agent-1,agent-2,agent-3 salvo que .env diga otra cosa)
./scripts/up.sh --no-build   # arranca con las imágenes ya construidas
./scripts/up.sh --help
```

Cualquier otra opción se pasa a `docker compose up`. El script es idempotente: volver a
ejecutarlo conserva el token y la configuración, y reconstruye lo que haya cambiado. Las claves
de los modelos (`ANTHROPIC_API_KEY`…), `GITHUB_TOKEN` y el autor de los commits siguen
rellenándose a mano en `deploy/compose/.env` (ver la tabla de abajo); después, vuelve a ejecutar
`./scripts/up.sh`. En Windows, ejecútalo dentro de WSL.

### Paso a paso

Lo mismo que hace el script, a mano:

```sh
git clone https://github.com/ivanajenjo/cloud-native-agent.git
cd cloud-native-agent

# 1. Configuración
cp deploy/compose/.env.example deploy/compose/.env
#    Edita deploy/compose/.env y rellena como mínimo:
#      AGENT_API_TOKEN=<salida de: openssl rand -hex 32>

#    Proveedores LLM (opcional si usas los de Pi con API key):
cp config/providers.example.yaml config/providers.yaml

# 2. Construir y arrancar
docker compose -f deploy/compose/docker-compose.yml up --build -d

# 3. Comprobar
curl -s localhost:8080/health
#   {"status":"ok","service":"edge","version":"0.0.0"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/session
#   401 (sin token)
```

El primer build tarda bastante, sobre todo en la Raspberry, porque instala Java, Maven,
Gradle, Node, pnpm, Python, uv y Go.

Comandos útiles:

```sh
docker compose -f deploy/compose/docker-compose.yml logs -f          # logs
docker compose -f deploy/compose/docker-compose.yml exec edge \
  cat /edge-data/network.jsonl                                        # conexiones salientes
docker compose -f deploy/compose/docker-compose.yml down              # parar (conserva volúmenes)
```

### Configuración (`deploy/compose/.env`)

| Variable | Obligatoria | Para qué |
|---|---|---|
| `AGENT_API_TOKEN` | sí | Token de la API (mínimo 32 caracteres). Solo lo recibe `edge`. |
| `CNA_PUBLISH_ADDR` | no | Dónde se publica el `8080`. `127.0.0.1` (por defecto) solo esta máquina; `0.0.0.0` para la LAN. |
| `GITHUB_TOKEN` | para clonar repos privados y hacer push | PAT *fine-grained* solo para tus repos: *Contents* y *Pull requests* (lectura/escritura), *Metadata* (lectura). Sin *Workflows*. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | según el modelo | Claves de los proveedores LLM. |
| `CNA_GIT_USER_NAME`, `CNA_GIT_USER_EMAIL` | recomendadas | Autor de los commits del agente. |
| `EDGE_ASK_TIMEOUT_MS` | no | Tiempo para responder una pregunta de red antes de denegarla (por defecto 120000). |
| `NTFY_TOKEN`, `TELEGRAM_BOT_TOKEN` | según `notifications.yaml` | Tokens de las notificaciones push, referenciados como `$VARIABLE`. |
| `BRAVE_API_KEY`, `TAVILY_API_KEY` | según `web.yaml` | API key de la búsqueda web, referenciada como `$VARIABLE`. |
| `SEARXNG_SECRET` | con el profile `search` | Secreto del SearXNG del compose (`openssl rand -hex 32`). |
| `CNA_IDLE_TIMEOUT_MIN` | no | Minutos sin uso (sesión en `ready`) antes de parar Pi para liberar memoria; vuelve a arrancar con la siguiente petición. 30 por defecto, 0 lo desactiva. |
| `CNA_AGENT_MEM_LIMIT`, `CNA_AGENT_CPUS`, `CNA_AGENT_PIDS_LIMIT` | no | Límites del contenedor `agent` (por defecto `6g`, `4` y `2048`). |

Los modelos se configuran en `config/providers.yaml` (copia de
[`config/providers.example.yaml`](config/providers.example.yaml)), montado en solo lectura
en los dos contenedores. Se traduce al `models.json` de Pi al arrancar, y los hosts de sus
`baseUrl` se permiten en la red aunque estén en la LAN. Con un proveedor integrado de Pi
(Anthropic, OpenAI…) no hay `baseUrl`: la primera llamada al modelo genera una pregunta de
red (`api.anthropic.com:443`, por ejemplo); respóndela con `allow_always` y no vuelve a
preguntar.

Dos ficheros opcionales más, en `config/` y con el mismo tratamiento (ADR-0009):

- `config/notifications.yaml` (copia de
  [`notifications.example.yaml`](config/notifications.example.yaml)): avisos por ntfy o
  Telegram cuando la sesión espera una respuesta, termina o falla.
- `config/web.yaml` (copia de [`web.example.yaml`](config/web.example.yaml)): buscador de
  `web_search`. Para SearXNG local, arranca con
  `docker compose -f deploy/compose/docker-compose.yml --profile search up -d`.

`edge` permite sus hosts automáticamente. Sin estos ficheros no hay notificaciones y
`web_search` responde que no está configurada (`web_fetch` funciona igual).

No subas nunca el `.env` (está en `.gitignore`). Recomendado: un *ruleset* en GitHub que
proteja la rama base y un límite de gasto en los proveedores LLM.

## Web UI

Abre `http://localhost:8080/` (redirige a `/ui/`) y pega el `AGENT_API_TOKEN`. Por defecto el
navegador lo guarda solo mientras la pestaña está abierta; con *Recordar en este navegador*,
en `localStorage`. Desde la web se crea la sesión (modo auto o plan), se sigue la conversación
en directo con las tool calls, se responden las preguntas (incluidas las de plan, push/PR y
red), se ve la lista de tareas, el diff frente a la rama base o a un checkpoint (y se restaura)
y las conexiones de red con su política. La web no interpreta HTML ni Markdown de lo que llega
del agente y se sirve con una CSP estricta (ADR-0010).

Con varias réplicas (ADR-0013), la cabecera tiene un selector de réplica y la pestaña
*Réplicas* muestra todas con su sesión, un botón para abrir cada una y *Nueva sesión en una
réplica libre*. La réplica va en la URL (`/ui/#replica=agent-2`), así que cada pestaña del
navegador puede seguir una distinta; sin fragmento, la web habla con la réplica por defecto.

## CLI

El CLI `cna` se ejecuta en tu máquina, no en el contenedor:

```sh
npm install && npm run build
export CNA_URL=http://localhost:8080 CNA_TOKEN=<AGENT_API_TOKEN>

npx cna run owner/repo "Arregla el test que falla en CI" [--plan] [--base main] [--model proveedor/modelo]
npx cna run owner/repo --pr 12 ["más instrucciones"]   # atiende la revisión de un PR del agente
npx cna chat          # chat interactivo con la sesión actual; responde las preguntas en el terminal
npx cna status        # estado de la sesión
npx cna diff [--stat] [--checkpoint N]
npx cna todos
npx cna abort
npx cna close [--force]
npx cna stats         # tokens, coste y uso del contexto
npx cna history       # sesiones de la réplica
npx cna resume <id>   # reanuda una sesión cerrada (vale el prefijo que muestra history)
npx cna replicas      # réplicas detrás de edge y la sesión de cada una
npx cna run owner/repo "…" --any-replica   # la sesión va a la primera réplica libre
npx cna --replica agent-2 status   # cualquier comando contra otra réplica (o CNA_REPLICA)
```

`npm link -w @cna/cli` instala el comando `cna` de forma global. El token solo se lee de
`CNA_TOKEN` (nunca de la línea de comandos). En el chat, `/help` muestra los comandos
(`/abort`, `/status`, `/todos`, `/diff`, `/steer <texto>`, `/quit`); una pregunta se responde
con el número de la opción, `s`/`n` o el texto, y `/cancel` la cancela.

## Usar la API

Todo pasa por `edge:8080` con `Authorization: Bearer $AGENT_API_TOKEN`. Hay una sesión por
réplica, así que la API usa `/session` en singular. Sin prefijo se habla con la réplica por
defecto (la primera de `CNA_REPLICAS`); `GET /replicas` lista todas y `/replicas/<nombre>/…` es la
API de otra (p. ej. `$API/replicas/agent-2/session`).

```sh
export API=http://localhost:8080 AUTH="Authorization: Bearer $AGENT_API_TOKEN"

# Crear la sesión: clona el repo, crea la rama agent/<slug> y lanza el prompt
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/session \
  -d '{"repo":"tu-usuario/tu-repo","prompt":"Añade tests al parser","autoPush":false}'

# Seguir los eventos (SSE con replay; -N para no bufferizar)
curl -sN -H "$AUTH" $API/session/events

# Estado y preguntas pendientes
curl -s -H "$AUTH" $API/session

# Responder una pregunta (select/input/editor → value; confirm → confirmed)
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST \
  $API/session/answers/<id> -d '{"value":"b.txt"}'

# Otro mensaje, abortar, cerrar (409 si hay cambios sin subir; ?force=true para forzar)
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/session/messages \
  -d '{"text":"Ahora ejecuta los tests"}'
curl -s -H "$AUTH" -X POST $API/session/abort
curl -s -H "$AUTH" -X DELETE $API/session
```

Estados: `cloning → running ⇄ waiting_input → ready` (+ `error`, `closed`). El agente
pregunta con `ask_user`, pide confirmación antes de `git_push` (salvo `autoPush: true`) y
nunca hace push a la rama base. Las preguntas de red (`kind: "network"`, ids `net-…`) se
responden igual, con `{"value":"allow_once"|"allow_always"|"deny"}`; sin respuesta en el
timeout se deniegan. *Permitir siempre* se guarda en `/edge-data/policy.json`.

Fase 2:

```sh
# Modo plan: solo lectura hasta que apruebes el plan (pregunta kind "plan":
# {"value":"approve"} o {"value":"request_changes"} y después el texto de los cambios)
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/session \
  -d '{"repo":"tu-usuario/tu-repo","prompt":"Migra el parser a zod","mode":"plan"}'

curl -s -H "$AUTH" $API/session/todos                 # lista de tareas del agente
curl -s -H "$AUTH" $API/session/diff                  # cambios frente a la rama base
curl -s -H "$AUTH" $API/session/checkpoints           # snapshots: tras clonar y tras cada ejecución con cambios
curl -s -H "$AUTH" "$API/session/diff?checkpoint=1"   # cambios desde un checkpoint
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST \
  $API/session/checkpoints/1/restore -d '{"conversation":true}'   # deshacer ficheros (y conversación)

curl -s -H "$AUTH" $API/network/policy                # modo, allowlist y servicios permitidos
curl -s -H "$AUTH" "$API/network/log?limit=50"        # últimas conexiones salientes
curl -s -H "$AUTH" -H 'content-type: application/json' -X PUT $API/network/policy \
  -d '{"mode":"ask","allow":["*.example.com"]}'

curl -s -H "$AUTH" $API/session/stats                 # tokens, coste y contexto
curl -s -H "$AUTH" $API/session/history               # sesiones de la réplica
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST \
  $API/session/history/<id>/resume -d '{"prompt":"sigue"}'   # reanudar una sesión cerrada

# Trabajar sobre un PR abierto del agente (rama agent/*): lee la revisión con gh y sube a la misma rama
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/session \
  -d '{"repo":"owner/repo","pr":12}'
```

**Reinicios y memoria (ADR-0011).** El gateway guarda la sesión en `/data/state`. Si el
contenedor se reinicia, la sesión vuelve en `ready` con su conversación; lo que estaba
ejecutándose y las preguntas pendientes se pierden (sale un aviso). Con la sesión parada más de
`CNA_IDLE_TIMEOUT_MIN` minutos, Pi se detiene para liberar memoria (`suspended: true`) y vuelve
a arrancar, con la misma conversación, en cuanto se le pide algo. El historial guarda las últimas
50 sesiones; una sesión cerrada se puede reanudar mientras siga en él: se clona de nuevo el repo
en su rama (sin sus checkpoints anteriores).

El agente abre el pull request con `create_pr` (pide confirmación salvo `autoPush: true`) y
la extensión `guard` bloquea en `bash` comandos como `git push`, `--force`, `sudo`, `docker` o
`rm -rf /`. Cada ejecución de una tool queda en `/data/logs/tools.jsonl` del agente, con los
secretos sustituidos.

Referencia completa de rutas y eventos en [`docs/PLAN.md`](docs/PLAN.md#api-rest-borrador-v1).

### Verificar la red

Con la réplica levantada, este script comprueba que el agente no tiene salida directa, que
git, npm, pip, Maven, Gradle, Go, etc. funcionan a través de `edge`, y lista los hosts a los
que se ha conectado:

```sh
scripts/verify-egress.sh
```

Más detalle (Windows, Raspberry, variables de `edge`) en
[`docs/despliegue-local.md`](docs/despliegue-local.md).

### Usar Ollama como modelo

> Ollama está en tu máquina o en la LAN (destino interno) y usa el puerto `11434`. `edge`
> lo permite solo porque su `baseUrl` está en `config/providers.yaml`.

**Dónde ejecutar Ollama.** En el Mac o en el PC con Windows. En la Raspberry Pi 4 no es
viable ejecutar un modelo útil: allí el agente usará el Ollama de otra máquina de la LAN.

**1. Instalar y descargar un modelo** (en la máquina de Ollama, desde
[ollama.com](https://ollama.com)):

```sh
ollama pull qwen3-coder:30b     # o un modelo más pequeño si no hay memoria suficiente
```

**2. Escuchar en la red y fijar el contexto.** Por defecto Ollama solo escucha en
`127.0.0.1`, inaccesible desde los contenedores, y con un contexto corto para un agente
de programación:

| Sistema | Cómo |
|---|---|
| macOS (app) | `launchctl setenv OLLAMA_HOST 0.0.0.0` y `launchctl setenv OLLAMA_CONTEXT_LENGTH 65536`; reinicia la app |
| Windows | Variables de usuario `OLLAMA_HOST=0.0.0.0` y `OLLAMA_CONTEXT_LENGTH=65536`; reinicia Ollama |
| Linux (systemd) | `sudo systemctl edit ollama` → `[Service]` `Environment="OLLAMA_HOST=0.0.0.0"` `Environment="OLLAMA_CONTEXT_LENGTH=65536"`; `sudo systemctl restart ollama` |

Escuchar en `0.0.0.0` expone Ollama, que no tiene autenticación, a toda tu red: hazlo
solo en una LAN de confianza.

**3. Comprobar que responde** desde otra máquina (o desde la misma con su IP de la LAN):

```sh
curl http://<ip-de-la-maquina>:11434/v1/models
```

**4. Qué URL usará el agente:**
- Agente en el mismo Mac o PC que Ollama: `http://host.docker.internal:11434/v1`.
- Agente en la Raspberry: `http://<ip-del-mac-o-pc>:11434/v1`. Conviene fijar esa IP en
  el router.

Esa URL va en `config/providers.yaml` (formato en
[`docs/PLAN.md`](docs/PLAN.md#proveedores-y-modelos)). El `contextWindow` debe coincidir
con `OLLAMA_CONTEXT_LENGTH`. Tras cambiar el fichero, reinicia los dos contenedores:

```yaml
default: ollama/qwen3-coder:30b
providers:
  ollama:
    baseUrl: http://host.docker.internal:11434/v1
    api: openai-completions
    models:
      - id: qwen3-coder:30b
        contextWindow: 65536
```

## Desarrollo

Monorepo con npm workspaces y TypeScript estricto.

```sh
npm install
npm run build        # compila todos los paquetes a packages/*/dist
npm run typecheck    # tsc sin emitir, incluye tests
npm run lint         # biome check
npm test             # vitest run
npm run format       # biome format --write
```

Una tarea está terminada cuando `typecheck`, `lint` y `test` pasan. No hay CI: se
comprueba en local.

### Ejecutar sin Docker

Útil para probar la API y el proxy rápidamente (en esta forma el agente **no** está aislado
de la red):

```sh
npm run build

# Terminal 1: gateway (datos y config en carpetas locales)
CNA_DATA_DIR="$PWD/.data" CNA_PROVIDERS_FILE="$PWD/config/providers.yaml" \
GATEWAY_PORT=8090 node packages/gateway/dist/main.js

# Terminal 2: edge
AGENT_API_TOKEN=$(openssl rand -hex 32) \
EDGE_REPLICAS=localhost \
EDGE_DATA_DIR="$PWD/.edge-data" EDGE_PROVIDERS_FILE="$PWD/config/providers.yaml" \
node packages/edge/dist/main.js

# Terminal 3: usar el proxy de edge (no uses localhost como destino: se deniega)
curl -x http://127.0.0.1:3128 -sI https://github.com
cat .edge-data/network.jsonl
```

### Estructura

```
packages/
  shared/     tipos compartidos de la API, eventos y red (@cna/shared)
  gateway/    API de sesión dentro del contenedor del agente (@cna/gateway)
  edge/       entrada con Bearer + proxy de salida con política (@cna/edge)
  extensions/ extensiones de Pi (ask_user, git, todo, plan-mode, guard, web) y prompt de sistema (@cna/extensions)
  web/        web UI estática (Vite, sin framework), servida por el gateway en /ui/ (@cna/web)
  cli/        cliente de terminal `cna` (@cna/cli)
config/       providers.example.yaml (copiar a providers.yaml)
docker/       Dockerfile (agent), Dockerfile.edge, config de mise/Maven/Gradle
deploy/
  compose/    docker-compose.yml y .env.example
scripts/      verify-egress.sh
docs/         PLAN.md (plan y fases), fase-1.5.md (tareas pendientes), adr/ (decisiones), despliegue-local.md
```

### Contribuir

Lee [`AGENTS.md`](AGENTS.md) (convenciones, trampas de Pi e invariantes de seguridad) y
[`docs/PLAN.md`](docs/PLAN.md) antes de tocar código. Commits en Conventional Commits en
español (`feat(edge): …`, `fix(gateway): …`, `docs: …`). Código y comentarios en inglés;
documentación en español.
