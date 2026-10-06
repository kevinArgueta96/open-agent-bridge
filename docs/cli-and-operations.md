# CLI y Operación

## Resumen

La CLI pública se registra en [`src/cli/index.ts`](../src/cli/index.ts) y se distribuye bajo los binarios `open-agent-bridge` y su alias corto `oab`.

En desarrollo, los ejemplos de este documento usan:

```bash
pnpm run dev -- <comando>
```

Con build compilado e instalada globalmente (`bash bin/install.sh` o `npm install -g .`), el equivalente es:

```bash
open-agent-bridge <comando>
oab <comando>                 # alias corto, idéntico
```

## Instalación (poner `oab` en el PATH)

Dos rutas según el punto de partida:

```bash
# Ruta A — desde cero
git clone <repo-url> && cd open-agent-bridge
bash bin/install.sh            # pnpm install + build:all + npm install -g .
oab doctor

# Ruta B — repo ya clonado
cd open-agent-bridge
pnpm install && pnpm run build:all && npm install -g .
```

`bin/install.sh` verifica que `oab` quede en el PATH; si no, imprime la línea `export PATH=...` a agregar en tu `~/.bashrc`/`~/.zshrc`. En modo contributor podés seguir usando `pnpm run dev -- <comando>` sin instalar global.

## Comandos de baja fricción (setup y ciclo de vida)

### `init`

Wizard de configuración para un proyecto. Detecta el cwd, pregunta `identity` y clientes, escribe/mergea `.mcp.json` (inyectando `AGENT_BRIDGE_IDENTITY`), levanta el registry como daemon y configura clientes de plugin (OpenCode/Antigravity).

Opciones: `--identity <id>`, `--client <name>` (repetible o separado por comas), `--project <path>`, `-p, --port <number>`, `--mode <linked|local>`, `-y, --yes` (no interactivo).

```bash
oab init                                  # interactivo
oab init --yes --identity dev --client claude   # scripting/CI
```

### `up` / `down` / `status`

Gestionan el registry como **daemon en background** (reemplaza tener una terminal dedicada). El PID y el puerto se guardan en `.open-agent-bridge/registry.json`. `up` es idempotente (health-first: reusa un registry ya levantado). `down` apunta al puerto persistido y limpia PID stale.

```bash
oab up [--port 4999]      # arranca en background (idempotente)
oab status                # salud + agentes + .mcp.json
oab down                  # detiene el daemon
```

### `claude`

Lanza Claude Code cableado al bridge: asegura registry + `.mcp.json`, setea `AGENT_BRIDGE_IDENTITY`/`AGENT_BRIDGE_PROJECT`, y hace `spawn` de `claude` (sin flag dangerous: la entrega usa el inbox socket nativo de Claude Code ≥ 2.1.224; `--legacy-channels` fuerza `--dangerously-load-development-channels server:open-agent-bridge`). Flags extra se pasan tal cual a `claude`.

```bash
oab claude --identity dev [--project <path>] [--port 4999] [-- <flags de claude>]
```

### `doctor`

Diagnóstico sin abortar: Node ≥ 22, `oab` en PATH, registry alcanzable, `.mcp.json` presente + identity, y binarios de cliente (`claude`/`codex`/`opencode`/`agy`). Soporta `--json`.

```bash
oab doctor
```

## Comandos principales

### `start [path]`

Arranca un agente para el directorio indicado.

Opciones:

- `-p, --port <number>`: puerto deseado
- `--registry`: arranca el registry en lugar de un agente
- `--mcp`: arranca el adaptador MCP en `stdio`
- `--registry-url <url>`: URL del registry

Ejemplos:

```bash
pnpm run dev -- start .
pnpm run dev -- start /ruta/al/proyecto --port 5007
pnpm run dev -- start . --registry-url http://localhost:4999
```

Comportamiento:

- si `--registry` esta activo, crea `RegistryServer`
- si `--mcp` esta activo, crea `McpAgentBridge`
- si no, crea `AgentServer`

### `registry start`

Arranca el registry HTTP/WS.

Opciones:

- `-p, --port <number>`: puerto del registry, default `4999`
- `-d, --daemon`: corre detached en background y retorna de inmediato (equivalente a `oab up`)

Ejemplo:

```bash
pnpm run dev -- registry start
oab registry start --daemon
```

### `registry stop`

Detiene el daemon del registry (lee `.open-agent-bridge/registry.json`). Equivalente a `oab down`.

```bash
oab registry stop
```

### `registry status`

Consulta `GET /health` del registry.

Opciones:

- `--registry-url <url>`: default `http://localhost:4999`

Ejemplo:

```bash
pnpm run dev -- registry status
```

### `list`

Lista los agentes activos.

Opciones:

- `--skill <tag>`: filtra por tag o `skill.id`
- `--project <path>`: filtra por nombre o path de proyecto
- `--json`: salida JSON
- `--registry-url <url>`

Ejemplos:

```bash
pnpm run dev -- list
pnpm run dev -- list --skill endpoint-find
pnpm run dev -- list --project billing
pnpm run dev -- list --json
```

### `health [agent-id]`

Verifica salud de un agente concreto o de todos.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplos:

