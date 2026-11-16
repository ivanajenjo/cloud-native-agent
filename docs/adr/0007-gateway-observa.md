# ADR-0007: El gateway observa los eventos RPC; las extensiones solo aportan tools

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
El plan preveía extensiones `audit` y `checkpoint` y eventos SSE `todo` y `checkpoint`
emitidos por extensiones, pero no decía cómo llega esa información al gateway. El
protocolo RPC no tiene un canal genérico de eventos de extensión, y
`extension_ui_request` no lleva metadatos para saber qué tipo de pregunta es.

## Decisión
1. **Registro de tools:** lo hace el gateway con `tool_execution_start/update/end`. No hay
   extensión `audit`.
2. **Lista de tareas:** la tool `todo` devuelve el estado completo en `details`; el gateway
   lo lee de `tool_execution_end` y emite `todo`.
3. **Checkpoints:** los crea el gateway tras clonar y en cada `agent_settled` con cambios,
   con un índice temporal (`git add -A` + `write-tree` + `commit-tree`) para incluir
   ficheros sin seguimiento sin tocar el índice ni la rama, en `refs/cna/checkpoints/<n>`.
   Restaurar deja el árbol de trabajo idéntico al snapshot (borra lo creado después, no
   toca lo ignorado). Cada checkpoint guarda el `entryId` del mensaje de usuario
   siguiente para poder restaurar también la conversación con el comando RPC `fork`.
4. **Avisos de una extensión al gateway:** `pi.appendEntry("cna.<tipo>", datos)`, que llega
   como evento `entry_appended`. Hoy solo lo usa `plan-mode` para el cambio de modo.
5. **Tipo de pregunta:** las extensiones anteponen `cna:<kind>:` al título del diálogo; el
   códec vive en `@cna/shared`. Sin prefijo se trata como `ask_user`.

Nota (fase 2): en vez del `entryId` se guarda cuántos mensajes de usuario tiene la rama al
crear el checkpoint (`get_fork_messages`). Al restaurar la conversación se pide de nuevo
`get_fork_messages` y se hace `fork` con el `entryId` del mensaje en esa posición, que es el
primero posterior al checkpoint. Así no hace falta seguir el mensaje siguiente cuando llega.
Restaurar con conversación descarta los checkpoints posteriores, que quedan en la rama
abandonada, y es todo o nada: antes se toma un snapshot de seguridad del árbol y, si falla la
restauración de ficheros o el `fork`, los ficheros vuelven a él. Un checkpoint nuevo solo se
crea si el árbol difiere del último checkpoint creado o restaurado.

## Consecuencias
- (+) Menos código dentro de Pi y menos superficie expuesta a cambios de su API.
- (+) Checkpoints y registro funcionan aunque una extensión falle.
- (−) El gateway depende de la forma de `details` de la tool `todo`: el tipo se comparte
  en `@cna/shared`.
- (−) Las entradas `cna.*` quedan guardadas en el JSONL de la sesión.
