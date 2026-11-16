# cloud-native-agent

Agente de programación auto-hospedado, tipo "Claude Code lite", basado en
[Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Corre en
Docker en una Raspberry Pi 4, un MacBook o un PC con Windows, clona repos de GitHub,
trabaja en ellos (Java, Node, Python, Go), ejecuta tests y sube los cambios a una rama.
Uso personal, mono-usuario.

> **Estado:** fase 0 completada (esqueleto, `edge` y contenedores). Todavía no hay agente
> conversacional: llega en la fase 1. Ver [`docs/PLAN.md`](docs/PLAN.md).

## Cómo funciona

```
 curl / web UI / CLI ──► edge :8080 ──► agent (gateway :8090 + Pi + toolchains)
   Bearer token          │                       │
                         │ :3128 proxy ◄─────────┘  todo el tráfico saliente
                         ▼
                      internet (política + registro)
```

Cada réplica son dos contenedores:

- **`edge`**: la única pieza con acceso a internet.
  - Valida el token (`Authorization: Bearer`) y reenvía la API al gateway, quitando el
    token para que nunca llegue al agente.
  - Hace de proxy de salida del agente: registra cada conexión en
    `/edge-data/network.jsonl` y deniega los destinos internos (loopback, LAN, metadatos…).
- **`agent`**: gateway (API REST) + Pi + toolchains (mise). Vive en una red interna sin
  salida: lo que no pasa por el proxy de `edge` no llega a ningún sitio.

Las decisiones de diseño están en [`docs/adr/`](docs/adr/) y la seguridad (qué protege y
qué no) en [`docs/adr/0006-frontera-de-confianza.md`](docs/adr/0006-frontera-de-confianza.md).

## Requisitos

| Para | Necesitas |
|---|---|
| Ejecutar con Docker | Docker con BuildKit y `compose` (Docker Desktop en Mac/Windows, Docker Engine ≥ 24 en Linux/Raspberry) |
| Desarrollar | Node.js **22 LTS (≥ 22.21)** y npm |
| Windows | Docker Desktop con backend **WSL2**; clona el repo dentro de WSL |

## Puesta en marcha con Docker

Cada equipo construye su propia imagen (amd64 o arm64 según la máquina).

```sh
git clone https://github.com/ivanajenjo/cloud-native-agent.git
cd cloud-native-agent

# 1. Configuración
cp deploy/compose/.env.example deploy/compose/.env
#    Edita deploy/compose/.env y rellena como mínimo:
#      AGENT_API_TOKEN=<salida de: openssl rand -hex 32>

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
| `GITHUB_TOKEN` | no (fase 1) | PAT *fine-grained* solo para tus repos: *Contents* y *Pull requests* (lectura/escritura), *Metadata* (lectura). Sin *Workflows*. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | no (fase 1) | Claves de los proveedores LLM. |
| `CNA_GIT_USER_NAME`, `CNA_GIT_USER_EMAIL` | no (fase 1) | Autor de los commits del agente. |

No subas nunca el `.env` (está en `.gitignore`). Recomendado: un *ruleset* en GitHub que
proteja la rama base y un límite de gasto en los proveedores LLM.

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

> **Aún no funciona.** El agente conversacional y la configuración de proveedores llegan
> en la fase 1. Además, hoy el proxy de `edge` deniega Ollama: está en tu máquina o en la
> LAN (destino interno) y usa el puerto `11434` (solo se permiten 80 y 443). La fase 1
> añade la excepción para los hosts de los proveedores configurados. Lo de abajo sirve
> para dejar Ollama preparado.

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

En la fase 1 esa URL irá en `config/providers.yaml` (formato previsto en
[`docs/PLAN.md`](docs/PLAN.md#proveedores-y-modelos)). El `contextWindow` debe coincidir
con `OLLAMA_CONTEXT_LENGTH`:

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

# Terminal 1: gateway
GATEWAY_PORT=8090 node packages/gateway/dist/main.js

# Terminal 2: edge
AGENT_API_TOKEN=$(openssl rand -hex 32) \
GATEWAY_URL=http://127.0.0.1:8090 \
EDGE_DATA_DIR="$PWD/.edge-data" \
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
docker/       Dockerfile (agent), Dockerfile.edge, config de mise/Maven/Gradle
deploy/
  compose/    docker-compose.yml y .env.example
scripts/      verify-egress.sh
docs/         PLAN.md (plan y fases), adr/ (decisiones), despliegue-local.md
```

### Contribuir

Lee [`AGENTS.md`](AGENTS.md) (convenciones, trampas de Pi e invariantes de seguridad) y
[`docs/PLAN.md`](docs/PLAN.md) antes de tocar código. Commits en Conventional Commits en
español (`feat(edge): …`, `fix(gateway): …`, `docs: …`). Código y comentarios en inglés;
documentación en español.
