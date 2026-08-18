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

**Comportamiento de los clientes en `PHASE_END`:** ni la web pública ni el panel de admin borran nada al llegar a esta fase — siguen mostrando el mapa y las estadísticas finales tal cual estaban (`getPublicState()`/`getAdminState()` no cambian sus campos al terminar, solo `phase`). La web pública añade un banner flotante NO bloqueante (`#winner` en `public/index.html`, función `renderEndBanner()`) que avisa de que la partida terminó sin tapar el mapa/clasificación, y automáticamente (una sola vez por partida) abre `matchEndModal`, el popup a pantalla completa con el resumen final por facción — ver sección 6 "Resumen final de partida". El banner sigue visible después de cerrar el popup, con un enlace "ver resumen" para volver a abrirlo. El panel de admin cambia los botones de "en curso" por uno de "🔄 Nueva partida" (`resetToConfig()`), que solo muestra de nuevo el formulario de configuración — la partida anterior sigue existiendo en el servidor hasta que se manda un `admin:createMatch` de verdad. El panel de admin no tiene el popup de resumen final propio (todavía no está confirmada la unificación visual admin/pública) pero ya ve los mismos datos finales en sus tarjetas de facción de siempre.

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
| `resolveCombat()` | Agrupa todos los ataques entrantes por facción objetivo, resuelve el combate simultáneo con azar y aplica la jerarquía de bajas. Tras cada `applyCasualties()` (tanto al bando defensor que pierde el combate como a los atacantes cuando la defensa aguanta) llama a `checkFactionElimination()` — ver sección 6 "Eliminación de facciones". |
| `resolveSpecialAbilities()` | Comprueba qué facciones alcanzan el % de `!especial` y aplica el efecto de su habilidad (una sola vez por partida). |
| `buildRoundSummary()` | `PHASE_RESOLUTION` → `PHASE_SUMMARY`. Genera la lista de bloques de estadísticas a mostrar. |
| `advanceRound()` | `PHASE_SUMMARY` → `PHASE_ACTION` (o `PHASE_END` si `checkVictory()` ya tiene ganador). |
| `checkVictory()` | Función pura: devuelve la facción ganadora si solo queda una con territorio, si no `null`. No hace falta que compruebe jugadores vivos por separado: `checkFactionElimination()` (sección 6) ya deja a una facción sin miembros con `territoryIds.length === 0` en el mismo instante en que ocurre, así que "solo queda una con territorio" y "solo queda una con miembros" son siempre la misma facción. |
| `pauseTimer()` / `resumeTimer()` | Control admin: congela o reanuda el timer de la fase actual. |
| `forceAdvancePhase()` | Control admin: salta el timer y pasa a la siguiente fase ya. |
| `endMatch()` | Control admin: finaliza la partida en cualquier momento. |
| `getPublicState()` | Serializa el estado para la web pública (sin datos privados de admin). |
| `getAdminState()` | Serializa el estado para el panel de admin, incluyendo `chatLog` (ver más abajo). El bot de Twitch se compone aparte con `botStatus` a nivel de `server/index.js`, no aquí — ver sección 4. |
| `getMapLayout()` | Devuelve la geometría estática del mapa (`match.mapLayout`) o `null` si no hay partida. Ver sección 6. |
| `setStateChangeListener(fn)` | Registra el callback que el servidor WS usa para retransmitir el estado cada vez que algo cambia (unión, acción, cambio de fase, controles admin). |
| `pushChatLog(entry)` | Interno, no exportado. Añade una entrada a `recentChatLog` (últimos `MAX_CHAT_LOG=15` intentos de comando de chat **reconocidos**, aceptados o rechazados con motivo — no registra cualquier mensaje de chat, solo los que `commands.parseCommand()` reconoce como sintaxis de comando). Se llama desde los tres puntos de salida de `handleChatCommand()`: fase incorrecta, unión de facción, y cualquier otra acción. Pensado para que el admin pueda ver en el panel *por qué* un `!faccion1` no hizo nada (la razón más común: la partida todavía no está en `PHASE_RECRUITMENT`) sin tener que mirar los logs del servidor. |

## 4. Eventos del bot de Twitch (`server/twitchBot.js`)

