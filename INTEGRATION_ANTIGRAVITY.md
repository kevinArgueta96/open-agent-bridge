# Integración: Antigravity CLI (`agy`)

Cómo recibe y envía mensajes `agy` ≥ 1.3 a través de open-agent-bridge. Verificado en vivo con `agy` 1.3.4 (2026-10-15): un mensaje enviado desde Claude Code arranca un turno nuevo en una sesión de `agy` quieta, `agy` contesta con `reply` y abre hilos propios con `message_client_session`.

---

## 1. Setup

```bash
oab antigravity install-plugin   # o: oab init --client antigravity
agy                              # reiniciá agy si ya estaba abierto
```

`install-plugin` corre `agy plugin install <repo>/plugins/open-agent-bridge`. Es el mismo plugin compartido que instalan Claude Code y Codex (`oab`); para `agy` aporta:

| Archivo | Rol |
|---|---|
| `plugin.json` | Marca el directorio como plugin nativo de agy. |
| `mcp_config.json` | Servidor MCP `open-agent-bridge` (`open-agent-bridge mcp start`). |
| `hooks.json` (raíz) | `SessionStart` → `open-agent-bridge antigravity hook-session-start`; `Stop` → `open-agent-bridge antigravity hook-stop`. agy solo carga `hooks.json` de la raíz en plugins nativos. |
| `skills/`, `commands/` | Skill `agent-bridge`; los comandos se convierten en skills. |

También borra `~/.gemini/config/sidecars/open-agent-bridge` (instalaciones anteriores). Si queda una entrada vieja en `.agents/mcp_config.json` (p. ej. un servidor `agent-bridge` con `--project` fijo), agy levanta un segundo adapter: borrala. `oab doctor` verifica el plugin con `agy plugin list --json`.

## 2. Entrega en vivo: `attach`

El language server de agy puede arrancar un turno en la conversación viva con `SendUserCascadeMessage`, pero solo acepta RPCs con un token CSRF (`x-codeium-csrf-token`). agy entrega la dirección y el token (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`) **solo a los comandos que corre su propio agente**:

| Proceso | Recibe dirección + token |
|---|---|
| Servidor MCP (el adapter) | No |
| Hooks | No — solo `ANTIGRAVITY_CONVERSATION_ID` |
| Comandos del agente (`run_command`) | Sí |
| Sidecars | El CLI `agy` no los corre (son del Antigravity app) |

Por eso:

1. En el primer turno de cada sesión, el hook `SessionStart` devuelve `injectSteps` pidiéndole al agente que corra `open-agent-bridge antigravity attach` (la primera vez agy puede pedir permiso).
2. `attach` guarda dirección, token y conversación en `$XDG_RUNTIME_DIR/open-agent-bridge/agy-<pidDeAgy>.json` (0600, directorio 0700). Busca el pid de agy subiendo por los ancestros y saltando shells.
3. Cada hook posterior reescribe la conversación con el token ya guardado, así el archivo sigue `/new` y los resumes. Basta un `attach` por proceso de agy.
4. El adapter MCP es hijo directo de agy: lee `agy-<process.ppid>.json` y entrega cada mensaje con `SendUserCascadeMessage`:
   - `messageOrigin: AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE`;
   - `deliveryStrategy: MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE` — turno inmediato si agy está quieto, después del turno en curso si no;
   - `cascadeConfig` y `customAgentSpec` copiados del último mensaje del usuario (`GetCascadeTrajectory`). Sin un plan model agy rechaza el turno (`plan model not specified`); así además se respeta el modelo que eligió el usuario.
5. Si el RPC falla, el mensaje queda pendiente (sin ack) y lo reintenta el sync del registry.

Si falta alguna pieza, el hook escribe en stderr (agy lo copia a `~/.gemini/antigravity-cli/log/`) `[antigravity] live delivery off — missing …`, con nombres de variables, nunca valores.

## 3. Sin `attach`

Antes del primer turno, o si no se aprobó el comando, el adapter no tiene la conversación: deja el mensaje pendiente, sin ack ni notificación (agy no las muestra). Lo entrega el hook `Stop` al terminar el próximo turno, o el sync del registry en cuanto el agente corra `attach`.

## 4. Hooks (contrato de agy 1.3)

- Se ejecutan con `sh -c` y con el directorio del plugin como cwd: el proyecto sale de `workspacePaths` del payload (o `--project`).
- `hook-stop` — si hay mensajes pendientes para esta sesión devuelve `{"decision":"continue","reason":"…"}` y agy sigue trabajando para contestarlos (agy 1.3 ignora `"block"`). También los anexa a `.agents/ORIGINAL_REQUEST.md`.
- `hook-session-start` — devuelve `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}` con la instrucción de `attach` (si hace falta) y el número de mensajes pendientes.
- Opciones comunes: `--project`, `--registry-url` (`http://localhost:4999`), `--client-id`, `--identity` (`global`).

## 5. Salida (`agy` → canal)

El agente usa las tools MCP `reply` y `message_client_session`. `message_client_session` reusa un hilo por par de agentes (id determinístico) salvo que se pase `conversationId`.

## 6. Enfoques descartados

| Enfoque | Por qué no |
|---|---|
| `antigravity ls-push` (polling + `SendUserCascadeMessage` sin token) | agy ≥ 1.3 responde `401 missing CSRF token`. Queda solo para versiones anteriores. |
| Sidecar en `~/.gemini/config/sidecars/` o dentro del plugin | El CLI `agy` no ejecuta sidecars, ni siquiera habilitados en `~/.gemini/config/config.json`. |
| Stop hook con `{"decision":"block"}` | agy 1.3 lo ignora; el valor válido es `"continue"`. |
| `agy -p --conversation <id>` desde un daemon | Reproduce el transcript completo en stdout y no entra en la TUI viva. |
| `tmux send-keys` | Depende del multiplexor y escribe en la terminal del usuario. |

## 7. Pendiente / sin verificar

- `--identity` con agy: el plugin registra el MCP sin identity (namespace `global`); cómo fijar una identity por sesión no está verificado.

## 8. Fuentes

- Documentación embebida de agy: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/{hooks,plugins}.md` y el skill `plugin` (uso de `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN`).
- [Antigravity Sidecars](https://antigravity.google/docs/sidecars) · [Hooks](https://antigravity.google/docs/hooks) · [MCP](https://antigravity.google/docs/mcp) · [Using AGY CLI](https://antigravity.google/docs/cli-using)
- Código: `src/cli/commands/antigravity.ts`, `src/client/antigravity-ls-client.ts`, `src/client/antigravity-hooks.ts`, `src/mcp/adapter.ts` (`deliverChannelMessage`), `plugins/open-agent-bridge/hooks.json`.
