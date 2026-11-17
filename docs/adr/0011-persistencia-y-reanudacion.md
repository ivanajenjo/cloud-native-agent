# ADR-0011: Persistencia de la sesión, reanudación, historial y PR existentes

- Estado: aceptado
- Fecha: 2026-11-17

## Contexto
La fase 4 pide que la sesión sobreviva a un reinicio del contenedor, que no consuma memoria
cuando nadie la usa, poder volver a sesiones pasadas, ver tokens y coste, y trabajar sobre un
PR existente. Hasta ahora todo el estado vive en la memoria del gateway (ADR-0003) y un
reinicio lo pierde. Pi guarda la conversación en su JSONL (`--session-dir`), pero el gateway
no sabía cómo volver a abrirla. El workspace es siempre el mismo directorio
(`/data/workspace/repo`).

## Decisión
1. **El id de Pi es el de la sesión.** El gateway arranca Pi con `--session-id <SessionInfo.id>`
   (un UUID). Como el directorio de trabajo es siempre el mismo, volver a arrancar Pi con ese id
   reabre la conversación, con su árbol, tokens y coste. No hay que buscar ficheros.
2. **Estado en disco.** El gateway guarda en `/data/state/session.json` (escritura atómica:
   fichero temporal + `rename`) lo que no está en Pi: `SessionInfo` sin las preguntas, la lista
   de tareas y los checkpoints (con su árbol, `forkIndex` y tareas). Se reescribe en cada cambio
   relevante y se borra al cerrar la sesión.
3. **Arranque del gateway.** Si hay estado guardado y el workspace sigue ahí, la sesión se
   reanuda: Pi arranca con el mismo id y el gateway emite un evento SSE `history` con la
   conversación (`get_messages`) para que la web y el CLI la pinten. Una ejecución que estaba
   en marcha se pierde y la sesión queda en `ready` con un aviso; las preguntas pendientes se
   pierden igual (su diálogo vivía en el proceso de Pi). Una sesión que estaba clonando pasa a
   `error`. Sin estado guardado, el workspace que quede se borra.
4. **Ids de eventos crecientes entre procesos.** El `EventLog` empieza a numerar en `Date.now()`:
   un cliente que reconecta con un `Last-Event-ID` del proceso anterior recibe los eventos nuevos
   (incluido `history`) en vez de nada. Si el reloj fuera hacia atrás, el replay completo y el
   `reset` del cliente lo cubren.
5. **Suspensión por inactividad.** Con la sesión en `ready` y sin peticiones durante
   `CNA_IDLE_TIMEOUT_MIN` minutos (30 por defecto; 0 lo desactiva), el gateway para Pi y marca
   `suspended: true`. Cualquier petición que necesite a Pi (mensaje, `messages`, `stats`, cambio
   de modelo, restaurar con conversación) lo arranca antes con el mismo id. Nunca se suspende con
   una ejecución o preguntas pendientes.
6. **Historial** en `/data/state/history.json`: una entrada por sesión (la actual incluida), con
   sus datos, el último estado y las últimas estadísticas. Máximo `HISTORY_LIMIT` (50); al pasar
   del límite se borran la entrada más antigua y su JSONL de Pi. `GET /session/history` lo lista.
7. **Reanudar una sesión pasada** (`POST /session/history/:id/resume`): solo con la réplica libre
   y si la sesión está cerrada, tenía rama y su JSONL sigue en disco. Se clona el repo de nuevo,
   se hace checkout de la rama desde el remoto (si no se llegó a subir, se recrea desde la base:
   lo que no se subió se descartó al cerrar) y Pi arranca con el mismo id. Los checkpoints
   anteriores no vuelven (vivían en el workspace borrado): se crea un checkpoint 0 nuevo.
8. **Tokens y coste:** `GET /session/stats` traduce `get_session_stats` de Pi a `SessionStats`.
   El gateway guarda las últimas en el historial al terminar cada ejecución y al cerrar.
9. **PR existente** (`POST /session` con `pr`): el gateway consulta el PR con `gh pr view` y solo
   acepta PRs **abiertos, del mismo repositorio y con la rama de cabecera `agent/*`**, es decir, PRs
   del propio agente. Así se mantiene el invariante de AGENTS.md (el agente solo trabaja y hace
   push en ramas `agent/*`, nunca en la base) sin tocar la extensión `git`. La base de la sesión
   es la del PR. El primer prompt lo compone el gateway: pide leer la descripción y los
   comentarios de revisión con `gh`, atenderlos y subir a la misma rama; el `prompt` del usuario,
   si viene, se añade al final. Un PR que no cumple las condiciones deja la sesión en `error` con
   el motivo, como un fallo de clonado.
10. **Límites de recursos** en el compose: memoria, CPU y número de procesos del contenedor
   `agent`, configurables en `.env` (`CNA_AGENT_MEM_LIMIT`, `CNA_AGENT_CPUS`,
   `CNA_AGENT_PIDS_LIMIT`). El registro de tools rota a los 10 MB (se guarda uno anterior).

## Consecuencias
- (+) Un reinicio del contenedor (actualización, corte de luz en la Raspberry) no pierde la
  conversación ni la rama local, y la Raspberry no tiene Pi en memoria si nadie lo usa.
- (+) Volver a una sesión cerrada es posible mientras su JSONL siga en el historial.
- (+) Iterar sobre las revisiones de un PR del agente no relaja ninguna regla de ramas.
- (−) Una ejecución en curso o una pregunta pendiente se pierde en un reinicio; hay que volver a
  pedirlo.
- (−) No se puede trabajar sobre PRs que no abrió el agente (ramas que no son `agent/*`) ni de forks.
- (−) Reanudar una sesión pasada no recupera sus checkpoints.