| Función | Qué hace |
|---|---|
| `connectToChannels(channelNames, onCommand)` | Conecta (login IRC anónimo `justinfan<N>`) y une un único cliente de lectura a todos los canales configurados en la Fase 0. Si el WebSocket se cierra, reintenta solo a los 5s. Si `WebSocket` no existe como global (Node < 22), falla de forma visible en vez de lanzar un `ReferenceError` críptico. |
| `handleLine(line)` | Interno. Parsea cada línea IRC ya recibida y actúa según el comando IRC (`PING`→responde `PONG`, `366`→confirma unión a canal, `NOTICE`→aviso de Twitch, `PRIVMSG`→extrae `{userId, username, channel, text}` y llama **directamente** a `onCommand(...)`, que en `server/index.js` es `gameEngine.handleChatCommand(...)`). No parsea comandos del juego ni decide reglas — eso es trabajo exclusivo del motor. |
| `getStatus()` | Devuelve el estado de conexión actual: `{ state, channels, joinedChannels, lastError, lastMessageAt }`, con `state` uno de `'disconnected' \| 'connecting' \| 'connected' \| 'reconnecting' \| 'error'`. Pensado para que el panel de admin pueda ver de un vistazo si el bot está realmente conectado y unido al canal — sin esto, un fallo de conexión (canal mal escrito, red bloqueada, Node viejo) es invisible: solo se vería que `!faccion1` no hace nada, sin saber por qué. |
| `onStatusChange(fn)` | Registra el callback que dispara `server/index.js` cada vez que `status` cambia, para retransmitir un `state:admin` nuevo sin esperar al siguiente cambio de partida (ver sección 5). |

## 5. Mensajes WebSocket

**Servidor → clientes** (`server/wsServer.js`, función única `broadcastState()`):

| Tipo | A quién | Contenido |
|---|---|---|
| `state:public` | Web pública | Resultado de `getPublicState()` |
| `state:admin` | Panel admin (autenticado) | Resultado de `getAdminState()` (incluye `chatLog`) fusionado con `botStatus: twitchBot.getStatus()` — la combinación la construye `buildAdminState()` en `server/index.js`, no `gameEngine.js` (el motor no conoce el bot). Se retransmite tanto en cada cambio de partida como, por separado, cada vez que `twitchBot.onStatusChange()` dispara (conectando, unido a canal, error, reconectando), para que el estado del bot en el panel no se quede desactualizado esperando a la siguiente acción de juego. |
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

Esta es la forma INTERNA que usa el servidor (`gameEngine.js`, `mapTemplates.js`). **Por el WebSocket viaja distinto** — ver "Formato de `map:layout` por el cable" un poco más abajo.

**Formato de `map:layout` por el cable (`server/mapLayoutCodec.js` ↔ `public/mapRenderer.js`):** `cellTileIds` NO se manda como el array JSON de arriba — a la resolución actual del mapa (4400×2302 = 10.128.800 celdas) ese array pesaría ~27,5MB por mensaje, mandado a cada cliente conectado (y de nuevo a cada espectador que se conecta durante la partida). Se empaqueta antes de mandarlo:

```
payload de `map:layout` { cols, rows, centroids, cellTileIdsPacked: { bytesPerCell, base64 } }
```

`encodeCellTileIds(cellTileIds, tileCount)` en `server/mapLayoutCodec.js` codifica OCEAN(`-1`) como `0` y cualquier tile id `N` como `N+1`, empaquetado a 1 byte/celda si `tileCount <= 255`, o 2 bytes/celda (big-endian) si no (hasta 65534 territorios — por encima de eso lanza un error claro en vez de desbordar en silencio), y el resultado se codifica en base64 (misma técnica que `server/worldLandMask.js`). `decodeCellTileIds()` en `public/mapRenderer.js` hace la operación inversa dentro de `setLayout()`, así que el resto del módulo (todo lo que usa `layout.cellTileIds`) no sabe ni le importa que por la red viajó empaquetado. **El formato tiene que coincidir exactamente entre los dos archivos — si se cambia uno, se cambia el otro.** Esto es la "opción B" de una discusión con el usuario sobre por qué "Iniciar partida" podía sentirse colgado incluso después de optimizar el pintado del canvas (ver más abajo, "Rendimiento del repintado"): el mensaje de 27,5MB en JSON plano obligaba al navegador a hacer `JSON.parse` de ~10 millones de números sueltos, mucho más caro que parsear un único string largo — bajarlo a ~13MB (bytesPerCell=1 en el caso típico) reduce el peso a la mitad y cambia la naturaleza del parseo. Queda pendiente de discutir con el usuario la "opción A" (mandar el mapa como una imagen ya renderizada en el servidor en vez de datos crudos, comprimiría mucho más al aprovechar las zonas de color plano) — no implementada todavía, ver sección 8. `server/index.js` cachea el mensaje ya codificado (`cachedMapLayoutMessage`) y lo reutiliza para cada cliente que se conecta durante la partida, en vez de repetir el empaquetado/base64 por cada conexión nueva.

