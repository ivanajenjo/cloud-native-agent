# ADR-0001: Usar Pi como dependencia y ampliarlo con extensiones

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
Queremos un agente de programación que funcione en contenedores. Pi
(`@mariozechner/pi-coding-agent`) es un agente mínimo en TypeScript, multiproveedor, con
modos headless (print, JSON, RPC), SDK y un sistema de extensiones (tools, hooks sobre
tool calls, diálogos de UI, proveedores personalizados). Es un proyecto muy activo.

## Decisión
Instalar Pi como dependencia npm con versión fijada y ampliarlo exclusivamente mediante
extensiones, prompt de sistema adicional y `models.json`. No hacemos fork.

## Consecuencias
- (+) Recibimos mejoras de Pi actualizando la versión.
- (+) Nuestro código se limita a la capa cloud native (API, sesiones, contenedor) y a las extensiones.
- (−) Dependemos de la estabilidad de la API de extensiones y del protocolo RPC: hay que
  fijar versión y tener tests de integración que detecten roturas al actualizar.
- Si alguna necesidad no se puede cubrir con extensiones, se reevaluará (fork o PR upstream).
