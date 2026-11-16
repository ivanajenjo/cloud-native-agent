# ADR-0003: Una sesión por réplica; gateway y agente en el mismo contenedor

- Estado: aceptado
- Fecha: 2026-11-16

## Contexto
El sistema debe funcionar en una Raspberry Pi 4 (8 GB) y en un MacBook con Docker, sin
Kubernetes, y también en un clúster local. Es de uso personal. Los builds de Java, Node,
Python y Go consumen bastante memoria y CPU.

## Decisión
Cada réplica es un único contenedor (gateway + Pi + toolchains) que atiende como máximo
**una** sesión a la vez. Si se intenta abrir otra, la API responde `409 Conflict`. Para tener
sesiones en paralelo se levantan más réplicas (servicios en compose, `replicas` en k8s).

Se descarta que el gateway cree contenedores o pods por sesión montando el socket de
Docker (equivale a dar root al agente) o usando la API de Kubernetes (no funciona solo con Docker).

## Consecuencias
- (+) Despliegue trivial: `docker compose up` en la Raspberry o en el Mac.
- (+) Aislamiento entre sesiones: cada una tiene su contenedor, workspace y límites de recursos.
- (+) La API es simple (`/session` en singular).
- (−) Para ver todas las sesiones en un solo sitio hará falta un "hub" ligero que conozca
  las réplicas (fase 5).
- (−) Cada réplica ocupa memoria aunque esté libre (unos cientos de MB en reposo).

## Actualización (ADR-0004)
Una réplica pasa a estar formada por dos contenedores: `agent` (gateway + Pi + toolchains)
y `edge` (proxy de entrada/salida). Sigue siendo una unidad de despliegue con una sesión
como máximo.

## Actualización (ADR-0006)
`edge` valida el Bearer y decide las preguntas de red; el resto sigue en el gateway.