El mapa es el planeta real (silueta de continentes/océanos, proyección equirectangular, `RASTER_COLS` x `RASTER_ROWS` = 4400x2302, recortado al norte de -58° de latitud para excluir la Antártida — no tiene ciudades ni combate, ver `server/worldLandMask.js`) repartido en `tileCount` territorios SOLO sobre tierra, mediante puntos semilla colocados exclusivamente en celdas de tierra (efecto visual tipo Voronoi, sin librería de geometría, ver `placeSeedsOnLand()` en `mapTemplates.js`). El océano nunca se reparte — las celdas de océano quedan con el sentinel `OCEAN` (`-1`) en `cellTileIds`, sin dueño, sin tile. `tile.neighborIds` sale de recorrer ese raster una vez: dos territorios son vecinos si en algún punto quedan pegados (y ninguno es océano) — es la adyacencia REAL que usa el motor (combate, expansión, adyacencia para habilidades), no una capa aparte solo visual. Las piezas ignoran a propósito las fronteras políticas reales (no son países, son cortes irregulares estilo Risk sobre la tierra real, en la cantidad que decida el admin). `mapLayout` no cambia durante la partida, así que viaja por su propio mensaje `map:layout` (sección 5), no dentro de `tiles`. Tanto la web pública como el panel de admin dibujan el mismo mapa con el mismo módulo cliente, `public/mapRenderer.js` (servido también en `/mapRenderer.js` desde el panel de admin) — es el único sitio del proyecto que sabe pintar el mapa; ninguna otra pantalla reimplementa este dibujado.

**Silueta tierra/océano (`server/worldLandMask.js`):** la silueta real del planeta a la resolución del raster está horneada en este módulo como 1 bit por celda (1 = tierra, 0 = océano), empaquetada en base64 — se generó UNA VEZ a partir de datos públicos de costas (Natural Earth, capa "land" a 110m, dominio público, sin copyright ni atribución requerida) y se decodifica al arrancar el servidor con `decodeLandMask()`, sin ninguna librería de imágenes/geometría en tiempo de ejecución. Se recorta a propósito todo lo que queda al sur de -58° de latitud (la Antártida): no tiene ciudades ni combate, así que no ocupa espacio del raster ni puede recibir semillas/territorios. Es un placeholder de color deliberado (sin textura/relieve real todavía) para evitar cualquier duda de derechos de autor sobre el arte visual — cuando se quiera un mapa con arte final, este módulo es lo único que hay que sustituir; el resto del pipeline (`mapTemplates.js`, `mapRenderer.js`) no depende de que sea un placeholder. Si se quiere cambiar la resolución o el recorte hay que regenerar el archivo entero (no se puede editar a mano): descargar `ne_110m_land.geojson` de Natural Earth, rasterizarlo con PIL a `COLS`x`ROWS_completo` (proyección equirectangular directa: `x = (lon+180)/360*COLS`, `y = (90-lat)/180*ROWS_completo`), recortar filas por debajo de la latitud de corte, y volver a empaquetar en base64 (1 bit por celda, fila por fila).

`getPublicState().factions[i]` añade además dos campos derivados solo para mostrar en la web (no viven en `Faction`, se calculan al serializar): `territoryCount` (= `territoryIds.length`) y `wondersCount` (siempre `0` en v1, reservado para cuando se implementen las maravillas — ver GDD "Alcance de v1 vs futuro").

**Zoom/paneo del mapa (`public/mapRenderer.js`):** el mapa se comporta como un fondo tipo Google Maps, nunca como un elemento suelto dentro del viewport. No hay una escala mínima fija (`MIN_SCALE`) — la escala mínima siempre se recalcula con `coverScale()` = `max(viewport.width/canvas.width, viewport.height/canvas.height)`, así que el zoom-out máximo siempre deja el mapa ocupando toda la pantalla, nunca más pequeño; como el océano (sin repartir) ocupa la mayor parte del lienzo, ese zoom mínimo ya deja aire de sobra alrededor de la tierra sin necesidad de ningún margen artificial. El zoom máximo (`MAX_SCALE`) es moderado (2.5x) — lo justo para ver un territorio y sus vecinos con claridad para las animaciones de combate, no para acercarse al detalle. Todo cambio de escala o de posición (`reset()`, `zoom()`, arrastrar con el ratón, `resize` de ventana) pasa por el único punto `setView(scale, x, y)`, que aplica ese límite de escala y además recorta `x`/`y` con `clampPan()` para que nunca se pueda arrastrar el mapa dejando hueco vacío en ningún borde. Los botones `+`/`−`/`⤾` de `.mapToolbar` llaman directamente a `mapCtrl.zoom(factor)`/`mapCtrl.reset()` desde el `onclick` (en ambas páginas, `admin/index.html` y `public/index.html`) — antes existían `mapZoom()`/`mapReset()` como funciones envoltorio de una sola línea en cada página, duplicadas entre sí sin aportar nada (existían solo para poder llamarlas desde `onclick`); se eliminaron en la auditoría de cierre de v1 porque `mapCtrl` ya es una variable de nivel superior visible desde los atributos `onclick` del mismo documento. La resolución del raster (`server/worldLandMask.js`) pasó por dos incrementos: primero 440×280 → 2200×1151 (5x), y después 2200×1151 → 4400×2302 (2x más) porque a la resolución anterior el mapa se seguía viendo "a bloques" al hacer zoom (cada celda del raster se notaba como un cuadrado de color liso, ya que `BLOCK_PX=2` escalaba cada celda x2 con nearest-neighbor). En la resolución actual, `BLOCK_PX` en `mapRenderer.js` bajó de 2 a 1: el raster ya trae el detalle nativo (no hace falta escalarlo x2), así que el canvas final en pantalla sigue teniendo el mismo tamaño de siempre (4400×2302×1 ≈ 10M píxeles, el mismo presupuesto que antes) sin perder fluidez. Generar un mapa a esta resolución tarda más que antes (medido ~600-1100ms según `tileCount`, frente a ~130-200ms a la resolución anterior — el coste principal es `rasterizeLand()`, que compara cada celda de tierra contra cada semilla, O(landCells × tileCount); con 4x más celdas de tierra el coste sube proporcionalmente) pero sigue siendo una sola vez por partida (al pulsar "Crear partida"), no por frame, así que no afecta a la fluidez del juego en curso. `placeSeedsOnLand()` sigue barajando la lista de celdas de tierra UNA sola vez y reutilizando ese orden en todas las rondas de relajación de distancia mínima, en vez de rebarajar cada ronda. En el pintado hay tres colores distintos: `BORDER_COLOR` (frontera entre dos territorios de tierra), `COAST_COLOR` (línea de costa, entre tierra y océano) y `OCEAN_COLOR` (océano liso). Si en el futuro hace falta más resolución todavía y la generación empieza a notarse lenta, el siguiente paso sería sustituir la búsqueda de semilla más cercana por fuerza bruta en `rasterizeLand()` por una estructura espacial (rejilla de cubos/celdas vecinas), no seguir subiendo solo la resolución.

