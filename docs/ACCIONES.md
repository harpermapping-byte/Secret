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

**Comportamiento de los clientes en `PHASE_END`:** ni la web pública ni el panel de admin borran nada al llegar a esta fase — siguen mostrando el mapa y las estadísticas finales tal cual estaban (`getPublicState()`/`getAdminState()` no cambian sus campos al terminar, solo `phase`). La web pública añade un banner flotante NO bloqueante (`#winner` en `public/index.html`, función `renderEndBanner()`) que avisa de que la partida terminó sin tapar el mapa/clasificación. El panel de admin cambia los botones de "en curso" por uno de "🔄 Nueva partida" (`resetToConfig()`), que solo muestra de nuevo el formulario de configuración — la partida anterior sigue existiendo en el servidor hasta que se manda un `admin:createMatch` de verdad.

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
| `createMatch(config)` | Fase 0. Crea el estado inicial de partida a partir de la configuración del admin — **reemplaza** `match` entero, sin importar si ya había una partida en curso o terminada (no hay guardia de fase). Es la misma función que usa el flujo de "reiniciar partida" tras `PHASE_END`: el panel de admin (`resetToConfig()` en `admin/index.html`) simplemente vuelve a mostrar el formulario de configuración y el admin manda otro `admin:createMatch` con los ajustes nuevos, ver sección 5. |
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
| `getMapLayout()` | Devuelve la geometría estática del mapa (`match.mapLayout`) o `null` si no hay partida. Ver sección 6. |
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
| `map:layout` | Ambos | Resultado de `getMapLayout()` (ver sección 6). Se manda una única vez por partida — al crearla (`admin:createMatch`) y a cualquier cliente que se conecte mientras ya hay una partida en curso — nunca dentro de `state:public`/`state:admin`, porque no cambia ronda a ronda y pesa demasiado para repetirlo en cada broadcast. |

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
Player   { userId, username, factionNumber, alive, unitType, participation, diedOnRound }
Faction  { id, number, name, color, territoryIds: [], industry, industryGainedLastRound, industryTierIndex,
           industryPenaltyNextRound, specialEnabled, specialAbility, specialUsed, killsCaused }
Tile     { id, neighborIds: [], ownerFactionNumber | null, neutral, garrison }
Match    { phase, config, players: Map<userId, Player>, factions: [Faction], tiles: [Tile], round, timers,
           lastAttackerOf, activeAlliancePairsThisRound, combatModifiers, summaryBlocks, winnerFactionNumber }
