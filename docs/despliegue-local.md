# Despliegue local con Docker Compose

Cómo levantar una réplica (`agent` + `edge`) en una máquina con Docker (MacBook o
Raspberry Pi 4) y cómo comprobar que la salida a internet pasa solo por `edge`.

## Requisitos
- Docker con BuildKit y el plugin `compose` (Docker Desktop o Docker Engine ≥ 24).
- Para la Raspberry Pi: mejor construir la imagen en el MacBook o en CI y hacer `docker pull`
  (ver "Consideraciones Raspberry Pi 4" en `PLAN.md`).

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
| `edge` | `EDGE_DATA_DIR` | `/edge-data` | Volumen de `edge`: `network.jsonl` (y en la fase 1 la política). |
| `edge` | `EDGE_API_PORT` / `EDGE_PROXY_PORT` | `8080` / `3128` | Entrada de la API y proxy de salida. |
| compose | `CNA_PUBLISH_ADDR` | `127.0.0.1` | Dirección del host donde se publica el `8080`. |
| `agent` | `GATEWAY_PORT` | `8090` | Puerto del gateway en la red interna. |
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

## Estado
- En la fase 0 el proxy está en modo `audit`: permite cualquier destino externo en los
  puertos 80/443 y deniega los destinos internos. El modo `ask` llega en la fase 1.
- La construcción de las imágenes se comprueba en CI (amd64 y arm64). La ejecución de
  `scripts/verify-egress.sh` necesita un daemon de Docker y queda a cargo del usuario.
