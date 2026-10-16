# Project Map

Memoria operativa rápida para cargar contexto del repo sin releer toda la documentación.

## Qué es

`open-agent-bridge` es un hub local para descubrir agentes por proyecto, enviarles tareas por A2A/JSON-RPC, retransmitir eventos en tiempo real y exponer esa red como herramientas MCP para Claude Code, Codex, OpenCode, pi y Antigravity (`agy`).

Tiene dos superficies principales:

- Backend TypeScript con CLI, registry, agentes, clientes y adaptador MCP.
- Dashboard Vue 3 para visualizar agentes, trazas y conversaciones de canal.

## Mapa del sistema

### 1. Registry

Centro de descubrimiento y coordinación.

Responsabilidades:

- registrar y desregistrar agentes y sesiones cliente
- recibir heartbeat y marcar salud
- emitir snapshot y eventos por WebSocket
- recibir `task.update` desde agentes
- centralizar mensajería de canal y ACKs
- servir el dashboard compilado si existe

Hotspots:

- `src/registry/server.ts`
- `src/registry/store.ts`
- `src/registry/channel-store.ts`
- `src/registry/events.ts`

Notas reales:

- el registro de agentes vive en memoria del proceso
- las conversaciones de canal persisten en `.open-agent-bridge/registry.sqlite`
- el WebSocket del registry es la fuente de verdad para dashboard y bridge MCP

### 2. Agent Runtime

Cada proyecto local puede levantar un `AgentServer`.

Responsabilidades:

- detectar tipo de proyecto y framework aproximado
- generar `AgentCard`
- exponer `GET /.well-known/agent.json`
- exponer JSON-RPC en `POST /`
- exponer `GET /health`
- exponer `POST /ag-ui` para SSE compatible con AG-UI
- mantener registro y heartbeat en el registry
- resolver tareas hacia skills

Hotspots:

- `src/agent/server.ts`
- `src/agent/handlers.ts`
- `src/agent/card.ts`
- `src/agent/project-detector.ts`

Notas reales:

- el runtime usa `RequestRouter` + `TaskStore`
- la inferencia de skill desde lenguaje natural es heurística
- el flujo A2A principal es `tasks/send`; `sendSubscribe` sigue incompleto

### 3. Skills

Framework simple con registro por `Map` y skills builtin.

Responsabilidades:

- definir input schema con Zod
- ejecutar trabajo sobre el proyecto
- traducirse a `AgentSkill` para el `AgentCard`

Hotspots:

- `src/skills/framework.ts`
- `src/skills/index.ts`
- `src/skills/builtins/file-search.ts`
- `src/skills/builtins/code-query.ts`
- `src/skills/builtins/endpoint-find.ts`
- `src/skills/builtins/dynamic-project-skills.ts`

Skills relevantes hoy:

- `file-search`
- `code-query`
- `endpoint-find`
- `prompt-execute`
- `notify-claude`
- `shell-execute`
- `claude-execute` y skills dinámicas cuando se usa modo Claude

### 4. MCP Bridge

`McpAgentBridge` adapta el estado del registry y los canales a herramientas MCP.

Responsabilidades:

- autoarrancar registry/agente local en modo `mcp start` si hace falta
- registrar meta-tools MCP
- opcionalmente registrar tools por skill/agente
- gestionar sesiones cliente por channels
- resolver perfiles de cliente (Claude Code, Codex, OpenCode, pi, Antigravity)
- entregar cada mensaje como turno nuevo en la sesión viva del cliente (`deliverChannelMessage`)

Hotspots:

- `src/mcp/adapter.ts`
- `src/mcp/config.ts`
- `src/client/claude-inbox-socket.ts` (Claude Code ≥ 2.1.224)
- `src/client/codex-daemon-socket.ts` (Codex ≥ 0.162, app-server daemon)
- `src/client/host-inbox-socket.ts` + `src/client/opencode-plugin/` + `src/client/pi-extension/` (OpenCode, pi)
- `src/client/antigravity-ls-client.ts` + `src/cli/commands/antigravity.ts` (agy: `attach` y hooks)
- `src/client/channel-client-runtime.ts`

Notas reales:

- la capa MCP no es el núcleo, es un adaptador
- todos los clientes reciben el mensaje como turno nuevo; cambia la pieza que inicia el turno:
  - Claude Code: el socket de inbox que exporta a sus procesos hijos;
  - Codex: el daemon de app-server (`oab codex start` queda para headless o Codex viejo);
  - OpenCode y pi: su plugin / extensión escucha un socket `inbox-<pid>[-<dirhash>].sock` y el adapter (hijo del agente) escribe ahí;
  - agy: el agente de agy corre `open-agent-bridge antigravity attach` una vez (el hook SessionStart se lo pide) y el adapter usa el language server con `SendUserCascadeMessage`
- si la entrega falla en Codex/OpenCode/pi/agy el mensaje queda pendiente y se reintenta

### 5. Dashboard

SPA Vue 3 conectada al registry.

Responsabilidades:

