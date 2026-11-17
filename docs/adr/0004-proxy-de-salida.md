# ADR-0004: Proxy de salida propio con modo `ask` por defecto

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
El agente ejecuta código de los repos, instala dependencias y podrá leer contenido web.
Cualquiera de esas fuentes puede contener inyecciones de prompt que le lleven a contactar
servicios inesperados o a exfiltrar datos. Queremos saber a qué servicios externos
accede y poder controlarlo.

Controlar solo las tools (`web_fetch`, `web_search`) no basta: el agente tiene `bash` y
puede usar `curl`, gestores de paquetes o `git` contra cualquier host.

## Decisión
1. El contenedor del agente se conecta solo a una red interna sin salida a internet.
2. Un contenedor `edge` (TypeScript propio) es la única pieza con acceso externo. Hace de
   - reverse proxy de entrada hacia el gateway (Docker no publica puertos de redes internas), y
   - proxy de salida HTTP `CONNECT` que registra cada conexión y aplica la política.
3. No se intercepta TLS: la política trabaja con dominio y puerto.
4. Modos `ask` (por defecto), `allowlist` y `audit`. En `ask`, un dominio fuera de la
   allowlist se convierte en una pregunta al usuario por la UI (*permitir esta vez*,
   *permitir siempre*, *denegar*). Sin respuesta en el timeout o sin sesión activa → denegar.
5. La allowlist base incluye GitHub, los registries de los cuatro stacks, los proveedores de
   LLM configurados y el buscador de `web_search`. *Permitir siempre* se persiste en disco.

Se descarta Squid/mitmproxy: el modo `ask` necesita integrarse con el gateway y los
eventos SSE, y un proxy `CONNECT` propio es pequeño y queda en el mismo stack.

## Consecuencias
- (+) Visibilidad completa de los destinos de red; fallo cerrado para lo que ignore el proxy.
- (+) Reutiliza el mecanismo de preguntas de `ask_user` en la UI.
- (+) Abre la puerta a inyectar credenciales en el proxy para que el agente no las vea.
- (−) Cada réplica pasa de 1 a 2 contenedores (modifica ADR-0003).
- (−) Java no lee `HTTPS_PROXY`: hay que configurar `JAVA_TOOL_OPTIONS`, Maven y Gradle en la imagen.
- (−) En modo `ask`, una sesión desatendida se bloquea o falla al acceder a dominios nuevos
  hasta el timeout. Se mitiga con una allowlist base amplia y con *permitir siempre*.
- (−) Sin TLS interceptado no se ven URLs ni contenido; la exfiltración por DNS sigue siendo
  posible en teoría (la resolución la hace Docker).
- En Kubernetes, `edge` irá en un Deployment aparte con NetworkPolicy (como sidecar
  compartiría la red del pod y podría esquivarse).

## Actualización (ADR-0006)
- La respuesta a una pregunta de red la recoge `edge` al pasar por la API; el gateway solo
  la muestra. Desaparece el secreto compartido edge ↔ gateway.
- La política, *permitir siempre* y el registro de red se guardan en el volumen de `edge`,
  no en `/data` (el agente podría editarlos).
- El proxy atiende también peticiones HTTP sin `CONNECT`, aplica la política por host y
  puerto, y deniega los destinos internos salvo los hosts de `providers.yaml`.

## Actualización (ADR-0012)
Con varias réplicas hay una red interna por réplica y `edge` está en todas. `edge` identifica la
réplica de cada conexión por su IP de origen y deniega lo que no venga de una (`unknown_client`).
Kubernetes queda en el backlog.