```bash
pnpm run dev -- health
pnpm run dev -- health 7c3cc0aa
```

Comportamiento:

- primero consulta el registry
- luego llama `GET /health` de cada agente
- marca como `unreachable` si el agente no responde

### `ask <agent-id> <message>`

Envia una tarea a un agente.

Opciones:

- `--skill <id>`: fuerza una skill concreta
- `--json`
- `--stream`: declarado en CLI, pero el flujo streaming no esta implementado end-to-end
- `--registry-url <url>`

Ejemplos:

```bash
pnpm run dev -- ask billing-api "find payment endpoint"
pnpm run dev -- ask billing-api "list files" --skill file-search
pnpm run dev -- ask 7c3cc0aa "auth route" --skill endpoint-find
```

Resolución del agente:

- intenta `registry.getAgent(agentId)`
- si falla, busca por nombre parcial o prefijo de `agentId`

### `find <query>`

Busca agentes por skill o proyecto.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplos:

```bash
pnpm run dev -- find endpoint-find
pnpm run dev -- find billing
```

### `delegate <skill-id> <message>`

Busca agentes saludables con una skill y usa el primero disponible.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplo:

```bash
pnpm run dev -- delegate code-query "search for paymentRetry"
```

Comportamiento actual:

- filtra por `healthy: true`
- toma `agents[0]`
- no aplica ranking adicional

### `broadcast <message>`

Envia la misma tarea a todos los agentes saludables.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplo:

```bash
pnpm run dev -- broadcast "project info"
```

La salida usa `Promise.allSettled`, por lo que cada agente puede fallar sin abortar todo el broadcast.

## MCP

### `mcp start`

Arranca `McpAgentBridge` en `stdio`.

Opciones:

- `--registry-url <url>`
- `--project <path>`
- `--no-auto`
- `--no-skill-tools`

Ejemplo:

```bash
pnpm run dev -- mcp start
```

Auto mode actual:

- si no hay registry en `localhost:4999`, arranca uno embebido
- si no hay agentes saludables, arranca un agente local para `cwd` o `AGENT_BRIDGE_PROJECT`

### `mcp server`

Arranca el adaptador MCP en HTTP/SSE.

Opciones:

- `-p, --port <number>`: default `6000`
- `--registry-url <url>`

Ejemplo:

```bash
pnpm run dev -- mcp server --port 6000
```

Endpoints expuestos:

- `GET /`
- `GET /mcp`
- `POST /mcp/message`

### `mcp config`

Imprime o escribe/mergea la entrada `.mcp.json`. El merge es no destructivo (preserva otros `mcpServers`).

Opciones:

- `--write`: escribe/mergea `.mcp.json` en el cwd
- `--identity <id>`: inyecta `AGENT_BRIDGE_IDENTITY` en `env` (default `global`, que se omite)
- `--global`: invoca el binario por nombre (`open-agent-bridge`) — para instalación global/linked
- `--local`: invoca `node <dist>/cli/index.js` — sin instalación global

Si no se pasa `--global` ni `--local`, se autodetecta: `linked` si `oab`/`open-agent-bridge` está en el PATH, si no `local`.

Ejemplos:

```bash
oab mcp config                              # imprime (autodetecta modo)
oab mcp config --write --identity dev       # escribe/mergea con identity
oab mcp config --write --global             # fuerza comando por nombre de binario
```

### `mcp status`

Muestra:

- agentes saludables conectados
- meta-tools MCP
- tools por agente/skill
- resources disponibles

Ejemplo:

```bash
pnpm run dev -- mcp status
```

## Dashboard

### `dashboard`

Imprime la URL del dashboard y, salvo que se desactive, intenta abrir el navegador.

Opciones:

- `--no-open`
- `--port <number>`: default `4999`

Ejemplo:

```bash
pnpm run dev -- dashboard --no-open
```

## Operación típica

### Flujo mínimo

```bash
pnpm run dev -- registry start
pnpm run dev -- start .
pnpm run dev -- list
pnpm run dev -- ask <agent-id> "project info"
```

### Flujo con dashboard

Terminal 1:

```bash
pnpm run dev -- registry start
```

Terminal 2:

```bash
pnpm run dev -- start .
```

Terminal 3:

```bash
pnpm run dev:dashboard
```

## Señales operativas importantes

- El registry y los agentes hacen bind en `localhost`.
- El registry no persiste datos; reiniciar el proceso limpia el estado.
- El dashboard servido por el registry requiere que exista `dashboard/dist`.
- `build:all` copia `dashboard/dist` a `dist/dashboard`, pero el registry en runtime consulta `../../dashboard/dist` relativo al archivo compilado. En la práctica conviene compilar el dashboard en su carpeta original antes de usar `/dashboard`.

## Errores y limitaciones frecuentes

- Si `list`, `find`, `health`, `delegate` o `broadcast` fallan, primero valida que el registry este arriba.
- Si un agente aparece en el registry pero `health` lo marca como `unreachable`, valida que siga escuchando en su puerto.
- `ask --stream` no debe documentarse como funcional; hoy solo existe la bandera en la CLI.
- No hay selección inteligente de agente en `delegate`; solo usa el primer match saludable.
