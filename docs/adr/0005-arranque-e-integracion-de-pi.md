# ADR-0005: Cómo se arranca Pi y qué señales del protocolo se usan

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
Pi carga por defecto recursos del directorio de trabajo (extensiones, settings, servidores
MCP, prompt de sistema) y su protocolo RPC tiene varias señales parecidas entre sí. El
directorio de trabajo es un repo clonado, que puede traer contenido hostil, y el gateway
necesita saber con certeza cuándo ha terminado una ejecución.

## Decisión
1. **Nada ejecutable del repo.** Pi se arranca con `--no-approve` (rechaza los recursos
   sujetos a *project trust*: `.pi/extensions`, `.pi/settings.json`, `.pi/mcp.json`,
   `.pi/SYSTEM.md`, skills del proyecto), `--no-extensions` y nuestras extensiones con
   `-e`. El `AGENTS.md`/`CLAUDE.md` del repo sí se carga, como texto no fiable.
2. **Sin MCP:** `--no-mcp`. Cada servidor es un proceso más y más destinos de red.
3. **Sin actividad de red propia de Pi:** `PI_OFFLINE=1`, `PI_TELEMETRY=0`,
   `PI_SKIP_VERSION_CHECK=1`. Configuración generada en `PI_CODING_AGENT_DIR`.
4. **Fin de ejecución = `agent_settled`.** Tras `agent_end` Pi aún puede reintentar,
   compactar o seguir con mensajes en cola.
5. **Streaming:** `message_update` solo trae deltas; el mensaje completo es el de `message_end`.
6. **`prompt`** responde con `data.disposition` (`started`, `queued` o `handled`); con
   `handled` no hay ejecución que esperar.
7. **Canal extensión → gateway:** `pi.appendEntry()`, que llega por RPC como `entry_appended`.
8. **Esquemas de tools:** Pi los valida como JSON Schema, así que las funciones de TypeBox
   que no lo son (`Type.Refine`, codecs…) no se aplican. `Type` se importa de `typebox` y
   `StringEnum` de `@earendil-works/pi-ai`.

## Consecuencias
- (+) Un repo clonado no puede ejecutar código dentro del proceso de Pi ni cambiar su
  prompt de sistema.
- (+) El estado de la sesión no da falsos "terminado".
- (−) No se aprovechan extensiones, skills ni servidores MCP que traiga un repo.
- Requiere Node ≥ 22.19.
