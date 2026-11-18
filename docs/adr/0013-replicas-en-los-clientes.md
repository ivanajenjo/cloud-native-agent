# ADR-0013: Réplicas en los clientes: selector web, réplica libre y vista de sesiones

- Estado: aceptado
- Fecha: 2026-11-18

## Contexto
ADR-0012 deja varias réplicas detrás de un único `edge`, pero la web UI solo habla con la
réplica por defecto, y en el CLI hay que saber de antemano qué réplica está libre. El backlog
pedía un selector de réplica en la web, asignar sola una réplica libre y una vista de todas las
sesiones (el antiguo "hub"). Hay que decidir dónde vive la asignación (en `edge` o en el
cliente) y cómo sabe la web con qué réplica está hablando.

## Decisión
1. **La asignación de réplica libre la hace el cliente**, no `edge`. No hay endpoint nuevo:
   el cliente lee `GET /replicas` y prueba `POST /replicas/<nombre>/session` en las réplicas
   libres, en el orden de `EDGE_REPLICAS`. Si otra sesión se la ha quitado entretanto (`409
   session_exists`), pasa a la siguiente; cualquier otro error se devuelve tal cual. La
   entrada de `edge`, que es la parte delicada (token, rutas internas), no cambia.
2. **Réplica libre:** alcanzable y sin sesión, o con una sesión `closed` o `error` (son los
   casos en que el gateway acepta `POST /session`). Lo calculan `isReplicaFree` y
   `freeReplicaNames` en `@cna/shared` (sin zod, también exportadas por `@cna/shared/client`).
   `createSessionOnFreeReplica` en el cliente común hace la asignación; si no queda ninguna
   libre, lanza `ApiClientError` con el código de cliente `no_free_replica` (409). El servidor
   nunca devuelve ese código.
3. **CLI:** `cna run --any-replica …` crea la sesión en la primera réplica libre, dice cuál es
   y abre el chat con ella. No se combina con `--replica` (error de uso); `CNA_REPLICA` se
   ignora con `--any-replica`.
4. **Web: la réplica va en el fragmento de la URL**, `#replica=<nombre>`. Sin fragmento (o
   con uno no válido) la web habla con la réplica por defecto por las rutas sin prefijo; con
   él, por `/replicas/<nombre>/…`. Cada pestaña del navegador puede seguir una réplica distinta
   y el enlace se puede guardar. Cambiar de réplica desmonta la app (cierra el SSE) y la vuelve
   a montar contra la otra. Un nombre que `edge` no conoce (`404 replica_not_found`) quita el
   fragmento y vuelve a la réplica por defecto.
5. **Web: selector y vista de réplicas.** Con más de una réplica, la cabecera tiene un
   selector con el estado de cada una. La pestaña "Réplicas" del panel lateral, y la pantalla
   de nueva sesión, muestran todas las réplicas con su sesión (repo, rama, PR, estado), un
   botón para abrir cada una y "Nueva sesión en una réplica libre", que lleva a la primera
   libre. La web no crea la sesión por su cuenta: lleva a la réplica y allí se usa el
   formulario de siempre (si otra sesión la ocupa entretanto, el formulario muestra el `409`).
6. **Sin cambios en `edge` ni en el gateway.** La web la sigue sirviendo la réplica por
   defecto bajo `/ui/`.

## Consecuencias
- (+) Ningún cambio en la entrada de `edge` ni en el contrato `edge` ↔ gateway (ADR-0008).
- (+) Varias pestañas pueden seguir varias réplicas a la vez con el mismo token.
- (−) Con `curl` no hay asignación automática: hay que mirar `GET /replicas` y elegir.
- (−) Dos clientes pueden competir por la misma réplica; el `409` lo resuelve, a costa de un
  intento más.
- (−) Si la réplica por defecto no está levantada, la web no carga (la sirve ella), aunque las
  demás funcionen; con el CLI sí se puede trabajar con ellas.
- (−) La vista de sesiones muestra la sesión actual de cada réplica, no su historial: el
  historial sigue siendo por réplica.

## Actualizaciones a otros ADR
- ADR-0012 §7: el selector de réplica en la web ya existe (este ADR); la asignación automática
  y la vista de sesiones también.
