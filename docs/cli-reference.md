# Referencia del CLI — open-agent-bridge

Referencia completa de la interfaz de línea de comandos de `open-agent-bridge`: el hub local de comunicación entre agentes de IA (Claude Code, Codex, OpenCode, pi, Antigravity) sobre MCP + WebSocket.

> El binario se llama `open-agent-bridge`, con el alias corto **`oab`** (idénticos). En esta referencia se usa `oab`. En modo contributor (sin instalación global) el equivalente es `pnpm run dev -- <comando>`.

---

## Tabla de contenidos

- [Instalación](#instalación)
- [Inicio rápido](#inicio-rápido)
- [Conceptos](#conceptos)
- [Comandos de setup y ciclo de vida](#comandos-de-setup-y-ciclo-de-vida)
  - [`init`](#init) · [`up`](#up) · [`down`](#down) · [`status`](#status) · [`claude`](#claude) · [`doctor`](#doctor) · [`prompt`](#prompt)
- [Registry](#registry)
  - [`registry start`](#registry-start) · [`registry stop`](#registry-stop) · [`registry status`](#registry-status)
- [MCP](#mcp)
  - [`mcp config`](#mcp-config) · [`mcp start`](#mcp-start) · [`mcp server`](#mcp-server) · [`mcp status`](#mcp-status)
- [Agentes y mensajería](#agentes-y-mensajería)
  - [`start`](#start) · [`list`](#list) · [`health`](#health) · [`ask`](#ask) · [`find`](#find) · [`delegate`](#delegate) · [`broadcast`](#broadcast) · [`prune`](#prune)
- [Integraciones de cliente](#integraciones-de-cliente)
  - [Entrega nativa por cliente](#entrega-nativa-por-cliente) · [`codex`](#codex) · [`opencode`](#opencode) · [`pi`](#pi) · [`antigravity`](#antigravity)
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
oab init                     # wizard: identity + clientes → .mcp.json + registry + plugins
claude                       # o codex / opencode / pi / agy: los mensajes llegan como turno nuevo en la sesión viva
oab doctor                   # confirma la entrega nativa de cada cliente
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

Configura un proyecto en un solo paso: detecta el cwd, pregunta identity y clientes (wizard interactivo con `@clack/prompts`), escribe/mergea `.mcp.json`, levanta el registry como daemon, instala la pieza de cada cliente reusando sus instaladores (OpenCode → `opencode install-plugin --project <proyecto>`; pi → `pi install-extension`; Antigravity → `antigravity install-plugin`), registra el MCP en **Codex** vía `codex mcp add` (Codex ignora `.mcp.json` — solo carga servidores desde `~/.codex/config.toml`; el registro es idempotente: hace `remove` antes de `add`), e imprime los próximos pasos por cliente: `claude`, `codex`, `opencode`, `pi` y `agy` a secas.

`~/.codex/config.toml` es **global**, así que ahí solo va el comando, sin proyecto ni identity: Codex arranca el adapter en el directorio de cada sesión, que ya identifica el proyecto. Una identity distinta de `global` se escribe en el `.codex/config.toml` del proyecto (Codex lo lee si el proyecto es *trusted*). Las versiones anteriores fijaban `AGENT_BRIDGE_PROJECT` en el config global y toda sesión de Codex quedaba registrada como ese proyecto: `oab doctor` lo detecta y volver a correr `oab init --client codex` lo reescribe.

```
oab init [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--identity <id>` | `global` | Namespace de canal. Va a `.mcp.json` y, con Codex, al `.codex/config.toml` del proyecto. |
| `--client <name>` | `[]` | Cliente a configurar: `claude\|codex\|opencode\|antigravity\|pi`. Repetible o separado por comas. |
| `--project <path>` | cwd | Proyecto sobre el que operar. |
| `-p, --port <number>` | `4999` | Puerto del registry. |
| `--mode <mode>` | auto | Modo de `.mcp.json`: `linked` o `local`. Auto: `linked` si `oab` está en PATH. |
| `-y, --yes` | — | No interactivo: usa flags/defaults sin preguntar (CI/scripting). |

```bash
oab init                                       # wizard interactivo
oab init --yes --identity dev --client claude  # no interactivo
oab init --yes --client claude,codex --identity ticket-42
oab init --yes --client opencode,pi,antigravity  # instala plugin de OpenCode, extensión de pi y plugin de agy
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

Atajo opcional — con Claude Code ≥ 2.1.224 alcanza con `claude` a secas en un proyecto con `.mcp.json` (o el plugin). Lanza Claude Code totalmente cableado en un comando: asegura el registry (lo arranca si hace falta), escribe `.mcp.json` si falta, setea `AGENT_BRIDGE_IDENTITY`/`AGENT_BRIDGE_PROJECT`, y hace `spawn` de `claude`. La entrega push usa el inbox socket nativo de Claude Code (≥ 2.1.224); el flag `--dangerously-load-development-channels server:open-agent-bridge` solo se agrega en versiones anteriores o con `--legacy-channels`. **No** detiene el registry al salir (es un daemon compartido). Flags desconocidos se pasan tal cual a `claude`.

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

Diagnóstico de entorno (no aborta en el primer fallo): Node ≥ 22, `oab` en PATH, registry alcanzable, `.mcp.json` presente + identity, y binarios de cliente (`claude`/`codex`/`opencode`/`agy`/`pi`, opcionales). Para Claude Code y Codex además informa si su versión tiene **entrega nativa** (Claude Code ≥ 2.1.224 por el inbox socket; codex ≥ 0.162 por el app-server daemon) o qué fallback usar (`oab claude --legacy-channels` / `oab codex start`). Para los clientes cuya entrega necesita una pieza dentro del agente revisa que esté instalada: el plugin de OpenCode (`.opencode/plugins/open-agent-bridge/` o `~/.config/opencode/plugins/open-agent-bridge/`; marca como *outdated* el layout de archivo suelto `agent-bridge.ts` o un directorio sin `tui.ts`), la extensión de pi (`.pi/extensions/` o `~/.pi/agent/extensions/open-agent-bridge.ts`) y el plugin `oab` de agy (vía `agy plugin list --json`). Con Codex en PATH verifica que el MCP esté registrado en `~/.codex/config.toml` (o el plugin `oab`) y marca como fallo un config global que fije `AGENT_BRIDGE_PROJECT`. Si hay una plantilla de prompt propia (ver [`prompt`](#prompt)), dice cuál está activa y avisa si le falta `{{safety}}` o el `{{message}}` enmarcado. Termina con un resumen.

```
oab doctor [options]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--registry-url <url>` | `http://localhost:4999` | URL del registry. |
| `--json` | — | Imprime los chequeos como JSON. |

### `prompt`

El texto en que se convierte un mensaje entrante (encabezado, mensaje enmarcado, aviso de seguridad, instrucciones con la llamada a `reply` prellenada) sale de una plantilla que se puede reemplazar para todos los agentes a la vez: responder en otro idioma, ser breve, correr los tests antes de contestar, etc. Cada agente la lee en cada mensaje, así que los cambios aplican sin reiniciar.

```
oab prompt init [--force]   # escribe la plantilla incluida en ~/.config/open-agent-bridge/prompt.md
oab prompt show             # qué plantilla está activa y un mensaje de ejemplo con ella
```

Orden de resolución: `$AGENT_BRIDGE_PROMPT_TEMPLATE` → `${XDG_CONFIG_HOME:-~/.config}/open-agent-bridge/prompt.md` → la incluida. No hay plantilla por proyecto (un repo clonado podría traer una que les diga a tus agentes que obedezcan a sus pares).

| Placeholder | Se reemplaza por |
| :--- | :--- |
| `{{header}}` | título (con la marca `[open-agent-bridge] Channel message`), remitente, conversación e id del mensaje |
| `{{message}}` | el texto del par entre `BEGIN/END MESSAGE` (recomendado: separa sus palabras de tus instrucciones) |
| `{{content}}` | el texto del par, sin marco |
| `{{safety}}` | "esto viene de otro agente, no de tu usuario…" |
| `{{instructions}}` | cómo responder, con la llamada a `reply` prellenada (o la variante `relayed` de `oab codex start`) |
| `{{sender}}` `{{senderShort}}` `{{senderId}}` `{{conversationId}}` `{{messageId}}` `{{taskId}}` | los valores sueltos |

Siempre se conservan dos cosas: si la plantilla no tiene `{{instructions}}`, se agregan al final (sin la llamada prellenada las respuestas no llegan), y si no aparece la marca, se antepone la línea de título (la parte de terminal del plugin de OpenCode la busca). Los `<!-- comentarios -->` se eliminan antes de mandar el prompt, y los placeholders que aparezcan dentro del mensaje del par nunca se expanden.

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

### Entrega nativa por cliente

Un setup una vez (`oab init`, o el instalador de cada cliente) y después el comando a secas. Un mensaje de otro agente **arranca un turno nuevo en la sesión viva**; el agente responde con `reply` y puede abrir hilos con `message_client_session`. Verificado en vivo en las dos direcciones con los cinco clientes (2026-10-15).

| Cliente | Versión | Setup | Cómo entra el turno |
| :--- | :--- | :--- | :--- |
| Claude Code | ≥ 2.1.224 | `.mcp.json` (`oab init`) | El adapter escribe en el inbox socket de Claude Code (`$CLAUDE_CODE_MESSAGING_SOCKET`). Versiones viejas: `oab claude --legacy-channels`. |
| Codex | ≥ 0.162 | MCP en `~/.codex/config.toml` (`oab init --client codex`) | El adapter arranca el turno en el thread de la TUI vía el app-server daemon de Codex. Versiones viejas / sin TUI: `oab codex start`. |
| OpenCode | 2.x (1.x con archivo suelto) | `oab opencode install-plugin` | El plugin del server encola el mensaje (`delivery: "queue"`) en la sesión del usuario; la parte de terminal la abre si estás en el inicio. |
| pi | ≥ 1.3 | `oab pi install-extension` | La extensión llama `pi.sendMessage(…, { triggerTurn: true, deliverAs: "followUp" })`. pi necesita un modelo (`/login`). |
| Antigravity (`agy`) | ≥ 1.3 | `oab antigravity install-plugin` | El adapter llama `SendUserCascadeMessage` (`WHEN_IDLE`) en la conversación que registró `antigravity attach`. |

**Host inbox sockets (OpenCode y pi).** Su API para arrancar un turno solo existe dentro de su propio proceso, así que la pieza instalada (plugin / extensión) escucha en `${XDG_RUNTIME_DIR:-$TMPDIR}/open-agent-bridge/inbox-<pid>.sock` (directorio 0700, socket 0600; en OpenCode `inbox-<pid>-<sha256(dir)[:12]>.sock`, porque un server atiende varios proyectos). El adapter MCP es hijo del agente, lo encuentra por `process.ppid` y escribe NDJSON `{"type":"user","id":<messageId>,"message":{"role":"user","content":…}}`. Los listeners descartan un `id` repetido (últimos 500): dos adapters en el mismo agente o un replay del registry arrancan un solo turno. El token de mensajería de Claude Code nunca se reenvía a estos sockets.

**Si la entrega falla** (agente cerrado, socket ausente, RPC rechazado): en Codex, OpenCode, pi y agy el mensaje queda pendiente y lo reintenta el sync del registry — no hay ack falso. Claude Code cae a la notificación de canal.

### `codex`

Utilidades específicas de Codex. Con codex ≥ 0.162 **no hacen falta**: `codex` a secas recibe los mensajes como turno nuevo en la TUI viva (el adapter MCP los entrega por el app-server daemon de Codex). Estos comandos quedan para Codex sin TUI (*headless*) o versiones anteriores: un bridge propio inyecta los mensajes en su thread vía `turn/start` y reenvía la respuesta final.

#### `codex start`

Codex *headless*: auto-arranca el registry si no corre, levanta un bridge dueño de su propio thread de Codex (responde aunque no haya TUI abierta) y lanza una TUI de Codex conectada a ese app-server. Es el camino para codex < 0.162.

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

Instala el plugin de open-agent-bridge en un proyecto OpenCode (o global). Los plugins locales se auto-cargan; reiniciá OpenCode tras instalar (el server `opencode serve --service` recarga el plugin solo cuando cambia el archivo).

- **OpenCode 2.x** — escribe `<plugins>/open-agent-bridge/index.ts` (server) + `tui.ts` (terminal) y borra el `agent-bridge.ts` suelto de versiones anteriores (se cargaría dos veces). La mitad del server registra el MCP por su cuenta (`ctx.mcp.transform`, sin tocar `opencode.json`), abre el host inbox socket y encola cada mensaje (`delivery: "queue"`, nunca `steer`) en la sesión activa del proyecto, o en una sesión propia "open-agent-bridge" si la terminal está en la pantalla de inicio. La mitad de terminal escucha `session.inbox.enqueued`: en el inicio abre esa sesión; en otra sesión muestra un toast (este caso no está verificado en vivo).
- **OpenCode 1.x** — detectado con `opencode --version`: copia el archivo suelto `agent-bridge.ts` (OpenCode 1 no tiene plugins de terminal).

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | cwd | Proyecto (`<project>/.opencode/plugins/`). |
| `--global` | — | Instala en `~/.config/opencode/plugins/` en lugar del proyecto. |

### `pi`

#### `pi install-extension`

Instala la extensión de open-agent-bridge para pi ≥ 1.3 (`@earendil-works/pi-coding-agent`). La extensión registra el MCP (`pi.registerMcpServer`), abre el host inbox socket `inbox-<piPid>.sock` al iniciar la sesión y convierte cada mensaje en un turno con `pi.sendMessage(…, { triggerTurn: true, deliverAs: "followUp" })`. pi necesita un modelo configurado (`/login`) para responder.

```
oab pi install-extension [--project <path>]
```

| Opción | Default | Descripción |
| :--- | :--- | :--- |
| `--project <path>` | — | Instala en `<path>/.pi/extensions/` (pi pide confiar en el proyecto) en lugar de `~/.pi/agent/extensions/open-agent-bridge.ts`. |

### `antigravity`

Integración con la CLI de Google Antigravity (`agy` ≥ 1.3): MCP + hooks del plugin + `attach` para la entrega en vivo.

**Por qué hay un `attach`.** El language server de agy puede arrancar un turno en la conversación viva (`SendUserCascadeMessage`), pero solo acepta RPCs con un token CSRF que agy entrega a los comandos que corre **su propio agente** — no a los servidores MCP ni a los hooks (los hooks solo reciben `ANTIGRAVITY_CONVERSATION_ID`). El CLI `agy` tampoco corre sidecars (eso es del Antigravity app). Por eso el hook `SessionStart` le pide al agente que corra `open-agent-bridge antigravity attach` una vez por proceso de agy; de ahí en adelante todo es automático.

#### `antigravity install-plugin`

Corre `agy plugin install <repo>/plugins/open-agent-bridge`: el plugin `oab` compartido (el mismo que instalan Claude Code y Codex) trae para agy `plugin.json`, `mcp_config.json` (servidor `open-agent-bridge`), `hooks.json` en la raíz (`SessionStart` + `Stop`), el skill y los comandos. Borra el directorio viejo `~/.gemini/config/sidecars/open-agent-bridge`. Sin opciones; reiniciá `agy` después.

```
oab antigravity install-plugin
```

Si quedó una entrada vieja en `.agents/mcp_config.json` (p. ej. un servidor `agent-bridge` de instalaciones anteriores), agy levanta un segundo adapter al lado del del plugin: borrala.

#### `antigravity attach`

Lo corre el agente de agy desde su terminal (se lo pide el hook `SessionStart`; la primera vez agy puede pedir permiso). Guarda la dirección del language server, el token y la conversación en `$XDG_RUNTIME_DIR/open-agent-bridge/agy-<agyPid>.json` (0600 en un directorio 0700). El adapter MCP, hijo directo de agy, lo lee por `process.ppid` y entrega cada mensaje con `SendUserCascadeMessage` (`AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE`, `MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE`: turno inmediato si agy está quieto, después del turno en curso si no), reusando el `cascadeConfig` y el agente del último mensaje del usuario (`GetCascadeTrajectory`) — sin un plan model agy rechaza el turno (`plan model not specified`), y así se mantiene el modelo que eligió el usuario. Sale con código ≠ 0 si le falta la dirección/token (no se corrió desde agy).

```
oab antigravity attach
```

#### `antigravity ls-push` (legacy)

**No funciona con agy ≥ 1.3**: el language server rechaza los RPCs sin token CSRF (`401 missing CSRF token`). Queda para versiones anteriores de agy; con 1.3 la entrega en vivo la hace el adapter tras `attach`.

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

Hooks del `hooks.json` del plugin (normalmente no se invocan a mano). agy los corre con `sh -c` desde el directorio del plugin, así que el proyecto sale de `workspacePaths` del payload. Los dos refrescan la conversación de `agy-<pid>.json` con el token ya guardado (siguen `/new` y los resumes).

- `hook-session-start` — devuelve `injectSteps`: le pide al agente que corra `attach` si todavía no se corrió, y avisa cuántos mensajes hay pendientes.
- `hook-stop` — si hay mensajes pendientes devuelve `{"decision":"continue","reason":…}` para que agy siga y los conteste (agy 1.3 ignora `"block"`). Es el respaldo cuando no hubo `attach` (el adapter deja esos mensajes pendientes): entran al terminar el turno.

Opciones comunes: `--project` (default: el workspace del hook), `--registry-url` (`http://localhost:4999`), `--client-id`, `--identity` (`global`).

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
| `AGENT_BRIDGE_PROMPT_TEMPLATE` | — | Plantilla del prompt para la sesión o el agente que se lance con ella; tiene prioridad sobre `~/.config/open-agent-bridge/prompt.md` (ver [`prompt`](#prompt)). |
| `XDG_CONFIG_HOME` | `~/.config` | Dónde se busca `open-agent-bridge/prompt.md`. |
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
| `$XDG_RUNTIME_DIR/open-agent-bridge/inbox-<pid>[-<dirhash>].sock` | Host inbox sockets de OpenCode y pi (0600; directorio 0700). Los crea el plugin / la extensión y se borran al salir. |
| `$XDG_RUNTIME_DIR/open-agent-bridge/agy-<pid>.json` | Conversación viva de agy + dirección y token del language server (0600). Lo escribe `antigravity attach`; lo refrescan los hooks. |

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

(`oab claude --identity` setea la identity solo para esa sesión; `oab init --identity` la deja escrita en el proyecto para usar `claude` a secas.)

**Claude ↔ Codex en el mismo canal:**

```bash
oab init --yes --client claude,codex --identity dev
claude                             # terminal 1
codex                              # terminal 2  (comparten canal "dev"; codex ≥ 0.162)
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
| Codex se registra con el proyecto equivocado (`oab list`) | Un `oab init` viejo fijó `AGENT_BRIDGE_PROJECT` en `~/.codex/config.toml` (`oab doctor` lo marca). Corré `oab init --client codex` y abrí una sesión nueva de Codex: el daemon levanta un adapter por thread, así que cerrar la TUI no recarga el config de los threads viejos. |
| Un mensaje a Codex no aparece en la TUI | `oab doctor` debe mostrar `client: codex (native push)` en verde (codex ≥ 0.162). Si había otra TUI de Codex abierta en el mismo proyecto, recibe la más nueva. Para versiones viejas usá `oab codex start`. |
| `.mcp.json` con ruta absoluta de otra máquina | Regeneralo: `oab mcp config --write` (modo `linked`) usa el binario por nombre, sin rutas frágiles. |
| OpenCode responde pero el mensaje no se ve en la terminal | Plugin sin la mitad de terminal (`oab doctor` lo marca *outdated*). Corré `oab opencode install-plugin` y reiniciá OpenCode. |
| pi recibe el mensaje pero no contesta | pi no tiene modelo: `/login` en pi. |
| agy no recibe en vivo (solo al terminar un turno) | No se corrió `attach` en ese proceso de agy: pedile que corra `open-agent-bridge antigravity attach` (o aprobá el permiso). El log de agy (`~/.gemini/antigravity-cli/log/`) muestra `live delivery off — missing …`. |
| agy: `plan model not specified` en el turno inyectado | Versión vieja del adapter sin `cascadeConfig`. Actualizá `oab` y reiniciá agy. |
| agy aparece dos veces en `list_agents` | Un `.agents/mcp_config.json` viejo levanta un segundo adapter. Borrá esa entrada; el plugin ya registra el MCP. |

---

Ver también: [`README.md`](../README.md) (visión general y bridges) · [`docs/cli-and-operations.md`](./cli-and-operations.md) (detalle operativo) · `oab <comando> --help` (ayuda viva).
