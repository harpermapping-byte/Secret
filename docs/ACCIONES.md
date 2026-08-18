# Biblioteca de acciones — Condejorge Wars

> Diccionario único de nombres. Antes de escribir una función, evento o comando nuevo, se busca aquí primero. Si ya existe algo que hace lo mismo, se reutiliza. Si no existe, se añade aquí con su nombre definitivo antes de escribirlo en el código. Nunca dos nombres distintos para la misma cosa.

Convención: identificadores de código en inglés (estándar de programación), términos de dominio del juego en español dentro de comentarios y en este documento. Cada fila de las tablas de abajo es la única fuente de verdad para ese nombre.

---

## 1. Fases de partida (`server/phases.js`)

| Constante | Valor interno | Fase del diseño |
|---|---|---|
| `PHASE_CONFIG` | `"config"` | Fase 0 — Configuración |
| `PHASE_RECRUITMENT` | `"recruitment"` | Fase de Reclutamiento |
| `PHASE_ACTION` | `"action"` | Fase de Acción |
| `PHASE_RESOLUTION` | `"resolution"` | Fase de Desarrollo/Combate |
| `PHASE_SUMMARY` | `"summary"` | Fase de Resumen |
| `PHASE_END` | `"end"` | Fin de partida |

Solo `gameEngine.js` puede cambiar la fase actual. Ningún otro módulo la modifica directamente.

## 2. Comandos de chat → tipo de acción (`server/commands.js`)

| Comando en chat | Constante de acción | Fase en la que es válido |
|---|---|---|
| `!faccion<N>` | `ACTION_JOIN_FACTION` | `PHASE_RECRUITMENT` |
| `!industria` | `ACTION_INDUSTRY` | `PHASE_ACTION` |
| `!ataque <N>` | `ACTION_ATTACK` | `PHASE_ACTION` |
| `!defender` | `ACTION_DEFEND` | `PHASE_ACTION` |
| `!expansion` | `ACTION_EXPAND` | `PHASE_ACTION` (sin efecto si el mapa es de reparto total) |
| `!especial` | `ACTION_SPECIAL` | `PHASE_ACTION` |
| `!alianza <N>` | `ACTION_ALLIANCE` | `PHASE_ACTION` (solo si la partida tiene alianzas activadas) |

Solo `commands.js` interpreta texto de chat. Ningún otro módulo hace parsing de comandos por su cuenta.

## 3. Funciones públicas del motor (`server/gameEngine.js`)

Es el único módulo con autoridad sobre las reglas y el estado. Una función = una responsabilidad, sin duplicados:

| Función | Qué hace |
|---|---|
| `createMatch(config)` | Fase 0. Crea el estado inicial de partida a partir de la configuración del admin. |
| `startMatch()` | `PHASE_CONFIG` → `PHASE_RECRUITMENT`. Arranca el timer de reclutamiento. |
| `handleChatCommand(userId, username, channel, text)` | **Único punto de entrada** para cualquier mensaje de chat. Parsea con `commands.js`, valida fase y estado del usuario, y delega en la función concreta de abajo. |
| `joinFaction(userId, username, factionNumber)` | Registra o cambia la facción de un usuario. Solo llamable durante `PHASE_RECRUITMENT`. |
| `closeRecruitment()` | `PHASE_RECRUITMENT` → `PHASE_ACTION`. Fija el roster para el resto de la partida. |
| `castAction(userId, actionType, targetFactionNumber)` | Guarda el voto de un usuario para la ronda actual, sobrescribiendo cualquier voto anterior suyo esa misma ronda. |
| `closeActionPhase()` | `PHASE_ACTION` → `PHASE_RESOLUTION`. Cierra la votación y dispara la resolución de la ronda. |
| `resolveRound()` | Orquesta la resolución completa de la ronda llamando, en orden, a `resolveIndustry()`, `resolveExpansion()`, `resolveAlliances()`, `resolveCombat()`, `resolveSpecialAbilities()`. No contiene lógica de reglas propia, solo orden de ejecución. |
| `resolveIndustry()` | Suma la industria de cada facción y aplica mejoras automáticas si se alcanza un umbral. |
| `resolveExpansion()` | Resuelve los intentos de `!expansion` contra territorio neutral. |
| `resolveAlliances()` | Calcula qué alianzas se activan esa ronda y qué ataques quedan invalidados por ellas. |
| `resolveCombat()` | Agrupa todos los ataques entrantes por facción objetivo, resuelve el combate simultáneo con azar y aplica la jerarquía de bajas. |
| `resolveSpecialAbilities()` | Comprueba qué facciones alcanzan el % de `!especial` y aplica el efecto de su habilidad (una sola vez por partida). |
| `buildRoundSummary()` | `PHASE_RESOLUTION` → `PHASE_SUMMARY`. Genera la lista de bloques de estadísticas a mostrar. |
| `advanceRound()` | `PHASE_SUMMARY` → `PHASE_ACTION` (o `PHASE_END` si `checkVictory()` ya tiene ganador). |
| `checkVictory()` | Función pura: devuelve la facción ganadora si solo queda una con territorio, si no `null`. |
| `pauseTimer()` / `resumeTimer()` | Control admin: congela o reanuda el timer de la fase actual. |
| `forceAdvancePhase()` | Control admin: salta el timer y pasa a la siguiente fase ya. |
| `endMatch()` | Control admin: finaliza la partida en cualquier momento. |
| `getPublicState()` | Serializa el estado para la web pública (sin datos privados de admin). |
| `getAdminState()` | Serializa el estado para el panel de admin. |
| `setStateChangeListener(fn)` | Registra el callback que el servidor WS usa para retransmitir el estado cada vez que algo cambia (unión, acción, cambio de fase, controles admin). |

