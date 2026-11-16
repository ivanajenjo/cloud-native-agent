# ADR-0006: `edge` como única pieza de confianza: autenticación, secretos y aprobaciones

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
El gateway, Pi y los comandos que lanza el agente comparten contenedor y usuario. Un
agente bajo inyección de prompt puede, con `bash`:
- leer cualquier variable de entorno del contenedor (también las del gateway, por
  `/proc/<pid>/environ`), y con `AGENT_API_TOKEN` llamar a la API y aprobar sus propias
  preguntas;
- escribir directamente en el stdin de Pi o manipular el proceso del gateway, de modo que
  tampoco sirve que el gateway "solo acepte peticiones de `edge`";
- usar `GITHUB_TOKEN` para hacer `git push` sin pasar por la tool que pide confirmación;
- editar la allowlist de red si se guarda en `/data`.

Con el diseño anterior, las confirmaciones de push/PR y de red eran orientativas.

## Decisión
1. El contenedor `agent` completo es **no fiable** y **no recibe ningún secreto**.
2. `edge` publica la API, valida el Bearer y sirve la web UI. El gateway escucha sin
   autenticación solo en la red interna.
3. `edge` guarda `GITHUB_TOKEN` y las API keys y los inyecta en upstreams internos
   (`:8081`), a los que el agente habla por HTTP dentro de la red interna:
   - `/git`: proxy inverso de GitHub smart HTTP, limitado al repo de la sesión. En
     `git-receive-pack` solo deja pasar actualizaciones de `refs/heads/agent/*`.
   - `/github`: crear PR y leer comentarios de PR del repo de la sesión.
   - `/llm/<proveedor>` y `/search`: reenvío con la key inyectada.
4. Las aprobaciones de **red**, **push** y **PR** se crean, se exponen (`/approvals`,
   `/edge/events`) y se aplican en `edge`. Sin respuesta en el timeout → denegar.
5. `edge` obtiene la política de la sesión (`repo`, `baseBranch`, `autoPush`) del cuerpo
   de `POST /session` al reenviarlo, nunca del gateway, y la guarda en su propio volumen
   junto con la política y el registro de red.
6. Las notificaciones push las envía `edge`.
7. Las preguntas que resuelve Pi (`ask_user`, plan) y la extensión `guard` se consideran
   ayudas de uso, no barreras de seguridad.

Se descarta separar gateway y Pi en usuarios o contenedores distintos: exige privilegios
para cambiar de usuario o un tercer contenedor por réplica, y no resuelve el problema del
token de GitHub.

## Consecuencias
- (+) "Nunca push a la rama base" y "la red se pregunta" pasan a ser propiedades que se
  cumplen aunque el agente sea hostil.
- (+) Sin secretos en el contenedor no hace falta redactarlos en logs ni eventos, ni
  cuidar que el token no acabe en `.git/config`.
- (+) No se necesita `gh` en la imagen ni excepción de red para Ollama en la LAN.
- (−) `edge` crece: proxy inverso de git con lectura de pkt-lines, cliente de la API de
  GitHub, reenvío de LLM con streaming y gestor de aprobaciones.
- (−) El cliente consume dos flujos SSE (`/session/events` y `/edge/events`).
- (−) Un agente hostil aún puede falsear lo que muestra el gateway (conversación, diff).
  Por eso el diálogo de una aprobación se pinta con los datos de `edge`.
- (−) Un push aprobado sigue pudiendo contener cualquier cosa: la revisión es el PR.
