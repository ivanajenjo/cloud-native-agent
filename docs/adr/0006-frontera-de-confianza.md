# ADR-0006: Seguridad proporcionada a un proyecto personal

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
El gateway, Pi y los comandos que lanza el agente comparten contenedor y usuario. Un
agente bajo inyección de prompt puede leer cualquier variable de entorno del contenedor
y llamar a cualquier servicio que este alcance. Con eso podría:
- usar `AGENT_API_TOKEN` para contestar sus propias preguntas, incluidas las de red;
- usar `GITHUB_TOKEN` para hacer `git push` sin pasar por la tool que pide confirmación;
- editar la allowlist de red si se guarda en `/data`.

Se valoró sacar todos los secretos del contenedor y hacer de `edge` un intermediario de
credenciales (proxy inverso de git con filtro de ramas, de la API de GitHub y de los
proveedores LLM, más un gestor de aprobaciones). Cierra todos los casos, pero multiplica
el tamaño de `edge` y es desproporcionado para un proyecto personal de un solo usuario.

## Decisión
Se aplican solo las medidas que no añaden piezas:
1. `edge` valida el Bearer al reenviar al gateway. El contenedor del agente no recibe
   `AGENT_API_TOKEN`.
2. Las preguntas de red las decide `edge`: las publica a través del gateway para que
   salgan por SSE, pero recoge él la respuesta al pasar por la API. La política, *permitir
   siempre* y el registro de red se guardan en el volumen de `edge`.
3. `GITHUB_TOKEN` y las API keys se quedan en el contenedor del agente.

## Riesgos aceptados
- Las confirmaciones de push/PR, el modo plan y la extensión `guard` frenan despistes del
  modelo, pero un agente hostil puede saltárselas: tiene el token y `bash`.
- Un agente hostil puede gastar con las API keys o enviarlas a un dominio permitido.
- El gateway no se autentica dentro de la red interna.

## Mitigaciones baratas
- PAT fine-grained solo para los repos que se usen, sin permiso *Workflows*.
- Ruleset de GitHub que proteja la rama base: es la barrera real contra un push indebido.
- Límite de gasto en las cuentas de los proveedores.
- El gateway sustituye los valores de los secretos conocidos en eventos y logs.

## Consecuencias
- (+) `edge` sigue siendo pequeño: entrada con Bearer y proxy de salida con política.
- (+) El agente no puede abrirse la red a sí mismo, que es lo que más limita el daño.
- (−) "Nunca push a la rama base" depende del ruleset de GitHub, no de este sistema.
- La inyección de credenciales en `edge` queda en el backlog por si el uso cambia.
