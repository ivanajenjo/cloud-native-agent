# ADR-0008: Contrato interno entre `edge` y el gateway para la red

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
ADR-0006 decide que las preguntas de red las decide `edge`, que las publica a través del
gateway para que salgan en el mismo flujo SSE, y que la respuesta la recoge `edge` al pasar
por la API. No fija cómo habla `edge` con el gateway ni cómo sabe si hay sesión activa.
Además, la excepción para los destinos internos de `providers.yaml` (Ollama en la LAN) no
puede depender de lo que diga el contenedor del agente.

## Decisión
1. **Endpoints internos del gateway** (solo en la red interna, sin autenticación, como el
   resto del gateway; ADR-0006):
   - `POST /internal/questions` `{question}`: publica una pregunta `network` en el SSE y la
     añade a las pendientes. `201` si se publica; `409 {"error":"no_session"}` si no hay
     sesión activa (`cloning`, `running`, `waiting_input` o `ready`), y entonces `edge` deniega.
   - `POST /internal/questions/:id/resolved` `{outcome}`: la quita de las pendientes y emite
     `question_resolved`. `204`; `404` si no la conoce.
   - `POST /internal/network` `{entry}`: emite el evento SSE `network`. `204` siempre (sin
     sesión, se descarta).
2. **`edge` nunca reenvía `/internal/*`** desde su entrada: responde `404`.
3. **Respuestas a preguntas de red:** `edge` atiende `POST /session/answers/net-*` sin
   reenviarlo al gateway. Valida el cuerpo como cualquier respuesta (`{value}` con
   `allow_once`, `allow_always` o `deny`), resuelve la pregunta y avisa al gateway.
4. **`providers.yaml` se monta en solo lectura en los dos contenedores.** `edge` lo lee
   para saber qué `host:puerto` de proveedores se permiten aunque sean destinos internos o
   puertos distintos de 80/443. El parser y su esquema viven en `@cna/shared`.
5. Los tipos de estos cuerpos viven en `@cna/shared` (`internal.ts`).

## Consecuencias
- (+) `edge` sigue siendo la única pieza que decide la red; el gateway solo muestra.
- (+) Un único flujo SSE para el cliente, con todas las preguntas.
- (−) Un agente hostil puede llamar a `/internal/*`: como mucho muestra preguntas falsas
  (cuya respuesta no abre nada, porque `edge` no las conoce) u oculta las de verdad (que
  acaban denegadas por timeout). Falla cerrado.
- (−) Si el gateway no responde, `edge` trata la pregunta como "sin sesión" y deniega.

## Actualización (ADR-0012)
`edge` usa este contrato con el gateway de la réplica que abrió cada conexión. El cuerpo de
`POST /internal/network` admite el campo opcional `replica`.
