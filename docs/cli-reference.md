# Referencia del CLI — open-agent-bridge

Referencia completa de la interfaz de línea de comandos de `open-agent-bridge`: el hub local de comunicación entre agentes de IA (Claude Code, OpenCode, Codex, Antigravity) sobre MCP + WebSocket.

> El binario se llama `open-agent-bridge`, con el alias corto **`oab`** (idénticos). En esta referencia se usa `oab`. En modo contributor (sin instalación global) el equivalente es `pnpm run dev -- <comando>`.

---

## Tabla de contenidos

- [Instalación](#instalación)
- [Inicio rápido](#inicio-rápido)
- [Conceptos](#conceptos)
- [Comandos de setup y ciclo de vida](#comandos-de-setup-y-ciclo-de-vida)
  - [`init`](#init) · [`up`](#up) · [`down`](#down) · [`status`](#status) · [`claude`](#claude) · [`doctor`](#doctor)
- [Registry](#registry)
  - [`registry start`](#registry-start) · [`registry stop`](#registry-stop) · [`registry status`](#registry-status)
- [MCP](#mcp)
  - [`mcp config`](#mcp-config) · [`mcp start`](#mcp-start) · [`mcp server`](#mcp-server) · [`mcp status`](#mcp-status)
- [Agentes y mensajería](#agentes-y-mensajería)
  - [`start`](#start) · [`list`](#list) · [`health`](#health) · [`ask`](#ask) · [`find`](#find) · [`delegate`](#delegate) · [`broadcast`](#broadcast) · [`prune`](#prune)
- [Integraciones de cliente](#integraciones-de-cliente)
  - [`codex`](#codex) · [`opencode`](#opencode) · [`antigravity`](#antigravity)
- [`dashboard`](#dashboard)
- [Variables de entorno](#variables-de-entorno)
- [Archivos y estado](#archivos-y-estado)
- [Puertos](#puertos)
- [Recetas comunes](#recetas-comunes)
- [Solución de problemas](#solución-de-problemas)

---

## Instalación

Pone `oab` / `open-agent-bridge` en el PATH desde un repo clonado (no se publica a npm todavía).

```bash
# Ruta A — desde cero
git clone <repo-url> && cd open-agent-bridge
bash bin/install.sh          # pnpm install + build:all + npm install -g .
oab doctor

# Ruta B — repo ya clonado
cd open-agent-bridge
pnpm install && pnpm run build:all && npm install -g .
```

`bin/install.sh` verifica que `oab` quede en el PATH; si no, imprime la línea `export PATH=...` y a qué archivo rc agregarla. **Actualizar:** `git pull && pnpm install && pnpm run build:all && npm install -g .`. Prerrequisitos: Node ≥ 22, pnpm ≥ 9, git. Ver detalle en el [README](../README.md).

---

## Inicio rápido

```bash
cd /ruta/a/tu/proyecto
oab init                     # wizard: identity + clientes → .mcp.json + registry
oab claude --identity dev    # lanza Claude cableado al bridge
oab status                   # estado del hub
oab down                     # apaga el registry cuando termines
```

---

## Conceptos

| Concepto | Qué es |
| :--- | :--- |
| **Registry** | Hub central HTTP + WebSocket en `:4999`. Descubre agentes, relaya mensajes, persiste conversaciones (SQLite). Todo cliente se conecta a él. |
| **Identity** | Namespace de canal (`--identity`, default `global`). Sesiones solo ven peers que comparten la misma identity — un muro duro para aislar tickets/agentes concurrentes. |
| **`.mcp.json`** | Config que le dice a un cliente MCP (p. ej. Claude Code) cómo lanzar el adaptador del bridge. `oab` lo genera/mergea con la identity inyectada. |
| **Daemon** | El registry puede correr en background (`oab up`), con PID + puerto persistidos en `.open-agent-bridge/registry.json`. Sin terminal dedicada. |
| **Modo de `.mcp.json`** | `linked` = invoca el binario por nombre (`open-agent-bridge`, requiere instalación global). `local` = `node <dist>/cli/index.js`. Autodetectado según el PATH. |

---

## Comandos de setup y ciclo de vida

### `init`

Configura un proyecto en un solo paso: detecta el cwd, pregunta identity y clientes (wizard interactivo con `@clack/prompts`), escribe/mergea `.mcp.json`, levanta el registry como daemon, configura clientes de plugin (OpenCode/Antigravity reusando sus instaladores), registra el MCP en **Codex** vía `codex mcp add` (Codex ignora `.mcp.json` — solo carga servidores desde `~/.codex/config.toml`; el registro es idempotente: hace `remove` antes de `add`), e imprime los próximos pasos por cliente.

```
oab init [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--identity <id>` | `global` | Namespace de canal a inyectar en `.mcp.json`. |
| `--client <name>` | `[]` | Cliente a configurar: `claude\|codex\|opencode\|antigravity`. Repetible o separado por comas. |
| `--project <path>` | cwd | Proyecto sobre el que operar. |
| `-p, --port <number>` | `4999` | Puerto del registry. |
| `--mode <mode>` | auto | Modo de `.mcp.json`: `linked` o `local`. Auto: `linked` si `oab` está en PATH. |
| `-y, --yes` | — | No interactivo: usa flags/defaults sin preguntar (CI/scripting). |

```bash
oab init                                       # wizard interactivo
oab init --yes --identity dev --client claude  # no interactivo
oab init --yes --client claude,codex --identity ticket-42
```

### `up`

Levanta el registry en background (idempotente, *health-first*: reusa uno ya corriendo). Persiste `{pid, port}` en `.open-agent-bridge/registry.json`.

```
oab up [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `-p, --port <number>` | `4999` | Puerto del registry. |

```bash
oab up
oab up --port 4998
```

### `down`

Detiene el registry en background. Lee el puerto persistido, envía `SIGTERM` (con fallback `SIGKILL`) y limpia el archivo de meta. Si encuentra un PID muerto, limpia el archivo stale. Si hay un registry corriendo que **no** fue arrancado como daemon aquí, lo reporta sin matarlo.

```bash
oab down
```

### `status`

Muestra salud del registry, número de agentes conectados, PID del daemon (si aplica) y presencia de `.mcp.json`.

```
oab status [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry a consultar. |

### `claude`

Lanza Claude Code totalmente cableado en un comando: asegura el registry (lo arranca si hace falta), escribe `.mcp.json` si falta, setea `AGENT_BRIDGE_IDENTITY`/`AGENT_BRIDGE_PROJECT`, y hace `spawn` de `claude`. La entrega push usa el inbox socket nativo de Claude Code (≥ 2.1.224); el flag `--dangerously-load-development-channels server:open-agent-bridge` solo se agrega en versiones anteriores o con `--legacy-channels`. **No** detiene el registry al salir (es un daemon compartido). Flags desconocidos se pasan tal cual a `claude`.

```
oab claude [options] [-- <flags de claude>]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--identity <id>` | `global` | Namespace de canal. |
| `--project <path>` | cwd | Proyecto. |
| `-p, --port <number>` | `4999` | Puerto del registry. |
| `--legacy-channels` | auto (solo CC < 2.1.224) | Agrega `--dangerously-load-development-channels server:open-agent-bridge` (push vía `<channel>`). |

```bash
oab claude --identity dev
oab claude --identity ticket-42 --project /ruta/al/proyecto
```

### `doctor`

Diagnóstico de entorno (no aborta en el primer fallo): Node ≥ 22, `oab` en PATH, registry alcanzable, `.mcp.json` presente + identity, y binarios de cliente (`claude`/`codex`/`opencode`/`agy`, opcionales). Termina con un resumen.

```
oab doctor [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--json` | — | Imprime los chequeos como JSON. |

---

## Registry

### `registry start`

Arranca el registry HTTP/WS. En foreground por defecto (bloquea la terminal); con `--daemon` corre detached (equivalente a `oab up`).

```
oab registry start [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `-p, --port <number>` | `4999` | Puerto. |
| `-d, --daemon` | — | Corre detached en background y retorna de inmediato. |

### `registry stop`

Detiene el daemon del registry (equivalente a `oab down`).

```bash
oab registry stop
```

### `registry status`

Consulta `GET /health` del registry y muestra el conteo de agentes.

```
oab registry status [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

---

## MCP

### `mcp config`

Imprime o escribe/mergea la entrada `.mcp.json` que añade open-agent-bridge a un cliente MCP. El merge es **no destructivo** (preserva otros `mcpServers` y otras claves top-level). Inyecta `AGENT_BRIDGE_IDENTITY` cuando la identity no es `global`.

```
oab mcp config [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--write` | — | Escribe/mergea `.mcp.json` en el cwd (sin esto, solo imprime). |
| `--identity <id>` | `global` | Identity a hornear en `env`. |
| `--global` | — | Modo `linked`: invoca el binario por nombre (`open-agent-bridge`). |
| `--local` | — | Modo `local`: invoca `node <dist>/cli/index.js`. |

Sin `--global` ni `--local`, el modo se autodetecta: `linked` si `oab`/`open-agent-bridge` está en el PATH, si no `local`.

```bash
oab mcp config                              # imprime (autodetecta modo)
oab mcp config --write --identity dev       # escribe/mergea con identity
oab mcp config --write --global             # fuerza comando por nombre de binario
```

Entrada generada (modo `linked`, identity `dev`):

```json
{
  "mcpServers": {
    "open-agent-bridge": {
      "command": "open-agent-bridge",
      "args": ["mcp", "start"],
      "env": {
        "AGENT_BRIDGE_PROJECT": "/ruta/al/proyecto",
        "AGENT_BRIDGE_IDENTITY": "dev"
      }
    }
  }
}
```

### `mcp start`

Arranca el adaptador MCP en modo **stdio** (lo usa Claude Code y otros clientes MCP como subproceso). Auto-arranca un registry embebido y un agente local si no hay ninguno corriendo. Expone 6 herramientas: `agent_bridge_guide`, `list_agents`, `channel_inbox`, `channel_clear`, `message_client_session`, `reply`.

```
oab mcp start [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--project <path>` | cwd | Proyecto para el registro del cliente. |
| `--identity <id>` | `global` | Namespace de canal. |
| `--no-auto` | — | Desactiva el auto-arranque del registry (requiere setup manual). |

> Normalmente no se invoca a mano: lo lanza el cliente MCP según `.mcp.json`.

### `mcp server`

Arranca el adaptador MCP como servidor **HTTP/SSE** (para clientes MCP remotos).

```
oab mcp server [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `-p, --port <number>` | `6000` | Puerto HTTP. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

### `mcp status`

Muestra qué agentes y herramientas estarían disponibles para un cliente MCP en este momento.

```
oab mcp status [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

---

## Agentes y mensajería

### `start`

Arranca un servidor de agente para un directorio de proyecto (puerto auto desde 5001). Con flags puede arrancar el registry o el adaptador MCP en su lugar.

```
oab start [path] [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `-p, --port <number>` | auto desde 5001 | Puerto donde escuchar. |
| `--registry` | — | Arranca el registry en lugar de un agente. |
| `--mcp` | — | Arranca el adaptador MCP (stdio) en lugar de un agente. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--claude` | — | Habilita el backend de Claude Code para skills inteligentes (requiere `ANTHROPIC_API_KEY`; necesario para `code-review` y `claude-execute`). |

```bash
oab start .
oab start /ruta/al/proyecto --port 5007 --claude
```

### `list`

Lista los agentes activos registrados. Cada entrada muestra id, pid/host, puerto, ruta, tipo, skills y — si la sesión se registró con un namespace — su `Identity`.

```
oab list [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--skill <tag>` | — | Filtra por tag de skill. |
| `--project <path>` | — | Filtra por nombre o ruta de proyecto. |
| `--json` | — | Salida en JSON. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

### `health`

Chequea la salud de los agentes (todos o uno específico por `agent-id`).

```
oab health [agent-id] [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--json` | — | Salida en JSON. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

### `ask`

Envía un mensaje/tarea a un agente específico.

```
oab ask <agent-id> <message> [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--skill <id>` | — | Skill específico a invocar. |
| `--json` | — | Salida en JSON. |
| `--stream` | — | Streamea la respuesta. |
| `--relay` | — | Envía vía relay WS del registry en lugar de HTTP directo. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

```bash
oab ask a1b2c3d4 "resume el README" --stream
```

### `find`

Busca agentes por tag de skill, nombre de proyecto o ruta.

```
oab find <query> [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--json` | — | Salida en JSON. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

### `delegate`

Delega una tarea al mejor agente disponible que tenga el skill indicado.

```
oab delegate <skill-id> <message> [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--json` | — | Salida en JSON. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

### `broadcast`

Envía un mensaje a todos los agentes sanos registrados.

```
oab broadcast <message> [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--json` | — | Salida en JSON. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

### `prune`

Limpia entradas zombie del registry. Contexto: una sesión cuya UI se cerró pero cuyo proceso quedó vivo sigue mandando heartbeats cada 30s, así que el registry la ve `healthy` para siempre — deregistrarla es inútil (se re-registra en el siguiente heartbeat); la única solución durable es matar el proceso dueño, que es lo que hace este comando.

```
oab prune [targets...] [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `[targets...]` | — | Ids, nombres o proyectos a podar forzadamente (mata el proceso dueño). |
| `--orphans` | — | Además mata procesos vivos sin terminal (tty=?) o re-parentados a init. |
| `--all` | — | Apaga TODO: mata cada sesión local y limpia el registry. |
| `--dry-run` | — | Muestra el plan sin cambiar nada. |
| `-y, --yes` | — | Salta la confirmación antes de matar procesos. |
| `--json` | — | Salida en JSON (solo formato — **no** implica consentimiento). |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |

Clasificación por entrada: `dead` (sin proceso → deregister), `orphaned` (vivo pero sin terminal → kill con `--orphans`/`--all`), `live` (en un tty real → solo con target o `--all`), `remote` (otro host → nunca se toca, ni con `--all`).

Modelo de seguridad:

- Solo actúa sobre procesos del **mismo host**; las entradas remotas se ignoran siempre.
- Un pid vivo que el scan de `/proc` no puede inspeccionar (macOS/Windows, o carrera del scan) se clasifica `live`, nunca `orphaned` — lo que no se puede inspeccionar no es candidato a kill.
- Matar sin `-y` en modo no interactivo (`--json`, o stdin sin TTY) **falla con error** en vez de preguntar o proceder en silencio.
- Si el SIGTERM falla, la entrada NO se deregistra (el proceso vivo se re-registraría igual; el registry se mantiene honesto).

```bash
oab prune                    # deregistra entradas muertas (sin kill)
oab prune --dry-run --all    # plan completo sin tocar nada
oab prune --orphans -y       # mata huérfanos sin preguntar
oab prune ril-scraper        # poda una sesión específica por nombre
```

---

## Integraciones de cliente

### `codex`

Utilidades específicas de Codex. El bridge inyecta mensajes de canal directo en el app-server de Codex vía `turn/start`.

#### `codex start`

Arranca Codex con el bridge bidireccional completo en un comando: auto-arranca el registry si no corre, levanta el bridge del app-server (conectado como segundo cliente WS) y lanza la TUI de Codex conectada al app-server.

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | cwd | Proyecto. |
| `--app-server-port <number>` | `4500` | Puerto inicial del app-server (auto-incrementa si está ocupado). |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--identity <id>` | `global` | Namespace de canal. |
| `--effort <level>` | default del modelo | Reasoning effort de los turnos del canal (`minimal`…`ultra`); `ultra` = delegación proactiva a sub-agentes. Pegajoso para todo el thread del bridge. |

```bash
oab codex start --identity dev
```

#### `codex app-bridge`

Arranca el daemon del bridge del app-server de Codex (sin lanzar la TUI). Luego conectás Codex con `codex --remote ws://127.0.0.1:<app-server-port>`.

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--project <path>` | cwd | Proyecto para el registro del cliente. |
| `--app-server-port <number>` | `4500` | Puerto inicial del app-server. |
| `--identity <id>` | `global` | Namespace de canal. |
| `--effort <level>` | default del modelo | Reasoning effort de los turnos del canal (`minimal`…`ultra`); `ultra` = delegación proactiva a sub-agentes. Pegajoso para todo el thread del bridge. |

#### `codex tmux-bind`

Vincula la sesión actual de Codex a un panel tmux para inyectar follow-ups.

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | cwd | Override de proyecto. |
| `--client-id <id>` | — | ID exacto de sesión de cliente Codex a vincular. |
| `--pane <pane>` | — | Panel tmux explícito (p. ej. `%12`). |

#### `codex tmux-sidecar`

Corre un sidecar por sesión que inyecta los follow-ups pendientes del canal en el panel activo de Codex.

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--project <path>` | cwd | Override de proyecto. |
| `--client-id <id>` | — | ID exacto de sesión de cliente Codex. |
| `--tmux-pane <pane>` | — | Panel tmux explícito. |
| `--poll-interval-ms <number>` | `2000` | Intervalo de polling (ms). |
| `--retry-interval-ms <number>` | `30000` | Reintento del mismo mensaje pendiente (ms). |
| `--verbose` | — | Logs verbosos. |
| `--once` | — | Corre un ciclo de poll y sale. |

### `opencode`

#### `opencode install-plugin`

Instala el plugin de open-agent-bridge en un proyecto OpenCode (o global). El plugin abre un WebSocket al registry y entrega los mensajes de canal directo en la sesión activa vía `session.prompt_async` (push en tiempo real). Los plugins locales en `.opencode/plugins/` se auto-cargan; reiniciá OpenCode tras instalar.

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | cwd | Proyecto. |
| `--global` | — | Instala en `~/.config/opencode/plugins/` en lugar del proyecto. |

### `antigravity`

Integración con la CLI de Google Antigravity (`agy`): canales nativos vía MCP + hooks.

#### `antigravity install-plugin`

Escribe la config MCP de open-agent-bridge + hooks de ciclo de vida para que `agy` entregue mensajes de canal automáticamente (Stop hook con auto-continue).

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | cwd | Workspace donde instalar. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--bridge-command <cmd>` | `open-agent-bridge` | Ejecutable de open-agent-bridge. |
| `--identity <id>` | `global` | Namespace de canal. |
| `--global` | — | Instala en `~/.gemini/antigravity-cli` en lugar del `.agents/` del workspace. |

#### `antigravity ls-push`

Auto-entrega mensajes de canal a una TUI de `agy` **viva** vía su Cascade Language Server (`SendUserCascadeMessage`) — sin tmux ni "check inbox" manual. Requiere `agy` corriendo con una conversación abierta en el workspace.

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | cwd | Workspace. |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--identity <id>` | `global` | Namespace de canal de la sesión `agy`. |
| `--client-id <id>` | — | ID explícito de sesión Antigravity. |
| `--poll-interval-ms <n>` | `2000` | Intervalo de polling (ms). |
| `--retry-interval-ms <n>` | `30000` | Blackout de re-inyección por mensaje (ms). |
| `--once` | — | Corre un ciclo y sale. |
| `--verbose` | — | Logs verbosos. |

#### `antigravity hook-stop` / `antigravity hook-session-start`

Hooks que `install-plugin` cablea (normalmente no se invocan a mano). `hook-stop` entrega pendientes y fuerza a `agy` a continuar; `hook-session-start` surfacea pendientes como contexto. Opciones comunes: `--project` (cwd), `--registry-url` (`http://localhost:4999`), `--client-id`, `--identity` (`global`).

---

## `dashboard`

Abre el dashboard de open-agent-bridge en el navegador. El registry lo sirve en `http://localhost:<port>/dashboard` (requiere `pnpm run build:all` / `build:dashboard`).

```
oab dashboard [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--no-open` | — | Imprime la URL sin abrir el navegador. |
| `--port <number>` | `4999` | Puerto del registry. |

---

## Variables de entorno

| Variable | Default | Para qué sirve |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_PROJECT` | cwd | Proyecto con el que se asocia la sesión del cliente MCP. Lo inyecta `oab` en `.mcp.json`. |
| `AGENT_BRIDGE_IDENTITY` | `global` | Namespace de canal. Lo inyecta `oab` cuando la identity no es `global`. |
| `ANTHROPIC_API_KEY` | — | Requerida por el backend de Claude (`start --claude`) para skills como `code-review`/`claude-execute`. |

Las flags `--identity` y `--project` de los comandos tienen prioridad sobre estas variables.

---

## Archivos y estado

Todo el estado de runtime vive en `.open-agent-bridge/` dentro del proyecto (gitignored):

| Archivo | Contenido |
| :--- | :--- |
| `.open-agent-bridge/registry.json` | Meta del daemon: `{ pid, port }`. Lo escribe `oab up`, lo lee `oab down`/`status`. |
| `~/.open-agent-bridge/registry.sqlite` | Conversaciones, mensajes y ACKs del canal. **Por usuario** (homedir), independiente del cwd del registry. |
| `.open-agent-bridge/registry.log` | stdout/stderr del daemon. |
| `.mcp.json` | Config del cliente MCP (en la raíz del proyecto). Generado por `oab init` / `oab mcp config`. |

> Como el SQLite y el PID dependen del cwd, arrancá siempre el registry desde la misma raíz de proyecto para que `up`/`down`/`status` sean coherentes.

---

## Puertos

| Puerto | Servicio |
| :--- | :--- |
| `4999` | Registry (HTTP REST + WS `/ws` + `/dashboard`). |
| `5001`–`5099` | Servidores de agente (auto-asignados). |
| `6000` | Adaptador MCP en modo HTTP/SSE (`mcp server`). |
| `4500`+ | App-server de Codex (`codex start`/`app-bridge`, auto-incrementa). |

---

## Recetas comunes

**Aislar dos tickets en el mismo proyecto** — cada uno con su inbox privado:

```bash
oab claude --identity ticket-101   # terminal 1
oab claude --identity ticket-102   # terminal 2  (no se ven entre sí)
```

**Claude ↔ Codex en el mismo canal:**

```bash
oab up
oab claude --identity dev          # terminal 1
oab codex start --identity dev     # terminal 2  (comparten canal "dev")
```

**Config sin instalación global (modo local), para commitear o compartir:**

```bash
oab mcp config --write --local --identity dev
```

**Reset del hub:**

```bash
oab down && oab up
```

---

## Solución de problemas

| Síntoma | Causa / Solución |
| :--- | :--- |
| `oab: command not found` tras instalar | El bin global no está en PATH. Corré `bin/install.sh` (imprime el `export PATH=...`) o `oab doctor`. |
| `Port 4999 is already in use` | Otro proceso ocupa el puerto. Usá `oab up --port <otro>` o liberá el 4999. |
| `oab down` dice "running but not started as a daemon here" | El registry se arrancó en otro cwd / en foreground. Detenelo donde lo lanzaste, o usá ese mismo directorio. |
| Dashboard en blanco / error de MIME en el CSS | Faltaba `base: /dashboard/` en `dashboard/vite.config.ts` (ya corregido). Recompilá con `pnpm run build:dashboard` y hard-reload del navegador. |
| `claude` no arranca desde `oab claude` | `claude` no está en PATH. Instalá Claude Code o agregalo al PATH (`oab doctor` lo verifica). |
| Las herramientas MCP no aparecen en Claude | Reiniciá Claude Code tras escribir `.mcp.json`; verificá con `oab mcp status` y `oab doctor`. |
| `.mcp.json` con ruta absoluta de otra máquina | Regeneralo: `oab mcp config --write` (modo `linked`) usa el binario por nombre, sin rutas frágiles. |

---

Ver también: [`README.md`](../README.md) (visión general y bridges) · [`docs/cli-and-operations.md`](./cli-and-operations.md) (detalle operativo) · `oab <comando> --help` (ayuda viva).