**Rendimiento del repintado (`public/mapRenderer.js`) — por qué "Iniciar partida" llegó a sentirse roto:** al doblar la resolución del raster a 4400×2302, el bucle que clasifica cada celda (¿es borde entre dos territorios?, ¿es línea de costa?, ¿océano liso?) pasó de recorrer ~2.5M celdas a ~10M, y ese bucle se ejecutaba en CADA repintado — incluyendo repintados que no dibujaban nada nuevo del tablero, solo porque llegó un `state:admin` por un cambio de estado del bot de Twitch (sección 4). Justo al pulsar "Iniciar partida" llegan varios `state:*` seguidos (cambio de fase + el bot conectando/reconectando), así que se notaba como que la página se quedaba pillada. Se solucionó con dos cambios:
1. `computeCellRenderKind(layout)` clasifica cada celda UNA sola vez por `mapLayout` (esa clasificación no depende de qué facción sea dueña de cada casilla, solo de la geometría fija tierra/océano/fronteras) y guarda el resultado en `cellRenderKind` (`Uint8Array`, valores `KIND_OCEAN`/`KIND_COAST`/`KIND_BORDER`/`KIND_LAND`). `paintRaster()` ahora solo hace una búsqueda barata por celda en ese array en vez de comparar los 4 vecinos cada vez.
2. `paint()` calcula un "fingerprint" (string) de qué color tiene cada casilla ahora mismo y lo compara con el del último pintado — si no cambió (por ejemplo, el repintado lo disparó solo el estado del bot), se salta `paintRaster()` entero. Los marcadores de jugador y las etiquetas de casilla (ver más abajo) se repintan siempre, porque son baratos.

Esto exigió separar el dibujado en dos `<canvas>` superpuestos con el mismo `transform` (ver `applyTransform()`): `#mapCanvas` (el raster caro, `canvasEl`) y `#mapMarkers` (capa barata de etiquetas + marcadores, `markersEl`, con `pointer-events:none` en `shared.css`) — si se repintaran los dos en el mismo canvas, saltarse `paintRaster()` por el fingerprint borraría el raster sin volver a dibujarlo. `createMapController({ viewportEl, canvasEl, markersEl })` acepta `markersEl` como tercer elemento; sin él, `paintOverlay()` no dibuja nada (evita corromper el raster) — las dos páginas del proyecto pasan siempre los tres.

**Marcadores de jugador en el mapa (`public/mapRenderer.js`):** cuando un jugador vivo está unido a una facción, se dibuja un triángulo del color de su facción con su nombre encima (texto pequeño, pensado para leerse solo al hacer zoom, no a vista general) — si el jugador muere (`alive: false`) su marcador deja de dibujarse en el siguiente repintado. Posición: `computeFactionCentroid(tiles, factionNumber)` ancla en el centroide de UNA sola casilla de esa facción (la de `id` más bajo, determinista) — se probó primero con la MEDIA de los centroides de todas sus casillas y se descartó: cuando una facción tiene territorios no contiguos (habitual con el reparto estilo Voronoi, p.ej. una pieza en Sudamérica y otra en África), esa media cae en pleno océano entre los dos, y los marcadores aparecían flotando en agua. Con el ancla fija en una sola casilla real, siempre caen dentro de territorio propio. A partir de ese ancla, `computePlayerMarkers(players, factions, tiles)` reparte a cada jugador vivo de esa facción en anillos concéntricos (`PLAYERS_PER_RING = 8`, `MARKER_RING_BASE_RADIUS = 26`, `MARKER_RING_STEP = 24`, en celdas de raster) para que no se dibujen unos encima de otros. Es la ÚNICA función del proyecto que calcula "dónde está" el marcador de un jugador — la usan tanto el pintado (`paintPlayerMarkers`) como la búsqueda (`focusOnPlayer`, ver más abajo), cacheada en `lastMarkerPositions` tras cada repintado para no recalcularla dos veces. Esqueleto v1 a propósito: la posición es estática mientras el jugador siga vivo en la misma facción — animar el marcador según ataque/defienda/haga industria es trabajo futuro, pendiente de documentar aquí cuando se implemente (sección 8).

