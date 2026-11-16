# ADR-0009: Servicios auxiliares (notificaciones y búsqueda web) y su salida por `edge`

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
La fase 2 añade dos servicios externos: las notificaciones push (ntfy o Telegram) que envía el
gateway y la búsqueda web de la extensión `web` (SearXNG autoalojado, Brave o Tavily). El plan
dice que sus hosts entran en la allowlist automáticamente, pero no dónde se configuran ni cómo
lo sabe `edge` sin fiarse del contenedor del agente (ADR-0006, ADR-0008).

## Decisión
1. **Dos ficheros nuevos** en `config/`, montados en solo lectura en `agent` y en `edge`, como
   `providers.yaml`: `notifications.yaml` (proveedor `ntfy` o `telegram`, eventos que avisan)
   y `web.yaml` (proveedor de búsqueda). Si no existen, el servicio está desactivado.
   Esquemas y parsers en `@cna/shared` (`services.ts`).
2. **`edge` permite sus endpoints** (`serviceEndpoints()`) igual que los de los proveedores:
   aunque sean destinos internos (ntfy o SearXNG en la LAN o en el compose) o usen otro
   puerto. La decisión se registra con el motivo `service`. Los endpoints de Brave, Tavily
   y Telegram son fijos (`SEARCH_API_BASES`, `TELEGRAM_API_BASE`).
3. **Los secretos** (token de ntfy, token del bot de Telegram, API key de búsqueda) se escriben
   como `$VARIABLE` y llegan por el entorno del contenedor `agent`. El gateway los añade al
   redactor. El token de Telegram va en la ruta de la URL: nunca se registra la URL.
4. **El tráfico sale por `edge`** como el resto: el gateway envía las notificaciones con
   `fetch` (que usa el proxy con `NODE_USE_ENV_PROXY=1`) y la extensión `web` igual.
5. **La extensión `web` lee `web.yaml`** desde la ruta que le pasa el gateway con el flag
   `--cna-web-config`; resuelve `$VARIABLE` con su propio entorno.
6. **SearXNG** es opcional en el compose (profile `search`): solo en la red `external`, de modo
   que el agente lo alcanza a través de `edge` y no tiene una ruta directa a él.

## Consecuencias
- (+) `edge` sigue sin depender de lo que diga el agente para abrir la red.
- (+) Cambiar de proveedor de notificaciones o de búsqueda es editar un fichero y reiniciar.
- (−) Dos ficheros más que montar en los dos contenedores.
- (−) La extensión `web` puede llamar a cualquier URL permitida: `web_fetch` pasa por la
  política de red como cualquier otra petición (en `ask`, un dominio nuevo pregunta).
