# Despliegue local con Docker Compose

Cómo levantar una réplica (`agent` + `edge`) en una máquina con Docker (MacBook,
PC con Windows o Raspberry Pi 4) y cómo comprobar que la salida a internet pasa solo por `edge`.

## Requisitos
- Docker con BuildKit y el plugin `compose` (Docker Desktop o Docker Engine ≥ 24).
- Cada equipo construye su propia imagen con `--build` (amd64 o arm64 según la máquina).
  En la Raspberry Pi el primer build tarda (instala los toolchains con mise); mejor con
  `/var/lib/docker` en el SSD y no en la microSD.

### Windows
- Docker Desktop con el backend **WSL2**. Las imágenes se construyen para amd64.
- Clona el repo **dentro de WSL** (p. ej. `~/src` en Ubuntu, no en `/mnt/c/...`) y ejecuta
  ahí `docker compose` y `scripts/verify-egress.sh` (es bash). Es mucho más rápido y evita
  problemas de permisos.
- `.gitattributes` fuerza finales de línea LF: un checkout con CRLF rompería
  `docker/agent-entrypoint.sh` dentro de la imagen.

## Levantar la réplica

```sh
cp deploy/compose/.env.example deploy/compose/.env
# Editar deploy/compose/.env:
#   AGENT_API_TOKEN=$(openssl rand -hex 32)   # obligatorio, mínimo 32 caracteres
#   CNA_PUBLISH_ADDR=0.0.0.0                  # solo si se quiere acceder desde la LAN
#   GITHUB_TOKEN=...                          # PAT fine-grained (ver PLAN.md, Seguridad)
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up --build -d
```

Comprobaciones rápidas:

```sh
curl -s localhost:8080/health                                   # {"status":"ok","service":"edge",...}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/session  # 401 sin token
```

### Variables

| Dónde | Variable | Por defecto | Para qué |
|---|---|---|---|
| `edge` | `AGENT_API_TOKEN` | — (obligatoria) | Bearer de la API. Solo existe en `edge`. |
| `edge` | `GATEWAY_URL` | `http://agent:8090` | Gateway al que se reenvía la API. |
| `edge` | `EDGE_DATA_DIR` | `/edge-data` | Volumen de `edge`: `network.jsonl` y `policy.json` (modo y *permitir siempre*). |
| `edge` | `EDGE_PROVIDERS_FILE` | `/config/providers.yaml` | Proveedores cuyos `baseUrl` se permiten aunque sean internos. |
| `edge` | `EDGE_ASK_TIMEOUT_MS` | `120000` | Tiempo para responder una pregunta de red antes de denegarla. |
| `edge` | `EDGE_API_PORT` / `EDGE_PROXY_PORT` | `8080` / `3128` | Entrada de la API y proxy de salida. |
| compose | `CNA_PUBLISH_ADDR` | `127.0.0.1` | Dirección del host donde se publica el `8080`. |
| `agent` | `GATEWAY_PORT` | `8090` | Puerto del gateway en la red interna. |
| `agent` | `CNA_DATA_DIR` | `/data` | Volumen del agente: `workspace/repo`, `sessions/`, `config/pi` (generado), `cache/`. |
| `agent` | `CNA_PROVIDERS_FILE` | `/config/providers.yaml` | Se traduce a `models.json` de Pi al arrancar. |
| `agent` | `CNA_EXTENSIONS_DIR` | `/app/packages/extensions` | Extensiones de Pi y prompt de sistema (de root, solo lectura para `agent`). |
| `agent` | `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | vacías | Credenciales (riesgo aceptado en ADR-0006). |
| `agent` | `CNA_GIT_USER_NAME`, `CNA_GIT_USER_EMAIL` | vacías | Identidad de los commits del agente. |

## Verificar la salida por el proxy (cierre de la fase 0)

Con la réplica levantada:

```sh
scripts/verify-egress.sh
```

El script ejecuta dentro de `agent`:
- una conexión directa a `github.com` que **debe fallar** (el agente no tiene ruta de salida);
- git, gh (si hay `GITHUB_TOKEN`), Pi, `fetch` de Node, npm, pnpm, pip, uv, Maven, Gradle
  (Maven Central y Gradle Plugin Portal), Go, `mise ls-remote` y los hosts de descarga de
  toolchains, todos a través de `edge`;
- una petición a `169.254.169.254` que **debe** devolver 403 (destino interno).

Al final lista los `host:puerto` que ha registrado `edge` durante la ejecución, con su
decisión. Esa lista es la que cierra la **allowlist base** de la fase 1: compárala con la
de "Control de red saliente" en `PLAN.md` y actualiza el plan con lo que falte o sobre.

El registro completo está en el volumen de `edge`:

```sh
docker compose -f deploy/compose/docker-compose.yml exec edge cat /edge-data/network.jsonl
```

## Política de red

El modo por defecto es `ask`. Orden de decisión de `edge`:
1. Host y puerto de un `baseUrl` de `config/providers.yaml` → se permite (aunque sea LAN).
2. Alguna dirección resuelta interna (loopback, privada, link-local…) → se deniega.
3. Allowlist base (GitHub, registries, descargas de toolchains) o *permitir siempre* → se permite.
4. Puerto distinto de 80/443 → se deniega.
5. Resto: en `ask` se pregunta al usuario por la API (`question` con `kind: "network"`);
   sin respuesta en `EDGE_ASK_TIMEOUT_MS` o sin sesión activa, se deniega. En `allowlist`
   se deniega sin preguntar.

La política vive en el volumen de `edge` (`/edge-data/policy.json`), fuera del alcance del
agente. Para cambiar de modo (por ejemplo a `audit` mientras se ejecuta
`scripts/verify-egress.sh` con hosts nuevos), edita ese fichero y reinicia `edge`. El
ejemplo lo sobrescribe entero, así que borra las entradas de *permitir siempre*:

```sh
docker compose -f deploy/compose/docker-compose.yml exec edge \
  sh -c 'echo "{\"mode\":\"audit\",\"allow\":[]}" > /edge-data/policy.json'
docker compose -f deploy/compose/docker-compose.yml restart edge
```

Los endpoints `/network/*` para verlo y cambiarlo por la API llegan en la fase 2.

## Estado
- No hay CI: la construcción de las imágenes y `scripts/verify-egress.sh` se comprueban
  en local, con un daemon de Docker.