**Buscador de jugador (`public/index.html`, dentro del panel "👥 Jugadores"):** una caja de texto + botón que llama a `mapCtrl.focusOnPlayer(username)` — busca primero coincidencia exacta (sin mayúsculas/minúsculas) entre los jugadores vivos con marcador, si no encuentra prueba coincidencia parcial, y si encuentra centra el zoom del mapa ahí (`FOCUS_SCALE = MAX_SCALE`) usando el mismo `setView()` que usan `reset()`/`zoom()`/arrastrar, así que respeta los mismos límites de escala y de paneo. Si encuentra, cierra el panel de Jugadores para dejar ver el mapa; si no, muestra un aviso sin cerrar nada, para poder corregir el nombre. Devuelve `true`/`false` según si encontró.

**Tarjetas de facción compartidas (`public/factionCards.js`):** único módulo del proyecto que dibuja una tarjeta de facción (nombre, color, jugadores vivos/total, territorios, industria, bajas causadas, roster en miniatura) — antes esta misma lógica vivía duplicada dentro de `admin/index.html`; se extrajo a un script aparte (`CondejorgeFactionCards.renderFactionCards(containerEl, state)`, servido en `/factionCards.js`, igual que `mapRenderer.js`) para que la web pública pudiera reutilizarla sin reimplementarla. Estilos (`.factionCards`/`.factionCard`/`.rosterMini`) están en `shared.css`, no en el `<style>` de cada página.

**Panel de facciones de la web pública (`public/index.html`, botón "🏳️ Facciones", arriba a la izquierda):** sustituye a los chips de facción que antes estaban siempre visibles en pantalla — mismo mecanismo que el panel "👥 Jugadores" (clase `sidePanel`), pero deslizándose desde la izquierda (`sidePanel.left` en `shared.css`, variante con `transform:translateX(-100%)` en vez de `100%`) para no chocar con él. `handleFactionsPanelAutoOpen(state)` lo abre solo (`classList.add('open')`) la primera vez que la partida sale de la fase de Configuración, y se resetea (`factionsPanelAutoOpened = false`) al volver a fase `config` (partida nueva), para que vuelva a auto-abrirse la próxima vez que se inicie — a partir de ahí se pliega/despliega con el botón como cualquier otro panel.

**Margen arriba/abajo (`public/shared.css`, variable `--map-margin-y: 6vh`):** `#mapViewport` ya no ocupa el 100% de la altura (`inset:0`) sino que deja ese margen arriba y abajo — el fondo de la página (mismo color que el océano) se ve por encima y por debajo del mapa, como en streamer-wars.com, en vez de que el mapa llegue pegado al borde de la pantalla. `coverScale()`/`clampPan()` en `mapRenderer.js` no necesitaron ningún cambio para esto: leen `viewportEl.clientWidth/clientHeight`, que ya reflejan el viewport más pequeño automáticamente. Los elementos flotantes que viven cerca del borde inferior (`.mapToolbar`, `#winner` en la web pública) usan `bottom: calc(var(--map-margin-y) + Npx)` en vez de un `bottom` fijo, para quedar pegados al borde del mapa y no flotar sueltos sobre el margen.

**Búsqueda de facción por número:** en el servidor, una única función, `factionByNumber(match, number)`, exportada desde `server/rules/territory.js`. Todo módulo del servidor que necesite buscar una facción por su número la importa de ahí — no se reimplementa `.find()` inline ni se duplica con otro nombre. Hay dos excepciones, ambas inevitables:
- `findInFactionList(factions, number)` dentro de `gameEngine.js`, usada solo en `createMatch()` en el instante en que el array de facciones existe pero `match` todavía no.
- `factionByNumber(state, number)` dentro de `public/index.html` — variante del lado cliente, sobre `state.factions` (la forma serializada que llega por WebSocket), no sobre `match.factions` del servidor. No es una duplicación evitable: el cliente no puede importar código de `server/rules/`, corre en el navegador contra el estado ya serializado. Incluye este mismo nombre a propósito (misma firma conceptual "número → facción") en vez de un nombre distinto, para que quede claro que es la misma búsqueda al otro lado del cable.

**Bloques del resumen de ronda (`match.summaryBlocks`, uno por `kind`):**