- mostrar agentes y salud
- mostrar trazas `task.update`, `channel.message` y `channel.ack`
- permitir chat dirigido a sesiones cliente pasivas
- mostrar detalle de agentes

Hotspots:

- `dashboard/src/stores/registry.ts`
- `dashboard/src/stores/trace.ts`
- `dashboard/src/stores/chat.ts`
- `dashboard/src/lib/channel-chat-session.ts`
- `dashboard/src/views/DashboardView.vue`
- `dashboard/src/views/ChannelsView.vue`

Notas reales:

- el dashboard consume sobre todo el WebSocket del registry
- el panel de chat está orientado a sesiones cliente, no a agentes ejecutables

## Flujo principal

### Descubrimiento

1. `RegistryServer` arranca en `localhost:4999`.
2. Un `AgentServer` arranca en un proyecto local.
3. El agente detecta proyecto, construye `AgentCard` y se registra en `/agents`.
4. El agente manda heartbeat periódico.
5. Dashboard y bridge MCP consumen `/ws` y mantienen snapshot local.

### Ejecución de tarea

1. Un cliente resuelve el agente objetivo.
2. Envía `tasks/send` por JSON-RPC al agente.
3. `RequestRouter` crea task, marca `working` y decide skill.
4. La skill ejecuta sobre el proyecto.
5. `TaskStore` marca `completed` o `failed`.
6. El agente publica `task.update` al registry.
7. El registry retransmite ese evento por WebSocket.

### Mensajería de canal

1. Un agente o bridge publica `POST /channel/messages`.
2. `ChannelStore` persiste mensaje y conversación.
3. El registry emite `channel.message`.
4. Un cliente puede responder con `reply` o registrar ACKs.
5. `POST /channel/acks` actualiza el estado visible de entrega.

### Activación por cliente

1. `channels` sigue siendo transporte + persistencia.
2. El adapter de cada sesión recibe `channel.message` por WS (o en el sync del registry) y llama a `deliverChannelMessage`.
3. Arma el prompt con `buildInjectionPrompt` (incluye la llamada a `reply` con los IDs) y lo entrega como turno nuevo:
   - Claude Code → socket de inbox; Codex → daemon de app-server; OpenCode / pi → socket de inbox del host; agy → language server (tras `attach`).
4. El ACK `displayed_to_client` sale cuando la entrega se acepta; si falla (Codex/OpenCode/pi/agy), el mensaje queda pendiente.
5. El agente responde con `reply`, que llega al emisor como turno nuevo.
6. Legacy: `codex tmux-sidecar` / `oab codex start` siguen para Codex headless o < 0.162.

## Dónde tocar según el cambio

### Si cambia el protocolo o contratos

Entrar primero a:

- `src/types/messages.ts`
- `src/types/a2a.ts`
- `src/types/jsonrpc.ts`

### Si cambia el lifecycle de tareas o el routing

Entrar primero a:

- `src/agent/handlers.ts`
- `src/agent/server.ts`

### Si cambia descubrimiento, heartbeat o relay del registry

Entrar primero a:

- `src/registry/server.ts`
- `src/registry/store.ts`
- `src/registry/events.ts`

### Si cambia mensajería conversacional

Entrar primero a:

- `src/registry/channel-store.ts`
- `src/client/channel-client-runtime.ts`
- `src/mcp/adapter.ts`

### Si cambia integración MCP o comportamiento por cliente

Entrar primero a:

- `src/mcp/adapter.ts`
- `src/client/client-profile-resolver.ts`
- `src/client/profiles/*`
- `src/mcp/proxies/*`

### Si cambia UI o observabilidad

Entrar primero a:

- `dashboard/src/stores/*`
- `dashboard/src/views/*`
- `dashboard/src/components/*`

## Comandos mínimos

Instalación:

```bash
pnpm install
cd dashboard && pnpm install
```

Backend:

```bash
pnpm run dev -- registry start
pnpm run dev -- start .
pnpm run dev -- list
pnpm run dev -- ask <agent> "project info"
```

Dashboard:

```bash
pnpm run dev:dashboard
```

MCP:

```bash
pnpm run dev -- mcp start
```

## Limitaciones actuales

- el sistema está diseñado para uso local en `localhost`
- no hay autenticación ni endurecimiento serio de seguridad
- `tasks/sendSubscribe` y el streaming A2A no están cerrados end-to-end
- `StateGraph` existe pero no es el motor principal del runtime hoy
- no hay suite fuerte de tests automatizados; la verificación real es por builds y pruebas manuales
- hay mezcla de estado en memoria y persistencia puntual de channels

## Lecturas de apoyo

Leer según necesidad:

- `README.md` para uso general
- `docs/architecture.md` para detalle técnico del backend
- `docs/cli-and-operations.md` para operación
- `dashboard/ARCHITECTURE.md` para detalle del frontend
- `MESSAGING_IMPLEMENTATION.md` si el cambio toca channels o perfiles de cliente
- `.codex/README.md` y `.codex/config.toml` para la capa Codex
