# ADR-0012: Varias réplicas en Docker con un `edge` compartido

- Estado: aceptado
- Fecha: 2026-11-17

## Contexto
ADR-0003 fija una sesión por réplica y deja para la fase 5 tener varias sesiones en paralelo.
El plan pensaba en Kubernetes (StatefulSet, `edge` en un Deployment con NetworkPolicy y un hub
opcional). Para un uso personal en una Raspberry y un MacBook, Kubernetes no compensa por ahora:
se queda solo Docker.

Hasta ahora `edge` y el gateway van 1:1: `edge` llama a `http://agent:8090` y el agente sale por
`http://edge:3128` (nombre fijo en la imagen, en `settings.xml` de Maven y en
`gradle.properties`). Con varias réplicas hay que decidir cuántos `edge` hay, cómo sabe `edge`
qué réplica abre cada conexión de salida (para preguntarle a ella) y cómo elige el cliente con
qué réplica habla.

## Decisión
1. **Kubernetes pasa al backlog.** La fase 5 es "varias réplicas en Docker".
2. **Un solo `edge` para todas las réplicas.** Una réplica es ahora un contenedor `agent-N`
   (gateway + Pi + toolchains, con su volumen `/data`). Se sigue entrando por un único puerto
   publicado y hay una sola política de red, un solo *permitir siempre* y un solo registro.
3. **Una red interna por réplica.** `agent-N` solo está en `internal-N` (`internal: true`);
   `edge` está en todas y en `external`. Así un agente no alcanza el gateway de otro (que no se
   autentica, ADR-0006) y la IP de origen de una conexión identifica a la réplica. Ningún agente
   gana salida directa (ADR-0004).
4. **`EDGE_REPLICAS`** (sustituye a `GATEWAY_URL`): nombres separados por comas
   (`agent-1,agent-2`), como mucho 16. Cada nombre es el hostname del contenedor y su gateway
   está en `http://<nombre>:8090`. La primera es la réplica por defecto.
5. **Identificación por IP de origen.** Para cada conexión al proxy de salida, `edge` busca qué
   réplica tiene esa dirección resolviendo los nombres de `EDGE_REPLICAS` (con caché; si no la
   encuentra, vuelve a resolver, como mucho una vez por segundo, por si el contenedor se ha
   reiniciado con otra IP). Una conexión que no viene de ninguna réplica se deniega con el motivo
   `unknown_client`, en cualquier modo. La pregunta `network` y el evento `network` van solo al
   gateway de la réplica que abrió la conexión; la entrada del registro lleva `replica`.
   Preguntas concurrentes al mismo destino se comparten solo dentro de la misma réplica.
6. **Entrada:**
   - `GET /replicas` lo responde `edge`: cada réplica con `reachable` y su sesión
     (`GET /session` del gateway, 2 s de timeout).
   - `/replicas/<nombre>/<resto>` se reenvía a esa réplica como `/<resto>`, con las mismas reglas
     que una ruta sin prefijo (`/internal/*` nunca, `/network/*` y las respuestas `net-*` las
     atiende `edge`). Siempre exige el Bearer, también para `/ui`. Nombre desconocido → `404`
     `replica_not_found`.
   - Las rutas sin prefijo van a la réplica por defecto: la web UI y los clientes de antes siguen
     funcionando con ella.
7. **Clientes:** el CLI elige réplica con `--replica <nombre>` o `CNA_REPLICA` y lista las réplicas
   con `cna replicas`. La web UI sigue hablando con la réplica por defecto; un selector de
   réplica en la web queda pendiente.
8. **Compose:** `agent-1` siempre; `agent-2` y `agent-3` con el profile `replicas`. `CNA_REPLICAS`
   en `.env` dice a `edge` cuáles hay (por defecto `agent-1`). Una réplica de `EDGE_REPLICAS` que no
   está levantada sale en `GET /replicas` como `reachable: false`. Más réplicas = copiar el bloque
   de una en el compose con su red y su volumen.

## Consecuencias
- (+) Se mantiene el contrato `edge` ↔ gateway de ADR-0008: cada gateway sigue viendo un solo `edge`.
- (+) Las imágenes no cambian: el agente sigue saliendo por `edge:3128`.
- (+) Una sola URL, un solo token y una sola política de red para todas las sesiones.
- (−) `edge` es punto único de fallo y de carga para todas las réplicas.
- (−) La identificación depende de que las IPs de las redes internas no se puedan falsificar: los
  contenedores no tienen `NET_RAW` (`cap_drop: ALL`).
- (−) *Permitir siempre* desde una réplica vale para todas.
- (−) Añadir réplicas exige editar el compose; no hay asignación automática de réplicas libres ni
  vista de todas las sesiones en la web (antes, "hub").

## Actualizaciones a otros ADR
- ADR-0003: una réplica vuelve a ser un contenedor (`agent-N`); `edge` es compartido.
- ADR-0004: la topología es una red interna por réplica, todas con `edge`.
- ADR-0008: el contrato no cambia; `edge` lo usa con el gateway de la réplica que corresponda y el
  cuerpo de `POST /internal/network` admite el campo opcional `replica`.