| `kind` | Forma de `data` | Contenido |
|---|---|---|
| `industry` | `[{ faction, industry, gained }]` | `industry` = total acumulado tras la ronda; `gained` = lo que sumó *esta* ronda (votos `!industria` + pasivo por territorio, o `0` si tenía penalización de Sabotaje). |
| `territory` | `[{ faction, territories }]` | Recuento de casillas al cierre de la ronda. |
| `conquests` | `[{ tileId, fromFactionNumber, toFactionNumber, kind }]` | Casillas que cambiaron de dueño esta ronda. `kind` es `'attack'` (combate) o `'expansion'` (`!expansion` sobre neutral, `fromFactionNumber: null`). |
| `combats` | `[{ attackerFactionNumber, defenderFactionNumber, outcome }]` | Una entrada por cada facción atacante que participó en cada combate. `outcome` es `'attacker_won'`, `'attacker_lost'` (perdió el combate pero otra facción atacante sí ganó) o `'defender_held'` (la defensa aguantó). |
| `industryUnlocks` | `[{ factionNumber, tierKey }]` | Mejoras de industria desbloqueadas esta ronda (`tierKey` = una de `INDUSTRY_TIERS`: `tanque`, `bombardeo`, `tanque_x2`, `operacion_especial`). |
| `casualties` | `[{ username, factionNumber }]` | Jugadores que murieron esta ronda. |
| `eliminations` | `[{ factionNumber, eliminatedByFactionNumber }]` | Facciones que se quedaron sin miembros vivos esta ronda (ver sección 6 "Eliminación de facciones"). |

**Registro de comandos de chat (`getAdminState().chatLog`, uno por intento reconocido, máx. 15, el más reciente primero):**

```
ChatLogEntry { time, username, text, ok, reason }
```

`ok` es `true`/`false` según si el comando se aceptó. `reason` es un texto legible pensado para el admin ("fase incorrecta (hace falta ...)", "número de facción inválido", "unido a la facción N", "aceptado", "rechazado (revisa si está unido a una facción y vivo)"). Solo se registran mensajes que `commands.parseCommand()` reconoce como sintaxis de comando del juego — el chat normal no aparece aquí. Ver `pushChatLog()` en la sección 3.

**Estado del bot de Twitch (`getAdminState().botStatus`, fusionado por `server/index.js`, no vive en `gameEngine.js`):**

```
BotStatus { state: 'disconnected'|'connecting'|'connected'|'reconnecting'|'error', channels: [], joinedChannels: [], lastError, lastMessageAt }
```

`channels` es lo configurado por el admin; `joinedChannels` es a lo que el bot ya confirmó unión (evento IRC `366`) — si un canal está en `channels` pero no en `joinedChannels`, algo falló al unirse (canal mal escrito, o el `JOIN` todavía no se confirmó). `lastMessageAt` se actualiza con cualquier mensaje de chat visto (no solo comandos del juego), así que sirve para confirmar que el bot está realmente recibiendo tráfico del canal aunque nadie escriba un comando todavía.

**Popup de comandos (`public/index.html`, botón "❓ Comandos"):** lista estática (no depende de ningún dato del servidor) con la sintaxis, fase y descripción breve de cada comando de chat de la sección 2 — reutiliza las clases CSS `.modalOverlay`/`.modalBox`/`.summaryLine`/`.summaryEmpty` ya existentes del popup de resumen de ronda, sin CSS nuevo. Doble propósito: ayuda a los espectadores, y sirve de primera línea de diagnóstico para "escribí `!faccion1` y no pasó nada" (la causa más común es que la fase todavía no es la que ese comando necesita).

`killsCaused` (bajas causadas, acumulado de toda la partida, campo de `Faction`) se incrementa desde `applyCasualties(match, context, factionNumber, count, causedByFactionNumber)` en `rules/shared.js` — el único punto donde se matan jugadores, así que es el único punto donde se contabilizan bajas causadas. Los llamantes (`resolveCombat`, `applyBombardeo`, `applyOperacionEspecial`) pasan qué facción es la responsable; si no aplica (nadie causó las bajas), se omite el último argumento.

**Eliminación de facciones (`checkFactionElimination` en `server/rules/territory.js`):** cuando una facción se queda sin ningún jugador vivo, su territorio restante NO se queda plantado esperando a que alguien lo conquiste casilla a casilla — pasa a neutral de golpe, para que cualquier otra facción (no solo la que dio el golpe final) pueda tomarlo después por separado. No es como en Risk: quien elimina a la facción no se queda con todo su territorio, solo con la casilla que ya ganó por las reglas normales de combate (siempre en su propia frontera, porque `findWeakestBorderTile()` ya solo busca casillas del defensor pegadas a territorio del atacante). `checkFactionElimination(match, context, factionNumber, eliminatedByFactionNumber)` es el ÚNICO punto del proyecto que resuelve esto — no hace nada si a la facción le queda algún jugador vivo, o si ya no le quedaba territorio. Se llama después de CUALQUIER `applyCasualties()` que pueda dejar a una facción a cero:
- En `resolveCombat()`, tanto cuando el bando defensor pierde el combate (después de que `transferTile()` ya le haya dado su única casilla al atacante ganador) como cuando el bando atacante pierde tropas porque la defensa aguantó — en ese segundo caso no hay casilla de por medio, así que si el atacante queda eliminado se neutraliza todo su territorio sin que el defensor se quede ninguna casilla extra (no hubo conquista esa ronda).
- En `applyBombardeo()` y `applyOperacionEspecial()` (`rules/industry.js`) — estas dos mejoras de industria pueden matar al último jugador de una facción sin que haya combate/conquista de por medio, así que ahí la neutralización es total, sin casilla para quien la causó.