## 4. Eventos del bot de Twitch (`server/twitchBot.js`)

| Función | Qué hace |
|---|---|
| `connectToChannels(channelList)` | Une un único cliente de lectura a todos los canales configurados en la Fase 0. |
| `onChatMessage(channel, tags, text)` | Handler interno de la librería de chat. Extrae `{ userId, username }` de `tags` y llama **directamente** a `gameEngine.handleChatCommand(...)`. No parsea comandos ni decide reglas — eso es trabajo exclusivo del motor. |

## 5. Mensajes WebSocket

**Servidor → clientes** (`server/wsServer.js`, función única `broadcastState()`):

| Tipo | A quién | Contenido |
|---|---|---|
| `state:public` | Web pública | Resultado de `getPublicState()` |
| `state:admin` | Panel admin (autenticado) | Resultado de `getAdminState()` |

**Panel admin → servidor** (requieren sesión admin válida):

| Tipo | Función del motor que dispara |
|---|---|
| `admin:createMatch` | `createMatch(config)` |
| `admin:startMatch` | `startMatch()` |
| `admin:pause` | `pauseTimer()` |
| `admin:resume` | `resumeTimer()` |
| `admin:advancePhase` | `forceAdvancePhase()` |
| `admin:endMatch` | `endMatch()` |

Un único `switch` en `wsServer.js` traduce cada tipo de mensaje a su función del motor 1:1. No se duplica lógica de validación fuera de `gameEngine.js`.

## 6. Formas de datos del estado (referencia de nombres de campos)

```
Player   { userId, username, factionId, alive, unitType, actedThisRound, lastAction, lastTarget }
Faction  { id, number, name, color, territoryIds: [], industry, specialEnabled, specialUsed }
Tile     { id, ownerFactionId | null, neutral, garrison }
Match    { phase, config, players: Map<userId, Player>, factions: [Faction], tiles: [Tile], round, timers }
```

Estos nombres de campo son fijos en todo el proyecto. No se usan sinónimos (por ejemplo, siempre `factionId`, nunca `faction_id` ni `teamId`).

## 7. Constantes de ejemplo ya implementadas (server/rules/*.js)

Valores puestos para que el motor funcione y se pueda probar; son placeholders a afinar jugando partidas de prueba, no números definitivos:

| Constante | Archivo | Valor de ejemplo |
|---|---|---|
| `COMBAT_RANDOM_MIN` / `MAX` | `rules/shared.js` | 0.5 – 1.5 por unidad |
| `BASE_GARRISON_PER_TERRITORY` | `rules/combat.js` | 0.3 |
| `PASSIVE_INDUSTRY_PER_TERRITORY` | `rules/industry.js` | 0.2 |
| `INDUSTRY_TIERS` (umbrales de las 4 mejoras) | `rules/industry.js` | 100 / 250 / 500 / 800 |
| `BOMBARDEO_DAMAGE`, `OPESPECIAL_DAMAGE` | `rules/industry.js` | 3 bajas |
| `REFUERZO_REVIVE_COUNT` | `rules/specialAbilities.js` | 3 revividos |
| `ESCUDO_DEFENSE_BONUS_PERCENT`, `FRENESI_ATTACK_BONUS_PERCENT` | `rules/specialAbilities.js` | 30% |
| `SUMMARY_MS_PER_BLOCK` | `gameEngine.js` | 12000 ms |

**Simplificaciones de v1 respecto al diseño original, a revisar:**
- Bombardeo (mejora 2) reparte bajas con la prioridad de la ronda **actual** (inactivos de esta ronda), no de la ronda anterior como se describió en el diseño — matizar si hace falta más precisión.
- Sabotaje elige objetivo automáticamente (el que más votos de `!ataque` recibió de esa facción esta ronda, o un vecino al azar si no atacó a nadie) porque el diseño no especificaba cómo se elegía el objetivo por chat.
- Solo el bando perdedor de un combate sufre bajas; el bando ganador no pierde nada en v1 (simplificación para no complicar el primer motor).

## 8. Pendiente de documentar aquí cuando se implemente

- Eventos aleatorios (v2, no en el alcance de v1).
- Plantillas de mapa reales con arte (v1 usa un anillo generado, ver `mapTemplates.js`).
