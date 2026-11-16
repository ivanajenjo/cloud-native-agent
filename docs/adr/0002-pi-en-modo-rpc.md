# ADR-0002: Ejecutar Pi en modo RPC como subproceso del gateway

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
El gateway (API REST) debe controlar una sesión de Pi: enviar prompts, recibir eventos en
streaming, abortar y atender preguntas al usuario (`ask_user`). Pi ofrece dos formas de
integrarse desde TypeScript: el SDK en el mismo proceso (`createAgentSession`) o el modo
RPC (`pi --mode rpc`, JSONL por stdin/stdout).

## Decisión
Lanzar `pi --mode rpc` como subproceso y hablar con él mediante un cliente RPC propio.

## Motivos
- El modo RPC ya implementa el protocolo de diálogos de extensiones
  (`extension_ui_request` / `extension_ui_response` para `select`, `confirm`, `input`,
  `editor`): `ask_user` y las confirmaciones de push/PR salen gratis.
- Aislamiento: si el agente se cuelga o consume demasiada memoria, se mata y reinicia
  sin tumbar la API ni perder el buffer de eventos.
- El mismo protocolo sirve si en el futuro el agente corre en otro pod.

## Consecuencias
- Hay que escribir un parser JSONL estricto (separar solo por `\n`; `readline` de Node no
  sirve porque corta en U+2028/U+2029).
- El cliente RPC incluido en Pi no se exporta desde el paquete ni gestiona los diálogos de
  extensiones, así que mantenemos el nuestro.
- Pequeño coste de arranque del proceso por sesión (aceptable con 1 sesión por réplica).