`neutralizeTile(match, tileId)` (también en `territory.js`) es la hermana de `transferTile()` para el caso "sin dueño nuevo": misma contabilidad de `territoryIds`, pero deja la casilla en `ownerFactionNumber: null, neutral: true`, exactamente como una casilla neutral de reparto inicial — así que ya es capturable con `!ataque`/`!expansion` sin ningún caso especial en esas reglas.

**Resumen final de partida (`matchEndModal` en `public/index.html`):** popup a pantalla completa (mismas clases `.modalOverlay`/`.modalBox` que los demás popups) que se abre solo, una vez por partida, la primera vez que `state.phase` pasa a `'end'` (`handleMatchEndModal()`, mismo patrón de "auto-abrir una vez" que `handleFactionsPanelAutoOpen()`). El cuerpo del popup reutiliza `CondejorgeFactionCards.renderFactionCards()` — las mismas tarjetas de facción de siempre (vivos/total, territorios, industria, bajas causadas, roster) — en vez de reimplementar el resumen desde cero, porque en `PHASE_END` el estado ya está congelado y esos datos ya son los finales. Si el espectador cierra el popup con la X (`closeMatchEndModal()`), el banner `#winner` de abajo sigue con un enlace "ver resumen" que lo reabre (`openMatchEndModal()`) en cualquier momento mientras la partida siga terminada. Solo existe en la web pública por ahora — ver nota en la sección 1 sobre `PHASE_END`.

**Timer de fase (pausa) — por qué "Pausar" parecía no hacer nada (`public/matchTimer.js`):** el servidor siempre pausó/reanudó bien (`pauseTimer()`/`resumeTimer()` en `gameEngine.js` congelan/reanudan `match.timer.endsAt` correctamente, verificado con pruebas directas del motor) — el bug era solo de interfaz, en tres sitios:
1. `getPublicState()` no exponía `timerPaused` (solo `getAdminState()` lo tenía) — la web pública no tenía forma de saber que la partida estaba en pausa. Ahora `timerPaused` (y `timerEndsAt`) viven en `getPublicState()`, y `getAdminState()` ya no los repite aparte: es `{ ...getPublicState(), config, chatLog }`.
2. Ninguna de las dos páginas tenía en cuenta la pausa al pintar la cuenta atrás — ambas recalculaban `restante = timerEndsAt - Date.now()` en cada tick, así que durante una pausa (donde el servidor deja `timerEndsAt` fijo sin moverlo) el número visible caía solo a "00:00" en pocos segundos, aunque la ronda estuviera realmente parada.
3. `admin/index.html` no tenía ningún timer visible en absoluto, ni indicación de que estuviera en pausa.

Se resolvió con `public/matchTimer.js` (`CondejorgeMatchTimer.createMatchTimerTracker()`, servido también en `/matchTimer.js` desde el admin, igual que `mapRenderer.js`/`factionCards.js`): único módulo del proyecto que sabe formatear la cuenta atrás, usado por ambas páginas. En cuanto ve `state.timerPaused === true` por primera vez, congela el valor que tocaba en ese instante y lo repite tal cual (con un `⏸` al lado) mientras siga en pausa; en cuanto vuelve a `false`, retoma la cuenta atrás en vivo desde `timerEndsAt`. `admin/index.html` añade además un `#adminTimer` junto a la etiqueta de fase, y los botones `#pauseBtn`/`#resumeBtn` se deshabilitan/habilitan según `state.timerPaused` (no tiene sentido pulsar "Pausar" si ya está pausado, ni "Reanudar" si no lo está).