```

Estos nombres de campo son fijos en todo el proyecto. No se usan sinónimos (por ejemplo, siempre `factionNumber`, nunca `faction_id` ni `teamId`).

**Geometría del mapa (`match.mapLayout`, ver `server/mapTemplates.js`):**

```
mapLayout { cols, rows, cellTileIds: [tileId por celda del raster, longitud cols*rows], centroids: [{x,y} por tile, en coordenadas de raster] }
```

El mapa es un rectángulo raster (`RASTER_COLS` x `RASTER_ROWS`, constantes de `mapTemplates.js`) repartido entre los `tileCount` territorios mediante puntos semilla (efecto visual tipo Voronoi, sin librería de geometría). `tile.neighborIds` sale de recorrer ese raster una vez: dos territorios son vecinos si en algún punto quedan pegados — es la adyacencia REAL que usa el motor (combate, expansión, adyacencia para habilidades), no una capa aparte solo visual. `mapLayout` no cambia durante la partida, así que viaja por su propio mensaje `map:layout` (sección 5), no dentro de `tiles`. Tanto la web pública como el panel de admin dibujan el mismo rectángulo con el mismo módulo cliente, `public/mapRenderer.js` (servido también en `/mapRenderer.js` desde el panel de admin) — es el único sitio del proyecto que sabe pintar el mapa; ninguna otra pantalla reimplementa este dibujado.

`getPublicState().factions[i]` añade además dos campos derivados solo para mostrar en la web (no viven en `Faction`, se calculan al serializar): `territoryCount` (= `territoryIds.length`) y `wondersCount` (siempre `0` en v1, reservado para cuando se implementen las maravillas — ver GDD "Alcance de v1 vs futuro").

**Zoom/paneo del mapa (`public/mapRenderer.js`):** el mapa se comporta como un fondo tipo Google Maps, nunca como un elemento suelto dentro del viewport. No hay una escala mínima fija (`MIN_SCALE`) — la escala mínima siempre se recalcula con `coverScale()` = `max(viewport.width/canvas.width, viewport.height/canvas.height)`, así que el zoom-out máximo siempre deja el mapa ocupando toda la pantalla, nunca más pequeño. Todo cambio de escala o de posición (`reset()`, `zoom()`, arrastrar con el ratón, `resize` de ventana) pasa por el único punto `setView(scale, x, y)`, que aplica ese límite de escala y además recorta `x`/`y` con `clampPan()` para que nunca se pueda arrastrar el mapa dejando hueco vacío en ningún borde. La resolución del raster (`RASTER_COLS`/`RASTER_ROWS` en `server/mapTemplates.js`, 440×280) se dobló respecto a la primera versión (220×140) para que las fronteras se vean nítidas también al hacer zoom de cerca a una sola división — generar el mapa sigue costando poco (una sola vez por partida, no por frame).

**Búsqueda de facción por número:** una única función en todo el proyecto, `factionByNumber(match, number)`, exportada desde `server/rules/territory.js`. Todo módulo que necesite buscar una facción por su número la importa de ahí — no se reimplementa `.find()` inline ni se duplica con otro nombre. La única excepción es `findInFactionList(factions, number)` dentro de `gameEngine.js`, usada solo en `createMatch()` en el instante en que el array de facciones existe pero `match` todavía no.

**Bloques del resumen de ronda (`match.summaryBlocks`, uno por `kind`):**

| `kind` | Forma de `data` | Contenido |
|---|---|---|
| `industry` | `[{ faction, industry, gained }]` | `industry` = total acumulado tras la ronda; `gained` = lo que sumó *esta* ronda (votos `!industria` + pasivo por territorio, o `0` si tenía penalización de Sabotaje). |
| `territory` | `[{ faction, territories }]` | Recuento de casillas al cierre de la ronda. |
| `conquests` | `[{ tileId, fromFactionNumber, toFactionNumber, kind }]` | Casillas que cambiaron de dueño esta ronda. `kind` es `'attack'` (combate) o `'expansion'` (`!expansion` sobre neutral, `fromFactionNumber: null`). |
| `combats` | `[{ attackerFactionNumber, defenderFactionNumber, outcome }]` | Una entrada por cada facción atacante que participó en cada combate. `outcome` es `'attacker_won'`, `'attacker_lost'` (perdió el combate pero otra facción atacante sí ganó) o `'defender_held'` (la defensa aguantó). |
| `industryUnlocks` | `[{ factionNumber, tierKey }]` | Mejoras de industria desbloqueadas esta ronda (`tierKey` = una de `INDUSTRY_TIERS`: `tanque`, `bombardeo`, `tanque_x2`, `operacion_especial`). |
| `casualties` | `[{ username, factionNumber }]` | Jugadores que murieron esta ronda. |

`killsCaused` (bajas causadas, acumulado de toda la partida, campo de `Faction`) se incrementa desde `applyCasualties(match, context, factionNumber, count, causedByFactionNumber)` en `rules/shared.js` — el único punto donde se matan jugadores, así que es el único punto donde se contabilizan bajas causadas. Los llamantes (`resolveCombat`, `applyBombardeo`, `applyOperacionEspecial`) pasan qué facción es la responsable; si no aplica (nadie causó las bajas), se omite el último argumento.

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
