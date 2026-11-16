# Fase 1.5 — Consolidación: especificación de las tareas

Detalle de la fase 1.5 de [`PLAN.md`](PLAN.md#fases). Son mejoras detectadas al revisar la
fase 1 (commit `1129b94`). No añaden funcionalidad ni cambian la API: dejan la base lista
para la fase 2. Este documento está escrito para retomarlo en frío: cada tarea dice qué
hay hoy, qué se quiere, qué ficheros se tocan y cuándo está terminada.

Reglas comunes:
- Una tarea = un commit (Conventional Commits en español).
- Terminada solo si `npm run typecheck`, `npm run lint` y `npm test` pasan.
- No se debilita ni se salta ningún test existente.
- Al cerrar cada tarea, márcala aquí como hecha; al cerrar la fase, actualiza el estado del
  README y borra la mención a la fase 1.5.

| # | Tarea | Necesita Docker | Depende de | Estado |
|---|---|---|---|---|
| 1 | Verificar las imágenes y la salida por el proxy | sí | — | pendiente |
| 2 | Fijar las versiones de los toolchains | sí | 1 | pendiente |
| 3 | Partir `SessionManager` | no | — | pendiente |
| 4 | Test conjunto de `edge` y gateway | no | — | pendiente |
| 5 | Aclarar la versión de Node en ADR-0005 | no | — | hecha |

Las tareas 3, 4 y 5 son independientes de las 1 y 2 y se pueden hacer antes. La 3 y la 4
no comparten ficheros.

---

## 1. Verificar las imágenes y la salida por el proxy

**Por qué.** La revisión de la fase 1 solo ejecutó `typecheck`, `lint` y `test`. Nadie ha
comprobado desde entonces que las imágenes construyen ni que la allowlist base del código
coincide con lo que los toolchains necesitan de verdad. Desde la fase 1 el modo por
defecto es `ask`, así que un host que falte en la allowlist se convierte en una pregunta
de red en mitad de un build.

**Pasos** (en una máquina con Docker; idealmente también en la Raspberry, arm64):

```sh
cp deploy/compose/.env.example deploy/compose/.env    # AGENT_API_TOKEN y GITHUB_TOKEN
docker compose -f deploy/compose/docker-compose.yml up --build -d

# Modo audit para ver todos los hosts sin que se queden esperando una pregunta
docker compose -f deploy/compose/docker-compose.yml exec edge \
  sh -c 'echo "{\"mode\":\"audit\",\"allow\":[]}" > /edge-data/policy.json'
docker compose -f deploy/compose/docker-compose.yml restart edge

scripts/verify-egress.sh | tee verify-egress.log

# Volver al modo por defecto
docker compose -f deploy/compose/docker-compose.yml exec edge rm /edge-data/policy.json
docker compose -f deploy/compose/docker-compose.yml restart edge
```

**Qué revisar en la salida.**
- Todas las comprobaciones en `PASS` (código de salida 0).
- La lista final de `host:puerto`. Compararla con `BASE_ALLOWLIST` en
  `packages/edge/src/egress/allowlist.ts` y con la lista de "Control de red saliente" de
  `PLAN.md`:
  - host usado que no está en la lista → añadirlo en los dos sitios;
  - host de la lista que ningún toolchain usa → quitarlo de los dos sitios.
- Comprobar además a mano el camino feliz de la fase 1 con un repo de prueba: crear sesión,
  responder una pregunta, commit y push de la rama (los `curl` están en el README).

**Ficheros que puede tocar:** `packages/edge/src/egress/allowlist.ts`, su test
(`packages/edge/test/egress-allowlist.test.ts`) y `docs/PLAN.md`. Si falla el build, el
`Dockerfile` correspondiente.

**Hecho cuando:** el script termina sin fallos en amd64 (y en arm64 si se prueba en la
Raspberry), y la allowlist del código y la del plan coinciden con lo observado.

---

## 2. Fijar las versiones de los toolchains

**Por qué.** `docker/mise/config.toml` usa versiones mayores y `latest`:

```toml
java = "temurin-21"
maven = "3.9"
gradle = "8"
node = "22"
pnpm = "10"
python = "3.12"
uv = "latest"
go = "latest"
```

Dos builds en fechas distintas dan imágenes distintas, y un cambio de versión mayor de Go
o uv entraría sin avisar. El propio fichero dice que hay que fijarlas tras la verificación.

**Pasos.** Con la imagen de la tarea 1 construida, leer las versiones resueltas:

```sh
docker compose -f deploy/compose/docker-compose.yml exec agent mise ls --current
```

Escribir esas versiones exactas en `docker/mise/config.toml` (por ejemplo
`go = "1.xx.y"`), quitar el comentario que dice que están sin fijar y reconstruir.

**Ficheros:** solo `docker/mise/config.toml`.

**No tocar:** la imagen base `node:22-bookworm-slim` (el Node del sistema ejecuta el
gateway y Pi; fijar su versión menor es otra decisión).

**Hecho cuando:** no queda ningún `latest` ni versión parcial, la imagen construye y
`scripts/verify-egress.sh` sigue pasando.

---

## 3. Partir `SessionManager`

**Por qué.** `packages/gateway/src/session/manager.ts` tiene unas 700 líneas y mezcla
cuatro cosas: la máquina de estados, el arranque en segundo plano, las preguntas
pendientes con sus timeouts y la comprobación del workspace al cerrar. La fase 2 le añade
checkpoints, diff, lista de tareas y registro de tools, todos colgados de los mismos
eventos. Conviene separar antes lo que ya tiene límites claros.

**Qué se extrae.** Es un refactor: no cambia el comportamiento, ni la interfaz
`SessionService` (`session/service.ts`), ni el orden de los eventos SSE.

1. **Preguntas pendientes y timeouts → `session/pending-questions.ts`.**
   Hoy el manager combina `QuestionRegistry` (`session/questions.ts`) con un mapa
   `questionTimers` y los métodos privados `resolveQuestion`, `cancelPiQuestions`,
   `armQuestionTimer`, `expireQuestion`, `clearQuestionTimer` y `clearQuestionTimers`.
   Se agrupan en una clase que es dueña del registro y de los timers:

   ```ts
   export interface PendingQuestionsOptions {
     /** Called once for every question that stops being pending, in order. */
     onResolved(questionId: string, outcome: QuestionOutcome): void;
   }

   export class PendingQuestions {
     constructor(options: PendingQuestionsOptions);
     /** Adds it and arms its timer if question.timeoutMs is set and source is "pi". Throws if the id is pending. */
     add(question: Question, source: QuestionSource): void;
     get(id: string): { question: Question; source: QuestionSource } | undefined;
     list(): Question[];
     readonly size: number;
     wasResolved(id: string): boolean;
     /** Clears the timer, removes it, calls onResolved. false if it was not pending. */
     resolve(id: string, outcome: QuestionOutcome): boolean;
     /** Resolves every pending question of that source (or all) with the outcome. Returns how many. */
     resolveAll(outcome: QuestionOutcome, source?: QuestionSource): number;
   }
   ```

   - El manager pasa `onResolved: (id, outcome) => this.emit({ type: "question_resolved", questionId: id, outcome })`.
   - Un timer que vence resuelve la pregunta con `"timeout"` y después el manager debe
     recalcular el estado (`refreshStatus`), igual que hoy en `expireQuestion`. Pi resuelve
     sus propios diálogos al vencer: **no** se le envía respuesta.
   - Los timers llevan `unref()`: una pregunta pendiente no mantiene vivo el proceso.
   - `QuestionRegistry`, `answerToUiResponse` y `outcomeOfAnswer` se quedan en
     `questions.ts` sin cambios; `PendingQuestions` usa el registro por dentro.

2. **Comprobación del workspace → `workspace/git.ts`.**
   El método privado `assertWorkspaceClean` pasa a ser una función sin estado:

   ```ts
   /** "clean", or why the workspace cannot be discarded. Never throws for a dirty tree. */
   export async function workspaceState(
     git: GitRunner,
     dir: string,
     options: { checkUnpushed: boolean },
   ): Promise<"clean" | "uncommitted" | "unpushed">;
   ```

   Mismos comandos que hoy: `git status --porcelain` y
   `git rev-list --count HEAD --not --remotes=origin`. Si no existe `<dir>/.git`, `"clean"`.
   El manager traduce el resultado a `SessionError("invalid_state", …)` con los mismos
   mensajes (`"uncommitted changes"`, `"commits not pushed"`) y sigue redactando los errores
   de git antes de devolverlos.

**Qué se queda en `manager.ts`:** la máquina de estados (`refreshStatus`, `setStatus`), el
ciclo de vida (`create`, `start`, `failStart`, `close`, `shutdown`), los manejadores de Pi
y `emit`. El arranque en segundo plano no se extrae: depende de casi todo el estado del
manager y separarlo ahora solo movería el acoplamiento de sitio.

**Invariantes que no se pueden romper** (copiar al encargo):
- Todo evento pasa por el redactor antes de llegar al `EventLog` (`emit`).
- Fin de ejecución = `agent_settled`, no `agent_end`.
- `waiting_input` mientras haya al menos una pregunta pendiente, de Pi o de red.
- Al abortar se cancelan solo las preguntas de Pi; las de red son de `edge`.
- Los secretos nunca se escriben en logs ni en eventos.

**Tests.**
- `packages/gateway/test/session-manager.test.ts`, `questions.test.ts`, `app.test.ts`,
  `wiring.test.ts` y `e2e.test.ts` deben pasar **sin modificarse**. Si alguno necesita
  cambios, el refactor ha cambiado comportamiento: parar y revisar.
- Nuevo `packages/gateway/test/pending-questions.test.ts`: añadir y listar en orden; id
  duplicado lanza; `resolve` llama a `onResolved` una sola vez y devuelve `false` la
  segunda; timer que vence resuelve con `"timeout"`; `resolve` antes del vencimiento
  cancela el timer; una pregunta de `edge` con `timeoutMs` no arma timer; `resolveAll`
  por origen deja intactas las del otro; `wasResolved` tras resolver.
- En `packages/gateway/test/workspace-git.test.ts`: `workspaceState` con árbol limpio,
  fichero sin seguimiento, commit sin subir, rama subida, directorio sin `.git`, y
  `checkUnpushed: false` con commits sin subir.

**Hecho cuando:** `manager.ts` ya no contiene timers ni comandos git, y todo pasa.

---

## 4. Test conjunto de `edge` y gateway

**Por qué.** Cada paquete se prueba por separado: `packages/edge/test/wiring.test.ts`
recorre el flujo `ask` contra un gateway **falso**, y los tests del gateway llaman a
`/internal/*` directamente. Nada comprueba que los dos lados del contrato de ADR-0008
encajan de verdad (cuerpos, códigos, ids, orden de los eventos). Hoy eso solo se ve a
mano con Docker.

**Dónde.** Un test nuevo fuera de los paquetes, para no hacer que `edge` dependa del
gateway ni al revés: `tests/integration/edge-gateway.test.ts`. Hay que añadir
`tests/**/*.test.ts` a `include` en `vitest.config.ts` y `tests/**/*.ts` a `include` en
`tsconfig.json`.

**Montaje** (sin Docker, sin red real, sin LLM):
- Gateway real: `createGatewayRuntime` (`packages/gateway/src/wiring.ts`) con `startPi`
  falso y `remoteBase` `file://` apuntando a un repo bare temporal, como hace
  `packages/gateway/test/wiring.test.ts`.
- Edge real: `createEdgeRuntime` (`packages/edge/src/wiring.ts`) con
  - `fetch: (input, init) => gatewayApp.request(input, init)`, de modo que el ingress y el
    cliente interno hablan con la app real del gateway sin abrir puerto;
  - `resolver` falso que resuelve nombres de prueba a una IP pública de documentación;
  - `config` construido a mano con `askTimeoutMs` corto para el caso de timeout.
- El proxy de `edge` sí escucha en un puerto local (`127.0.0.1:0`), y las peticiones
  `CONNECT` se hacen como en el test de `edge` (`openConnect`).
- **Costura necesaria:** `createEdgeRuntime` no deja inyectar la conexión de salida, así
  que una conexión permitida no puede terminar en un servidor local (127.0.0.1 es destino
  interno y se deniega). Añadir a `WiringOptions` un `connect?` opcional que se pasa tal
  cual a `createEgressProxy` (que ya lo admite). El test lo usa para llevar la IP pública
  ya validada a un servidor eco local. Es el único cambio en código de producción.
- Los eventos se leen por el ingress de `edge` (`GET /session/events` con Bearer), para
  cubrir también el paso del SSE.
- Los ayudantes de los tests existentes no están exportados: copiar lo mínimo al test
  nuevo. No refactorizar los tests actuales en esta tarea.

**Casos.**
1. **Preguntar y permitir una vez.** Con sesión activa, `CONNECT` a un host fuera de la
   allowlist → evento `question` con `kind: "network"`, id `net-…` y opciones
   `allow_once`, `allow_always`, `deny`; `GET /session` pasa a `waiting_input` y lista la
   pregunta → `POST /session/answers/<id>` `{"value":"allow_once"}` por `edge` → `204`,
   el `CONNECT` responde `200` y el eco funciona → evento `question_resolved` con
   `outcome: "answered"` y la sesión sale de `waiting_input` → evento `network` con
   `decision: "allow"`, `reason: "user_once"`.
2. **Denegar.** Igual, con `{"value":"deny"}` → `403`, evento `network` con
   `reason: "user_denied"`.
3. **Permitir siempre.** `{"value":"allow_always"}` → `policy.json` contiene el host; un
   segundo `CONNECT` al mismo host no genera pregunta (`reason: "allowlist"`).
4. **Peticiones concurrentes.** Dos `CONNECT` al mismo host y puerto a la vez → una sola
   pregunta en el SSE; la respuesta resuelve las dos.
5. **Sin sesión.** Antes de `POST /session`, `CONNECT` a un host desconocido → `403` sin
   ningún evento `question`; `network.jsonl` registra `reason: "no_session"`.
6. **Timeout.** Nadie responde → `403`, `question_resolved` con `outcome: "timeout"`,
   `reason: "ask_timeout"`.
7. **Respuesta repetida y desconocida.** Responder dos veces el mismo id → `409`
   `question_resolved`; un `net-` inventado → `404` `question_not_found`. En ninguno de los
   dos casos la petición llega al gateway.
8. **`/internal/*` no se reenvía.** `POST /internal/questions` por el ingress de `edge` →
   `404`, con y sin Bearer, y el gateway no publica nada.
9. **El token no llega al gateway.** En una petición reenviada, el gateway no recibe la
   cabecera `Authorization` (se comprueba envolviendo el `fetch` inyectado).

**Invariantes que el test protege** (copiar al encargo):
- Política de red por defecto `ask`; sin respuesta en el timeout o sin sesión → denegar.
- Las preguntas de red las decide `edge`; el gateway solo las muestra.
- `AGENT_API_TOKEN` solo existe en `edge`.
- Nunca llamar a un LLM real en los tests.

**Hecho cuando:** el test pasa dentro de `npm test` y tarda pocos segundos.

---

## 5. Aclarar la versión de Node en ADR-0005

**Por qué.** ADR-0005 termina con "Requiere Node ≥ 22.19", que es lo que exige Pi
(`engines` de `@earendil-works/pi-coding-agent@1.5.2`). El resto del repo exige ≥ 22.21
(`package.json`, `AGENTS.md`, `README.md`, `PLAN.md`) porque `NODE_USE_ENV_PROXY` lo
necesita. No es un error, pero leído suelto parece una contradicción.

**Cambio.** Sustituir esa línea por:

> Pi requiere Node ≥ 22.19; el proyecto exige ≥ 22.21 porque `NODE_USE_ENV_PROXY`
> (ADR-0004) lo necesita.

**Ficheros:** solo `docs/adr/0005-arranque-e-integracion-de-pi.md`.

---

## Revisado y dejado fuera

| Observación | Dónde se resuelve |
|---|---|
| Cambiar el modo de red obliga a editar `policy.json` y reiniciar `edge` | Fase 2, endpoints `/network/*` |
| El replay de eventos vive en memoria (últimos 5000) y un reinicio pierde la sesión | Fase 4 |
| La redacción solo cubre el valor exacto del secreto y su forma URL-encoded | Riesgo aceptado (ADR-0006) |
| Los proveedores integrados de Pi (sin `baseUrl`) generan una pregunta de red la primera vez | Decidido: se mantiene la pregunta |