**Música de fondo (`public/index.html`, elemento `#bgMusic`):** la web pública reproduce en bucle un archivo de audio propio, sin ninguna librería — un simple `<audio id="bgMusic" src="/audio/bgm-placeholder.mp3" loop>`. Es SOLO de la web pública (no del panel de admin): el admin es la pantalla de control del streamer, no lo que ve la audiencia, así que no tiene sentido que suene música ahí también (y si el admin la tuviera abierta en otra pestaña sonarían las dos pistas a la vez).
- **Dónde va el archivo:** `public/audio/bgm-placeholder.mp3` — para poner la música definitiva basta con sustituir ese archivo por otro con el mismo nombre (o cambiar el `src` del `<audio>` si se prefiere otro nombre/formato). Se sirve como cualquier otro archivo estático de `public/` (mismo mecanismo que `mapRenderer.js`, `shared.css`, etc., ver `server/index.js` `staticRoutes`); solo hizo falta añadir el tipo MIME `audio/mpeg` para `.mp3` en `contentTypeFor()` (`server/lib/miniWsServer.js`), que antes solo conocía `.html`/`.js`/`.css`.
- **Por qué MP3 y no otro formato:** es el formato con mejor compatibilidad universal en navegadores (a diferencia de `.ogg`/`.opus`, que Safari no soporta bien) y comprime bien música con pérdida perceptual mínima a bitrates moderados — no hace falta nada sin pérdida (WAV/FLAC) para un bucle de fondo. Para que el peso del repositorio no crezca innecesariamente: 128 kbps estéreo es de sobra para música de fondo (no es el elemento central de la experiencia), y cuanto más corta sea la pista en bucle, menos pesa — no hace falta un tema de 3 minutos si va a sonar en bucle igualmente; con que el punto de bucle no se note (o se recorte en un silencio/nota sostenida) sirve un fragmento de 30-90s. El placeholder actual (`bgm-placeholder.mp3`, generado con `ffmpeg` a partir de tonos puros, sin derechos de autor) dura 8s a 128kbps (~125KB) para que el bucle sea perfectamente cíclico (duración = número entero de ciclos de cada tono) — es solo para probar que el mecanismo funciona, se espera que el streamer lo sustituya.
- **Botón + barra (arriba a la izquierda, junto al título):** `#musicToggle` (icono 🎵/🔇 según `bgMusic.muted || bgMusic.volume === 0`) alterna mute; `#musicVolume` (`<input type="range">`) controla `bgMusic.volume` y desmutea automáticamente al subirlo por encima de 0 (o mutea si se lleva a 0). Ambos controles y la función que actualiza el icono (`updateMusicButtonIcon()`) son el único sitio del proyecto que toca `bgMusic`.
- **Autoplay al entrar — por qué no sonaba solo en las pruebas:** los navegadores bloquean cualquier reproducción con sonido (y, según el navegador/configuración, incluso en mute) hasta que el usuario ha interactuado al menos una vez con la página — es política del navegador, no un fallo de esta web (ver `NotAllowedError: play() failed because the user didn't interact...`, confirmado durante las pruebas). La estrategia en tres pasos (todas en el `<script>` de `public/index.html`, al final): 1) intenta sonar con volumen normal nada más cargar (algunos navegadores sí lo permiten según su "media engagement" con el sitio); 2) si lo rechaza, reintenta en mute; 3) si el navegador rechaza incluso eso, engancha un listener de "primera interacción" (`click`/`keydown`/`touchstart` en cualquier parte del documento, no hace falta que sea el propio botón de música) que reintenta reproducir una sola vez y se desengancha — así el bucle arranca (en mute) en cuanto el espectador haga lo que sea en la página, y el botón 🎵 sirve para desmutearlo cuando quiera oírlo. No hay soporte de "range requests" (HTTP parcial) en el servidor de archivos estáticos — no hace falta para un bucle de fondo sin control de scrubbing visible, solo importaría si se sirviera un archivo mucho más pesado o se añadiera una barra de progreso/seek en el futuro.

**Bug corregido — `getPublicState()` devolvía `null` sin partida creada:** un espectador que abre la web pública ANTES de que el admin cree la primera partida recibía `{ type: 'state:public', payload: null }` (`server/index.js` lo manda nada más conectar), y `render(state)` en `public/index.html` hace `state.phase` sin comprobar `state` primero — crasheaba con `TypeError` en cuanto se abría la web sin partida en curso. Se encontró durante las pruebas en vivo de la música de fondo (con un servidor recién arrancado, sin partida, no se había probado antes ese caso exacto). `getAdminState()` ya tenía este mismo problema resuelto (devolvía un objeto por defecto en vez de `null`) — `getPublicState()` ahora hace lo mismo (objeto con `phase: null`, arrays vacíos, etc.) en vez de `null`, y `getAdminState()` ya no repite ese objeto por defecto aparte, solo añade `config`/`chatLog` encima del de `getPublicState()`.

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
- Animaciones del marcador de jugador según la acción que haga (moverse al atacar/defender, efecto al hacer industria, efecto al morir) — hoy el marcador es estático mientras el jugador siga vivo en la misma facción, ver sección 6 "Marcadores de jugador en el mapa".
- "Opción A" del mapa: en vez de mandar `cellTileIds` empaquetado (sección 6, "opción B", la que sí está implementada), el servidor renderizaría el mapa como una imagen (PNG, con un codificador escrito a mano sobre el `zlib` nativo de Node, sin dependencias nuevas) y los clientes cargarían esa imagen por HTTP en vez de recibir datos crudos por el WebSocket — comprimiría mucho más que el empaquetado actual (aprovecha las zonas de color plano) y movería el coste de "pintar" del navegador de cada espectador al servidor, una sola vez. Discutido con el usuario, pendiente de decidir si se implementa tras probar la opción B.
