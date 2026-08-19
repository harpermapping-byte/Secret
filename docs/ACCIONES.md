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
| `PHASE_TRANSITION` | `"transition"` | Paron decorativo del esqueleto entre fases — ver sección 13 |
| `PHASE_END` | `"end"` | Fin de partida |

Solo `gameEngine.js` puede cambiar la fase actual. Ningún otro módulo la modifica directamente.

**Comportamiento de los clientes en `PHASE_END`:** ni la web pública ni el panel de admin borran nada al llegar a esta fase — siguen mostrando el mapa y las estadísticas finales tal cual estaban (`getPublicState()`/`getAdminState()` no cambian sus campos al terminar, solo `phase`). La web pública añade un banner flotante NO bloqueante (`#winner` en `public/index.html`, función `renderEndBanner()`) que avisa de que la partida terminó sin tapar el mapa/clasificación, y automáticamente (una sola vez por partida) abre `matchEndModal`, el popup a pantalla completa con el resumen final por facción — ver sección 6 "Resumen final de partida". El banner sigue visible después de cerrar el popup, con un enlace "ver resumen" para volver a abrirlo. El panel de admin cambia los botones de "en curso" por uno de "🔄 Nueva partida" (`resetToConfig()`), que solo muestra de nuevo el formulario de configuración — la partida anterior sigue existiendo en el servidor hasta que se manda un `admin:createMatch` de verdad. El panel de admin no tiene el popup de resumen final propio (todavía no está confirmada la unificación visual admin/pública) pero ya ve los mismos datos finales en sus tarjetas de facción de siempre.

## 2. Comandos de chat → tipo de acción (`server/commands.js`)

| Comando en chat | Constante de acción | Fase en la que es válido |
|---|---|---|
| `!faccion<N>` | `ACTION_JOIN_FACTION` | `PHASE_RECRUITMENT` |
| `!industria` | `ACTION_INDUSTRY` | `PHASE_ACTION` |
| `!ataque <N>` | `ACTION_ATTACK` | `PHASE_ACTION`, y solo si la facción tiene alguna casilla que toque a la facción N (`factionsAreAdjacent()` en `server/rules/territory.js`) — si no hay frontera compartida se rechaza igual que un comando inválido cualquiera, ver sección 12 |
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
| `COMBAT_RANDOM_MIN` / `MAX` | `rules/shared.js` | 0.7 – 1.3 por soldado (ataque **y** defensa) |
| `KNIGHT_RANDOM_MIN` / `MAX` | `rules/shared.js` | 0.9 – 1.4 por caballero (ataque **y** defensa) — ver sección 16 |
| `PASSIVE_INDUSTRY_PER_TERRITORY` | `rules/industry.js` | 0.1 por casilla |
| `INDUSTRY_PER_BUILDING` | `rules/industry.js` | 0.5 por edificio de industria |
| `VOTES_PER_NEW_TILE` | `rules/expansion.js` | 2 votantes por casilla nueva |
| `INDUSTRY_TIERS` (umbrales de las 4 mejoras) | `rules/industry.js` | 3 / 8 / 15 / 24 **por jugador** de la facción (ver más abajo y sección 16) |
| `REFUERZO_REVIVE_COUNT` | `rules/specialAbilities.js` | 3 revividos |
| `ESCUDO_DEFENSE_BONUS_PERCENT`, `FRENESI_ATTACK_BONUS_PERCENT` | `rules/specialAbilities.js` | 30% |
| `SUMMARY_MS_PER_BLOCK` | `gameEngine.js` | 12000 ms |

**Reglas de combate, industria y expansión (revisión de mecánicas):**
- **Combate**: cada usuario que escribe `!ataque` aporta una tirada suelta en 0.7–1.3, y cada usuario que escribe `!defender`, otra en el mismo rango. La fuerza total de cada bando es la suma de sus tiradas, así que dos combates con el mismo número de gente no dan el mismo resultado.
- **No hay defensa pasiva de territorio**: si nadie de una facción escribe `!defender` esa ronda, entra al combate con **0** de defensa por muchas casillas que tenga. Toda la defensa sale de los usuarios. (Antes existía `BASE_GARRISON_PER_TERRITORY`; se eliminó.)
- **Industria como edificio sobre la casilla**: cada `!industria` levanta un edificio en una casilla al azar de las que tenga la facción (`tile.industryCount`, ver `mapTemplates.js`). Producción de una facción por ronda = `casillas × 0.1 + edificios × 0.5`. El edificio vive en la **casilla**, no en la facción, así que conquistar una casilla con una industria le pasa al nuevo dueño los `0.1 + 0.5 = 0.6` completos sin código extra — es la propia `transferTile()` la que lo hace.
- **Expansión por número de votantes, sin umbral de %**: hacen falta 2 votantes por cada casilla nueva, con mínimo de 1 casilla si vota alguien (1 o 2 votos → 1 casilla; 4 → 2; 6 → 3; ver `tilesWonByVotes()`). Las casillas se sortean de una en una entre las neutrales que tocan la frontera, recalculando la frontera tras cada conquista. El ajuste **`% expansión` del panel de admin se eliminó** por quedarse sin uso; `% alianza` y `% especial` siguen funcionando por porcentaje.

**Umbrales de industria escalados por tamaño de facción (por qué):**

Los umbrales de las 4 mejoras NO son números absolutos: son `perPlayer × jugadores de la facción` (ver `industryThresholdsFor()` en `rules/industry.js`). El motivo es que la industria de una facción crece con su número de miembros — cada `!industria` levanta un edificio que renta **para siempre** —, así que con un umbral fijo la partida cambia por completo según cuánta gente haya en el chat. Medido con el motor real, con umbrales fijos de 10/20/30/40:

| Jugadores | Mejoras 1·2·3·4 en ronda |
|---|---|
| 3 | 4 · 6 · 7 · 9 |
| 60 | 1 · 2 · 2 · 2 |

No existe un número fijo que funcione en los dos casos. Escalando por tamaño de facción (3/8/15/24 por jugador), la progresión sale igual tenga 3 o 60 miembros — verificado con el motor: **3 jugadores → 4·7·9·12; 60 jugadores → 4·7·10·13** —, y lo que decide el ritmo pasa a ser cuánta gente colabora:

| Participación (12 jugadores) | Mejoras 1·2·3·4 en ronda |
|---|---|
| 20% hace `!industria` | 8 · 14 · 19 · 24 |
| 60% | 5 · 7 · 10 · 13 |
| 100% | 3 · 6 · 8 · 10 |

Detalles que importan:
- Se usa el **roster fijado al cerrar el reclutamiento** (`faction.rosterSize`, rellenado en `closeRecruitment()`), no los vivos de cada momento: si bajara con cada baja, las marcas de la probeta se moverían solas a mitad de partida y una facción diezmada desbloquearía mejoras "gratis" justo por ir perdiendo.
- Hay un suelo de `MIN_PLAYERS_FOR_THRESHOLDS` (3) para que una facción a la que no se une nadie no tenga umbral 0 y desbloquee las 4 mejoras de golpe en la primera ronda.
- Los umbrales viajan **por facción** en el estado público (`faction.industryThresholds`), no como un valor global, justo porque cada facción tiene el suyo.
- Se descartaron dos alternativas por ser demasiado lentas (la mejora 4 casi nunca llegaba a desbloquearse): pago único sin renta, y techo de 1 edificio por jugador.

**Indicadores en vivo sobre el mapa (`public/mapRenderer.js`):**
- **Escudo verde 🛡 + número** sobre una facción = cuánta gente suya está defendiendo esta ronda. **Espada roja ⚔ + número** = cuántos atacantes tiene encima ahora mismo. Se calculan en `countLiveActions()` (`gameEngine.js`) y viajan en cada `state:public`/`state:admin` como `defendersThisRound` / `incomingAttackersThisRound` por facción, así que se actualizan **mientras la gente escribe en el chat**, no al resolver la ronda. Fuera de `PHASE_ACTION` van a 0 y los iconos desaparecen solos.
- `countLiveActions()` no reutiliza `tallyActions()` a propósito: aquella construye el contexto completo de resolución y además suma `participation` a cada jugador — llamarla en cada envío de estado corrompería esas cuentas.
- **Cuadrado amarillo semitransparente** = un edificio de industria, dibujado en cuadrícula sobre el centroide de **su** casilla (no del centro de la facción, justo porque pertenece a la casilla). Placeholder, a sustituir por un PNG más adelante.

**Simplificaciones de v1 respecto al diseño original, a revisar:**
- Bombardeo (mejora 2) reparte bajas con la prioridad de la ronda **actual** (inactivos de esta ronda), no de la ronda anterior como se describió en el diseño — matizar si hace falta más precisión.
- Sabotaje elige objetivo automáticamente (el que más votos de `!ataque` recibió de esa facción esta ronda, o un vecino al azar si no atacó a nadie) porque el diseño no especificaba cómo se elegía el objetivo por chat.
- Solo el bando perdedor de un combate sufre bajas; el bando ganador no pierde nada en v1 (simplificación para no complicar el primer motor).

## 8. Horneado de terreno del mapa (v2) — `tools/bakeWorldTerrain.js`

**Decisión de arquitectura:** el contorno tierra/agua de Condejorge Wars es el planeta real (`server/worldLandMask.js`, datos Natural Earth 110m, ya existía) y es **idéntico en todas las partidas** — solo cambia el reparto en territorios (Voronoi por partida, sigue viviendo en `mapTemplates.js`/`division`, sin tocar). Por eso el terreno visual (elevación, biomas, ríos, vegetación, oleaje) NO se genera por partida ni en cliente ni en servidor — eso ya causó una regresión de rendimiento grave (~4020ms en "Iniciar partida") que se revirtió por completo en v1. En su lugar se **hornea una única vez, offline**, a un PNG estático que se sirve como asset normal, igual que ya se hacía con el propio land mask.

Diseño visual aprobado por el usuario en un boceto Python iterado dos veces (`/tmp/mappreview/gen_v2.py`, no forma parte del repo) antes de portarlo a Node — ver el resto de esta sección para el porqué de cada parámetro.

**Cómo correrlo:** `node tools/bakeWorldTerrain.js` seguido de `node tools/generateWorldObjects.js` (manual, nunca en producción). El mundo se dobló de resolución a petición del usuario (8800×4604 = 40.5M celdas, antes 4400×2302) para poder hacer mucho más zoom sin pixelarse — cada script tarda ~55-90s a esta resolución. `bakeWorldTerrain.js` escribe `public/terrain/world.png` (~63MB); `generateWorldObjects.js` escribe `public/terrain/objects.bin` (~300KB, ver subsección "Objetos discretos como datos" más abajo). Con `DEBUG_STAGE=1..6` en el entorno, `bakeWorldTerrain.js` escribe en su lugar una captura de esa fase en `/tmp/mappreview/debug_stageN.png` **sin tocar el asset de producción** — disciplina de verificación incremental adoptada tras la regresión de terreno de v1 (no se avanza a la siguiente fase sin mirar la anterior). `DEBUG_COUNTS=1` además imprime cuántos píxeles caen en cada máscara de bioma, útil para recalibrar densidades.

**Archivos:**
- `tools/terrainNoise.js` — ruido de valor multi-octava hecho a mano (`mulberry32` + rejilla bilineal/smoothstep + `fractalNoise`), sin librerías de noise.
- `tools/pngEncoder.js` — codificador PNG hecho a mano (solo usa el `zlib` nativo de Node), RGB8 sin paleta, filtro "None". Es la misma idea que la "Opción A" que se dejó pendiente más abajo, reutilizada aquí.
- `tools/rasterPrimitives.js` — primitivas de rasterizado a mano (`setPx`, `fillEllipse`, `drawLine` con grosor, `fillPolygon` por scanline, `drawArcPoints`) porque Node puro no trae nada tipo Canvas/PIL; solo lo mínimo para estampar la textura de suelo. Los objetos discretos con forma propia ya NO se dibujan aquí — se dibujan en el CLIENTE con Canvas 2D, ver más abajo.
- `tools/worldTerrainCore.js` — fases 1-6 (land mask, distancia a costa, elevación, bioma, ríos, colores base+sombreado+textura de roca/nieve) **compartidas** entre `bakeWorldTerrain.js` y `generateWorldObjects.js`, para que ambos vean exactamente el mismo bioma/banda por celda — antes esto vivía solo dentro de `bakeWorldTerrain.js`.
- `tools/bakeWorldTerrain.js` — usa el núcleo de arriba y añade: 7) oleaje, 8) textura FINA de suelo (moteado de color de 1px: grano de hierba/arena/roca/escarcha + flores + charco de oasis — no objetos con forma), 9) envejecido + exportación a `world.png`.
- `tools/generateWorldObjects.js` — usa el mismo núcleo y calcula los objetos DISCRETOS (árboles, rocas, arbustos, ramas/madera de deriva, conchas, palmeras) como datos, ver subsección siguiente.

### Objetos discretos como datos (no horneados en el PNG)

A la resolución real, hornear árboles/rocas/etc. como píxeles fijos en el PNG topaba con dos problemas que el usuario señaló directamente: demasiados árboles solapándose "por milímetro cuadrado", y ninguna forma de hacer zoom de verdad (estilo videojuego, hasta ver aldeanos) sin que el PNG creciera sin límite. La solución (misma arquitectura que investigamos que usa streamer-wars.com): estos objetos se generan offline como **datos** (tipo + posición + tamaño, ~6 bytes cada uno) en vez de píxeles, y el **cliente** los dibuja con Canvas 2D, solo los que caen en el viewport actual.

- `tools/generateWorldObjects.js` escribe `public/terrain/objects.bin`: 1 byte de versión + uint32 con el nº de objetos + N registros de 6 bytes (`tipo` 1B, `x` uint16 BE, `y` uint16 BE, `r` 1B — mismo espacio de píxeles que `world.png`/`RASTER_COLS`/`RASTER_ROWS`). ~53K objetos para todo el planeta, ~300KB — se descarga UNA vez (fetch estático, no por partida ni por tile/zoom).
- `public/mapRenderer.js` (`createObjectLayer()`) hace el fetch una vez, arma una rejilla espacial (cubos de 512px de mundo) para no recorrer los 53K objetos en cada frame, y en cada pan/zoom **redibuja solo lo visible** (+ un margen de colchón para que nada aparezca "de golpe" al entrar en pantalla) en un canvas del tamaño del VIEWPORT (`#mapObjects`) — a diferencia del raster de territorios (`#mapCanvas`), que se pre-renderiza una vez a tamaño del mundo entero y se panea/zoomea gratis con CSS transform.
- LOD con histéresis (`updateLodTier()`): por debajo de escala ~0.45-0.55 no se dibuja ningún objeto (demasiado lejos, sería ruido); entre ~0.45 y ~1.15 solo se dibujan los objetos "grandes" (árboles/palmeras), los pequeños (rocas/arbustos/ramas/conchas) se ocultan; por encima se dibuja todo. Los dos umbrales por transición (uno para subir, otro más bajo para bajar) evitan parpadeo si el usuario hace zoom justo en el borde.
- El "sabor" cosmético por objeto (ángulo de rama caída, tono de roca, inclinación de palmera) NO se guarda en el fichero — se deriva en el cliente con un hash determinista de `(x,y)` (`hash01()`), para no gastar bytes extra en algo puramente decorativo.
- La capa de territorios (`#mapCanvas`) ahora se pinta con transparencia parcial (`ALPHA_BY_KIND`, océano 100% transparente, fronteras casi opacas, tierra a medio tinte) en vez de opaca del todo, para dejar ver `world.png` (`#mapTerrainBg`, capa de fondo, mismo transform que `#mapCanvas`) por debajo — esto cierra el pendiente "falta enganchar el cliente" de más abajo.
- Mismo mecanismo pensado para reutilizarse más adelante con aldeanos/edificios/unidades (cambia solo qué se dibuja, no la arquitectura de carga/culling/LOD).

**Bugs reales encontrados y corregidos durante el porteo (dejados aquí porque son no obvios si se vuelve a tocar este script):**
- *Fronteras de bioma facetadas:* el ruido de humedad usaba una celda base demasiado grande (150px) para la resolución real — al hacer zoom nativo, la octava dominante se veía como facetas rectas de interpolación bilineal en vez de una costa de bioma orgánica. Se bajó la celda base a 70px y se subieron las octavas de 4 a 6.
- *Corte de latitud perfecto en la nieve alta:* a diferencia de tundra, el umbral de `SNOWCAP` no tenía el jitter de latitud aplicado, así que en cordilleras largas (Urales) salía una línea horizontal perfecta separando roca de nieve — se le añadió el mismo jitter que ya usa tundra.
- ***Bug heredado del boceto de Python*: la "falda nevada" nunca existía.** `SNOWCAP` solo se asignaba a celdas de banda `MOUNTAIN`, nunca `HILL`, así que la máscara `snowcap_treeline` (pensada para pinos nevados en la falda, no en el pico) daba siempre 0 píxeles — la función simplemente no dibujaba nada y nadie lo notó porque no fallaba, solo no hacía efecto. Se corrigió expandiendo el bioma nevado con una pequeña dilatación (14 pasadas) desde la roca de montaña hacia las celdas `HILL` vecinas.
- **Densidad de objetos mal escalada (el más importante):** la primera versión escalaba tanto el número de objetos (por proporción de área de lienzo) como su tamaño en píxeles (por proporción de ancho) frente al boceto de 1600×1000. Como cada árbol/roca es una forma 2D, agrandarlo por `LINEAR_SCALE` multiplica su huella por `LINEAR_SCALE²` — sumado a preservar la cuenta por píxel de bioma, la cobertura visual salía multiplicada por ~7.6× de más (bosques con copas 100% solapadas, visto en `debug_stage5` sobre Siberia). Se corrigió dividiendo la cuenta densidad-preservada entre `LINEAR_SCALE²` para todo objeto "de bulto" (`SIZE_AREA_CORRECTION`), y entre `LINEAR_SCALE` simple para ramas (línea fina de ancho fijo, no de bulto). Además, la playa es una franja fina que sigue la costa (casi-1D) cuyo ancho se hizo deliberadamente más ancho de lo que tocaría por resolución pura (22 vs 15 celdas) para que se viera mejor — sin corregir esto, los objetos de playa (conchas, madera de deriva) salían como una cinta continua en vez de puntos sueltos a lo largo de la costa; se corrigió con un `BEACH_WIDTH_RATIO` adicional solo para esos objetos (no para las motas de textura de suelo, que si son grano de área pura).
- Todas las cuentas de objetos ahora preservan la **densidad por píxel de bioma** medida corriendo el boceto de Python (`PY_PIXELS` en el script), no una proporción de área de lienzo — así el mundo real (con muchísima más superficie de taiga/desierto/etc. que el continente sintético de prueba) no sale sobre ni sub poblado de objetos respecto a lo que el usuario aprobó visualmente.

**Pendiente (no en el alcance de esta sesión):**
- El marco ornamentado + rosa de los vientos (boceto aprobado en `/tmp/mappreview/gen_frame4.py`, agua con oleaje corregido — más detallado/con textura que la v2, rosa de los vientos dibujada a pluma con fondo transparente) es decoración de INTERFAZ fija, no se hornea junto al terreno — sigue sin portarse a un asset/capa de producción, solo existe como prototipo Python en `/tmp` (se pierde si el contenedor se reinicia).
- El script `tools/build_mask_v2.py`/`generateLandMask.py` usado para regenerar `server/worldLandMask.js` a la resolución doblada solo existe en `/tmp` — el land mask ya resultante SÍ está commiteado, pero el script que lo generó no se copió al repo.
- `DEBUG_COUNTS` en `bakeWorldTerrain.js`/vía `worldTerrainCore.js` es un bloque de diagnóstico temporal (gated tras una env var, inofensivo si se deja) usado para calibrar las densidades de objetos — se puede quitar cuando ya no haga falta recalibrar.
- El bioma se calibra con latitud + ruido, no con datos climáticos reales — da bandas realistas (desierto en su latitud correcta, tundra solo en el círculo polar de verdad) pero no garantiza que el Sahara caiga exactamente donde está el Sahara real. Subir esto de nivel implicaría un dataset tipo Köppen-Geiger (dominio público, misma disciplina de origen que Natural Earth) — no se ha hecho por alcance/tiempo.
- El PNG final pesa ~63MB a la resolución doblada (mucho grano/textura reduce lo que zlib puede comprimir) — sin optimizar todavía; si hace falta más adelante, opciones a explorar: paleta indexada en vez de RGB8 directo, o servir el terreno troceado en tiles en vez de una imagen única (los objetos discretos, que es donde más pesaba el detalle, ya no cuentan aquí — viven en `objects.bin`, ver arriba).
- `public/mapRenderer.js`'s `BLOCK_PX` sigue en 1 tras doblar la resolución del raster — el canvas de territorios ahora es 8800×4604 en vez de 4400×2302 (el doble de píxeles reales en pantalla). No se ha comprobado si esto pide bajar `BLOCK_PX` a 0.5 para mantener el tamaño en pantalla de antes, o si en la práctica no importa porque el CSS ya lo encoge a la escala de cobertura del viewport.

## 9. Tema visual medieval de la interfaz — `tools/bakeUiTextures.js`

La interfaz (barras, botones, popups y paneles) usa un tema medieval de pixel art. Igual que el terreno del mapa, **no se dibuja con gradientes CSS ni SVG**: son tres PNGs horneados una vez a mano (`node tools/bakeUiTextures.js`) y guardados como assets estáticos en `public/ui/`. Pesan ~49KB los tres juntos, se descargan una vez y el navegador los cachea — no se genera nada por partida.

| Textura | Archivo | Qué es | Cómo la usa el CSS |
|---|---|---|---|
| Madera | `public/ui/wood-bar.png` (384×64) | Tablones con vetas horizontales, costuras verticales entre tablas y el canto de abajo irregular (con transparencia) | Fondo de `.overlayTopBar` (barra de arriba) y de `body::after` (barra de abajo, la MISMA imagen volteada con `scaleY(-1)` para que el canto irregular mire siempre al mapa). Se repite en horizontal. |
| Chapa de latón | `public/ui/metal-plate.png` (32×32) | Placa con bisel, esquinas cortadas y 4 remaches | `border-image` con recorte de 9 zonas (`11 fill`) en `.headerBtn`, `.mapToolbar button` y los `<button>` del admin: las esquinas con remache no se deforman y solo se estiran lados y centro, así la misma chapa vale para un botón de "+" y para "🏆 Clasificación". |
| Pergamino | `public/ui/parchment.png` (128×128) | Papel tostado con manchas de envejecido, **sin escritura** (para que se lea el texto que va encima) | Fondo de `.sidePanel`, `.modalBox`, `#winner` y de los formularios del admin (`#login`, `#configForm`). Se repite en mosaico. |

Reglas de oro al tocar esto:

- **Las tres texturas son tileables/estirables**: la madera repite en horizontal y el pergamino en mosaico, así que las costuras tienen que seguir siendo invisibles si se regeneran. En la madera, el canto irregular se hace con dos octavas de amplitud BAJA a propósito: con amplitud alta y ciclo corto el borde se lee como un serrucho regular en cuanto la tira se repite en pantalla (pasó en la primera versión, de ahí que la tira sea ancha —384px— y la amplitud pequeña).
- **Si se regeneran con otras dimensiones hay que cuadrar el CSS**: `--wood-tile-w` en `shared.css` asume que la madera es 6× más ancha que alta, y el `border-image ... 11` de los botones asume el `METAL_SLICE` del script. Están comentados en los dos sitios.
- **Las variantes de botón no tienen textura propia**: `.secondary` y `.danger` tiñen la misma chapa con `filter` (`saturate`/`hue-rotate`), que además arrastra el dorado del texto a juego. No añadir PNGs nuevos por variante.
- **Tipografías sin webfonts**: `--font-title` (títulos, botones, cabeceras) y `--font-serif` (texto corrido) en `shared.css` son pilas de serifas del sistema, encabezadas por un par de fuentes "de romano" por si están instaladas y con caída a Palatino/Georgia. Mismo criterio que el resto del proyecto: cero dependencias de red. Si algún día se quiere una tipografía de época de verdad, se añade un `@font-face` y se mete al principio de `--font-title`.
- **Sobre pergamino, la tinta es marrón oscuro** (`--ink`/`--ink-soft`), no el azul claro del tema anterior — cualquier bloque nuevo que se meta dentro de un popup o panel tiene que usar esas variables o se quedará ilegible.

`server/lib/miniWsServer.js` sirve estos PNGs con `Content-Type: image/png` (antes cualquier `.png`, incluido el terreno, salía como `application/octet-stream`).

## 10. Decoración del mapa y sprites intercambiables (`public/sprites/`)

El mapa se puebla cada partida con elementos decorativos (no tienen efecto en las reglas, solo dan vida y sensación de 2.5D):

| Tipo | Cantidad | Dónde cae |
|---|---|---|
| `castle` | 10 | tierra |
| `port` | 15 | **costa** (tierra que toca agua) |
| `village` | 20 | tierra |
| `tree` | 100 | tierra |
| `ship-small` | 10 | agua |
| `ship-big` | 5 | agua |
| `whale` | 5 | agua |
| `kraken` | 1 | agua |

**Cómo sustituir un placeholder por arte real:** sobrescribe el `.png` correspondiente en `public/sprites/` y recarga. No hay que tocar código ni volver a ejecutar ningún script. Lo único que puede querer ajustarse es el ancho con el que se dibuja en el mapa: `DECOR_SPRITES` en `public/mapRenderer.js`, una línea por tipo (`worldWidth`, en píxeles de mundo) — la altura sale sola del aspecto real del PNG, así que un arte más alto o más estrecho encaja sin tocar nada más. Los placeholders los genera `tools/bakeSpritePlaceholders.js` (solo hace falta si quieres regenerarlos).

**Dónde vive cada pieza:**
- **Reparto**: `placeDecorations()` en `server/mapTemplates.js`, con la tabla `DECORATION_KINDS` (cantidad, terreno y separación mínima entre elementos del mismo tipo). Añadir un tipo nuevo = una fila ahí + su `.png`; el cliente monta la ruta desde el nombre del tipo, así que no hay que tocarlo.
- **Por qué en el servidor y no en cada navegador**: para que el streamer y todos los espectadores vean exactamente la misma decoración. Viaja una única vez dentro del mensaje `map:layout` y son ~166 objetos (~5,5KB), nada al lado de la rejilla del mapa.
- **Dibujado**: `drawDecorations()` dentro de la capa de objetos de `public/mapRenderer.js`. Esa capa es un canvas **del tamaño del viewport** (no del mundo), que se redibuja en cada pan/zoom pintando **solo lo que cae dentro de la pantalla** (+ un margen), así que el coste va con "cuántos elementos se ven ahora", no con "cuántos hay en el mapa". Con ~166 objetos basta un recorrido lineal: la rejilla espacial que usa `objects.bin` (pensada para decenas de miles) aquí costaría más de mantener que el propio recorrido.
- **2.5D**: los sprites se anclan por su **base** (abajo-centro) y se dibujan ordenados por Y, así los de más al sur tapan a los de más al norte y el solape se lee como profundidad. Por debajo de `DECOR_MIN_SCALE` (zoom de planeta entero) no se dibujan: serían manchas de 2px.

**Cursor del ratón**: `public/sprites/cursor.png`, aplicado en `body` desde `shared.css` (vale para la web pública y para el admin). Para poner el tuyo, sobrescribe ese PNG. Los dos números del `cursor: url(...) 2 2` son el punto caliente (qué píxel es la punta); ajústalos si tu dibujo apunta desde otro sitio. El mapa ya no usa las manitas `grab`/`grabbing` del navegador porque pisaban el cursor propio justo en la zona más grande de la pantalla — hay una regla comentada en `shared.css` por si más adelante quieres un cursor distinto al arrastrar.

**Probeta de industria**: la dibuja `industryFlask()` en `public/factionCards.js` (SVG inline, sin assets). Va a la derecha de los datos de cada facción, se llena del color de la facción según su industria acumulada y lleva las 4 marcas de los umbrales de mejora, que se doran al alcanzarse. Los umbrales llegan del servidor en `state.industryThresholds` (sacados de `INDUSTRY_TIERS` en `server/rules/industry.js`, única fuente de verdad): si se reajustan, las marcas se recolocan solas. El último umbral es el que llena la probeta del todo.

## 11. Caminantes: los marcadores de jugador se mueven según su comando

Cada jugador vivo tiene un marcador (triángulo del color de su facción, con su nombre) que **se mueve solo por el mapa**. A dónde va depende de lo que haya escrito en el chat esa ronda:

| Comando | A dónde va su marcador |
|---|---|
| *(ninguno)*, o fuera de la Fase de Acción | Pasea por el territorio de su facción, a pasitos cortos |
| `!ataque <N>` | A la frontera con la facción N |
| `!defender` | Al castillo o aldea más cercano de su territorio |
| `!expansion` | A la frontera con el territorio neutral |
| `!industria` | A una casilla suya que tenga industria levantada |

Al resolverse la ronda, el servidor deja de mandar acción y los supervivientes **vuelven solos a pasear**. Los muertos dejan de tener marcador.

**Toda la animación es local de cada navegador.** El servidor NO manda posiciones: mandarlas a 60fps por WebSocket para decenas de jugadores no sería viable. Solo manda *qué está haciendo* cada uno (`player.action` y `player.actionTargetFactionNumber` en `getPublicState()`, y solo durante `PHASE_ACTION`), y cada cliente decide el destino y mueve el marcador por su cuenta. Que dos espectadores vean al mismo aldeano dos pasos desplazado da igual: es decoración, no estado de juego.

**Dónde vive**: la capa de caminantes está dentro de `createObjectLayer()` en `public/mapRenderer.js`, es decir en el canvas del tamaño del **viewport**. Los marcadores estaban antes en `markersEl` (canvas del tamaño del mundo entero, 8800×4604): limpiarlo y repintarlo en cada frame habría sido carísimo. En `markersEl` se quedan solo las cosas estáticas (etiquetas de casilla, cuadros de industria, escudo/espada). El bucle de animación **solo corre mientras hay caminantes**; sin jugadores no gasta un frame cada 16ms.

Detalles que costaron un par de vueltas y conviene no deshacer:

- **Rutas por tierra, no líneas rectas** (`setRoute()` / `tilePathBetween()`): marchar en línea recta hacía que los soldados cruzaran bahías andando sobre el agua, porque el destino era válido pero el trayecto no. Ahora se busca el camino entre casillas vecinas (que por definición se tocan por tierra) y se va pasando por el centro de cada una, sin atravesar territorio ajeno. Es una búsqueda en anchura sobre unas pocas decenas de casillas: cuesta nada.
- **El paseo también valida el trayecto** (`pathStaysInside()`), no solo el punto de destino, por lo mismo.
- **Dos velocidades** (`WALK_SPEED_WANDER` 55 / `WALK_SPEED_MARCH` 300 px de mundo por segundo): a paso de paseo no daba tiempo a llegar a la frontera dentro de la fase de acción (medido: ~1.100px hasta un castillo, 16 segundos a la velocidad de paseo). Que además se note el cambio de ritmo al dar una orden es lo que hace legible de un vistazo quién va a algún sitio y quién no.
- **`coastFacing()` (código defensivo, ya no se puede disparar en la práctica)**: `borderPointWith()` cae aquí si no encuentra frontera real entre las dos facciones. Desde que `!ataque <N>` exige frontera compartida para ser aceptado (sección 12), el servidor nunca manda `action: 'ATTACK'` con una facción no adyacente — así que este camino se queda sin usar en un cliente normal. Se deja tal cual (no estorba, y es la red de seguridad si algún día se permitiera ordenar un ataque sin frontera por otra vía) en vez de borrarlo.
- **El triángulo escala con el mundo** (es un personaje sobre el suelo, como los árboles) pero **el nombre va a tamaño de pantalla fijo**, y solo se dibuja por encima de cierto zoom: escalarlo con el mundo lo hace ilegible de lejos y gigante de cerca, y dibujar texto es de largo lo más caro de esta capa.
- `mapCtrl.getPlayerPositions()` devuelve dónde está cada marcador ahora mismo (píxeles de mundo). Lo usa el buscador de jugadores del panel para saltar a donde está uno **en ese momento**, no a donde estaba en el último cambio de estado.

## 12. Atacar exige frontera compartida (`factionsAreAdjacent()`)

Decisión tomada para el problema de "facciones en continentes distintos" que estaba pendiente aquí: **no** hay ataques por mar. `!ataque <N>` solo es válido si la facción de quien escribe tiene alguna casilla que toque (por tierra, casilla-con-casilla) a alguna casilla de la facción N — se comprueba en `castAction()` (`server/gameEngine.js`) con `factionsAreAdjacent(match, factionNumberA, factionNumberB)` (`server/rules/territory.js`, ya existía y se reutiliza tal cual). Si no hay frontera, el comando se rechaza exactamente igual que cualquier otro comando inválido (mismo `pushChatLog` con `ok:false`, no hay caso especial ni aviso distinto en el chat): es como si el jugador no hubiera escrito nada esa ronda.

Consecuencia directa para el diseño: **`!expansion` es el único camino** para que dos facciones sin frontera lleguen a poder atacarse — conquistando territorio neutral hasta que sus fronteras se toquen. Esto también simplifica el lado del cliente: como el servidor nunca acepta ni difunde un `ATTACK` hacia una facción no adyacente, el marcador de un jugador nunca recibe esa orden en un caso así (ver la nota sobre `coastFacing()` en la sección 11, que queda como código defensivo sin usarse en la práctica).

## 13. Paron decorativo entre fases: el esqueleto con el cartel

Entre cada cambio de fase importante hay una pausa de verdad de 10-15s (`TRANSITION_MS` = 12000ms en `server/gameEngine.js`) en la que un esqueleto cruza la pantalla de izquierda a derecha con un cartel anunciando el cambio. **No es solo un adorno del cliente**: la ronda deja de avanzar en el servidor mientras dura, así que ningún comando de chat tiene efecto durante ese rato.

**Cómo se para la ronda de verdad (`PHASE_TRANSITION`, sección 1):** `enterTransition(kind, round, onDone)` en `server/gameEngine.js` es el único sitio que entra en esta fase. Pone `match.phase = PHASE_TRANSITION`, guarda `match.transition = { kind, round }` y arranca el timer genérico de siempre (`startTimer`/`clearTimer`/`forceAdvancePhase`, el mismo mecanismo que ya usaban el resto de fases) apuntando a `onDone`, que es quien hace el cambio de fase de verdad cuando expira. Como ninguna acción de chat tiene `PHASE_TRANSITION` como fase requerida (`VALID_PHASE_BY_ACTION` en `server/commands.js`), el rechazo de comandos durante el paron sale gratis del mecanismo que ya existía — no hizo falta ningún caso especial. Se usa en los tres puntos que pidió el streamer:

| Disparador | `kind` | Cartel que enseña |
|---|---|---|
| Cierra Reclutamiento → antes de la Ronda 1 de Acción | `'first-action'` | "¡Comienza la partida! Ronda 1 — Fase de Acción" |
| Se resuelve el combate → antes de enseñar el Resumen | `'summary'` | "Fin de la ronda N — Resumen" |
| Termina el Resumen → antes de la siguiente ronda de Acción | `'next-round'` | "Ronda N — Fase de Acción" |

`forceAdvancePhase()` (el botón de saltar fase del admin) funciona igual que siempre: como llama a lo que sea que esté armado en `match.timer.onExpire`, si se usa durante el paron simplemente lo corta ahí (el esqueleto desaparece en el acto) y entra en la fase real; si se usa otra vez desde esa fase real, entra en el siguiente paron. No hace falta ningún caso especial para el admin.

**Cliente** (`public/index.html`): `state.transition` viaja dentro de `getPublicState()` (`null` cuando no hay paron en curso). `handleTransitionBanner()` muestra/oculta `#transitionBanner` según ese campo y `transitionMessage()` decide el texto según `kind`/`round` — **el texto NO está horneado en el PNG**, se dibuja en HTML/CSS encima, para poder tener los 3 mensajes con una sola imagen. `animateTransitionSkeleton()` anima el recorrido usando `state.timerEndsAt` (el mismo campo genérico que ya usa la cuenta atrás de cualquier fase) para que el paseo dure exactamente lo que quede de verdad del paron — si el admin lo corta antes, el cartel desaparece en vez de quedarse a medias. El cartel se recoloca cada frame pegado al esqueleto pero **recortado para no salirse nunca de la pantalla** (si no, el texto queda cortado por el borde cuando el esqueleto entra o sale por los lados).

Franja fija en el **1/5 inferior de la pantalla** (`height:20vh`), por encima de todo lo demás pero con `pointer-events:none` en toda la franja: es decorativo, nunca bloquea clics en lo que tape visualmente (mapa, botones de zoom) mientras dura.

**Sustituir el placeholder**: `public/sprites/skeleton.png` (64×110, fondo transparente), generado por `tools/bakeSpritePlaceholders.js` igual que el resto de sprites — sobrescribe el archivo y recarga, no hace falta tocar código. Si el arte nuevo tiene otra proporción, el punto donde se ancla el cartel (`skelWidth * 0.85` en `animateTransitionSkeleton()`, `public/index.html`) puede necesitar un ajuste fino.

## 14. Botón de ayuda / mini-tutorial

Abajo a la derecha, `#helpButton` en `public/index.html`: un icono suelto de 64×64 (el doble que un botón de cabecera normal), con fondo transparente **a propósito** — no lleva la chapa de latón de `.headerBtn` porque es un icono independiente pensado para poder sustituirse por cualquier otro sin tocar CSS.

Secuencia de dos clics (`handleHelpClick()`):
1. Primer clic → aparece un bocadillo corto (`#helpBubble`, con su "pico" apuntando al botón) invitando a pulsar otra vez.
2. Segundo clic → se cierra el bocadillo y se abre `#helpModal`, un popup de pergamino (mismo estilo que el resto de popups del proyecto) con un mini-tutorial de las 3 fases de la partida (Reclutamiento / Acción / Resumen) y la mención al esqueleto de la sección 13. Cerrar el modal reinicia la secuencia: la próxima vez que se pulse el botón, vuelve a enseñar primero el bocadillo.

**Sustituir el placeholder**: `public/sprites/help-icon.png` (64×64, fondo transparente, medallón dorado con una interrogación en bloques), generado por `tools/bakeSpritePlaceholders.js`. Sobrescribe el archivo y recarga.

## 15. Marcador de jugador, industria, vaca-easter-egg y nubes: todo a sprite

Cuarta tanda de cambios: el triángulo del jugador y el cuadrado de industria pasan de dibujarse a mano a ser PNG sustituibles, más dos elementos nuevos puramente decorativos (una vaca y unas nubes). Ninguno de los cuatro toca ninguna regla del juego.

**Marcador de jugador → sprite del soldado.** Antes `drawWalkers()` dibujaba un triángulo con `ctx.moveTo/lineTo`; ahora dibuja `public/sprites/soldier-right.png` / `soldier-left.png` (24×40, rectángulo vertical como se pidió en vez de triángulo). El sprite que toca lo decide `walker.dir`, que `stepWalkers()` actualiza solo según el signo del último desplazamiento horizontal (con un umbral pequeño, `WALKER_DIR_THRESHOLD`, para que un tramo casi vertical no lo haga parpadear entre los dos). El **color de facción no se pierde**: como ahora es un sprite y no una forma rellenada, `drawTintedSprite()` lo tiñe en tiempo real con `ctx.globalCompositeOperation = 'source-atop'` (pinta un rectángulo de color solo donde el sprite ya dejó píxel opaco, así nunca se sale de la silueta) — un único PNG gris sirve para todas las facciones, no hace falta un archivo por facción. Esto mismo (dos sprites por sentido, gestión de `dir` igual) se reutiliza tal cual para la vaca, ver más abajo.

**Industria → sprite, y más pequeño que una aldea.** `paintIndustryMarkers()` dibujaba un cuadrado amarillo (`fillRect`/`strokeRect`); ahora dibuja `public/sprites/industry.png`. Como se pidió expresamente que fuera "algo más pequeño que las aldeas en el mapa", su tamaño (`INDUSTRY_SPRITE_WORLD_WIDTH = 46`) está en las MISMAS unidades que `DECOR_SPRITES.village.worldWidth` (90) — la mitad, y comparable a cualquier zoom porque las dos escalan igual. Antes el cuadrado tenía un tamaño CONSTANTE en pantalla (`screenPx()`, para compensar que `markersEl` sí recibe el `transform` CSS del zoom); ahora, al no usar `screenPx()`, el propio `transform` de `markersEl` ya lo escala con el mundo — un cambio necesario para que "más pequeño que una aldea" signifique lo mismo a cualquier zoom, no solo a uno concreto.

**Vaca (easter egg).** Única en todo el mapa, decorativa al cien por cien (no cuenta para ninguna regla). Vive dentro de `createObjectLayer()` en `public/mapRenderer.js`: se siembra sola (`spawnCow()`) en cuanto llega el primer estado con mapa, en una casilla de tierra al azar — a diferencia de los caminantes, **no mira de quién es el territorio**, solo que sea tierra (`isLandAtWorld()`/`pathStaysOnLand()`, la misma idea que `wanderTarget()`/`pathStaysInside()` de los caminantes pero sin filtrar por facción). Vaga sola (`stepCow()`) con las mismas reglas de pausa-y-elige-otro-sitio que un caminante paseando, y usa dos sprites por sentido (`cow-left.png`/`cow-right.png`, "un rectángulo blanco" tal cual se pidió) igual que el soldado.

Un acompañante (`cow-follower.png`, un único sprite, sin variante de sentido — no se pidió) la sigue siempre a poca distancia. En vez de perseguir la posición actual de la vaca (lo que le haría cortar camino por sitios por los que la vaca no ha pasado, cruzando agua si el rodeo de la vaca fue por tierra), guarda un **rastro** de sus últimas posiciones (`cow.trail`, un punto cada `COW_TRAIL_SAMPLE_MS`) y el acompañante apunta siempre al punto del rastro de hace `COW_FOLLOWER_LAG_MS` (~650ms) — así va exactamente por donde ya pasó la vaca, nunca en línea recta hacia ella. Verificado con datos reales del motor (no a ojo): en 6 muestras cada 1.5s, la vaca y el acompañante cayeron siempre en tierra y la distancia entre ambos se mantuvo estable (~30px) una vez la vaca llevaba un rato en marcha.

**Nubes del cielo.** Puramente atmosférico, sin relación con la partida — por eso van en coordenadas de **pantalla**, no de mundo (no hay que convertir nada al hacer pan/zoom), y se dibujan en el mismo canvas de objetos, que ya está recortado exactamente a la franja del mapa entre las dos barras de madera (`#mapViewport` en `shared.css`): no hace falta ninguna comprobación aparte para que no invadan los menús ni se superpongan a un popup (los popups van muy por encima en z-index). `spawnCloudBatch()` crea grupos de 1, 2 o 4 nubes (55/30/15%, "no muchas, unas pocas") que entran por un lado de la pantalla y cruzan hacia el otro en línea recta, en cualquiera de los dos sentidos al azar, y se retiran solas (`stepClouds()`) en cuanto salen del todo por el lado contrario — nunca rebotan ni se quedan enganchadas al borde. 3 tamaños de sprite (`cloud-1/2/3.png`) elegidos al azar por nube para que un grupo no se vea uniforme. Se hornean opacas a propósito: la transparencia final ("muy transparentes", como se pidió) se aplica en el código (`CLOUD_ALPHA = 0.3`, con `ctx.globalAlpha` al dibujar), no horneada en el PNG, para poder ajustarla sin regenerar nada. El sembrado inicial (`initClouds()`, se reintenta desde `onLayout()`/`onResize()` hasta que el viewport tenga medidas de verdad) reparte las primeras nubes ya por toda la pantalla en vez de entrando por un borde, para que el cielo no se vea vacío los primeros segundos.

El bucle de animación (`startWalkerLoop()`, ver sección 11) ya no se para solo porque no haya jugadores: sigue corriendo mientras haya caminantes, la vaca, O ALGUNA NUBE (`needsAnimationLoop()`) — y como las nubes se reponen solas sin parar, en la práctica el bucle ya no se detiene nunca mientras la página esté abierta. Es el coste esperado de tener un efecto de cielo siempre encendido, no una fuga.

**Sustituir los placeholders**: `public/sprites/soldier-{left,right}.png`, `industry.png`, `cow-{left,right}.png`, `cow-follower.png`, `cloud-{1,2,3}.png` — todos en `public/sprites/`, generados por `tools/bakeSpritePlaceholders.js`. Sobrescribe el archivo y recarga; si el arte nuevo cambia mucho de proporción, los anchos de mundo/pantalla de cada uno (`WALKER_SPRITE_WORLD_W/H`, `INDUSTRY_SPRITE_WORLD_WIDTH`, `COW_SPRITE_WORLD_W`, `COW_FOLLOWER_SPRITE_WORLD_W`) están todos en `public/mapRenderer.js`, cerca de donde se cargan.

## 16. Las 4 mejoras de industria de verdad, logotipo, y varias correcciones

Quinta tanda: las 4 mejoras de industria (secciones 7 y 9 ya las mencionaban, pero con la mecánica vieja de v1 — subir a "tanque", bombardeo/operación especial contra un enemigo) pasan a la mecánica definitiva que pidió el streamer. Ninguna se vota: las 4 saltan solas al cruzar su umbral (`industryThresholdsFor()`, sin cambios — sigue siendo `perPlayer × rosterSize`, ver sección 7).

| Nivel | `tierKey` | Qué hace |
|---|---|---|
| 1 | `caballero` | 1 soldado al azar de la facción pasa a **caballero** |
| 2 | `industria_extra` | Se levantan **3 edificios de industria** de golpe (como si 3 usuarios hubieran votado `!industria` esa ronda) |
| 3 | `caballeros_x3` | **3 soldados más** pasan a caballero (nunca repite a quien ya lo sea) |
| 4 | `tregua` | Nadie puede atacar a esta facción la **ronda siguiente** |

**Caballeros** (`upgradeRandomSoldiers()` en `rules/industry.js`): sube a caballero a `count` soldados al azar (`unitType: 'soldier'` → `'knight'`). El filtro por `unitType === 'soldier'` es lo único que hace falta para que el nivel 3 nunca repita a quien ya ascendió el nivel 1 — no hace falta ninguna lista de exclusión aparte. Si la facción tiene menos soldados vivos que los que tocan, sube a todos los que haya (verificado con el motor real: una facción de 3 jugadores que cruza los 4 umbrales acaba con sus 3 miembros de caballeros, ni uno repetido, ni un error).

Un caballero **cuenta más en combate**: tira su fuerza en 0.9–1.4 en vez de 0.7–1.3 (`KNIGHT_RANDOM_MIN/MAX` en `rules/shared.js`). Esto obligó a cambiar `sumRandomPower()`: antes recibía solo un **número** de votantes (daba igual quién fuera cada uno), ahora recibe `match` + la lista de **userIds** y mira el `unitType` de cada uno para tirar en el rango que le toque — `resolveCombat()` en `rules/combat.js` le pasa los userIds de verdad (`attackers.flatMap(a => a.userIds)` para atacantes, el array de `!defender` tal cual para defensores) en vez de solo sus longitudes. Verificado estadísticamente sobre 20.000 tiradas: media 1.00 para soldado, 1.15 para caballero, justo el punto medio de cada rango.

En el mapa el caballero es un sprite distinto (`knight-{left,right}.png`, "algo más grande, no mucho" que el soldado — 26×42 px de mundo frente a 22×36) y se mueve más rápido ("simula un caballo"): `KNIGHT_SPEED_MULTIPLIER = 1.6` en `public/mapRenderer.js`, aplicado sobre las dos velocidades normales (paseo y marcha) en `stepWalkers()`. Por lo demás se comporta exactamente igual que un soldado — mismo `!ataque`/`!defender`/`!expansion`/`!industria`, va a los mismos sitios — así que no hizo falta tocar nada de la lógica de destino de los caminantes, solo qué sprite/velocidad le corresponde.

**Tregua** (nivel 4): igual que una alianza automática con **todas** las facciones vivas, pero sin depender de que el admin tenga las alianzas activadas en esa partida (`resolveIndustryImmunity()` en `rules/industry.js`, independiente de `resolveAlliances()`). Se arma en la ronda que se desbloquea (`faction.attackImmuneNextRound = true`) y se activa la ronda SIGUIENTE — mismo patrón en dos pasos que ya usaba el Sabotaje (`industryPenaltyActive`/`industryPenaltyNextRound`): al principio de `resolveRound()` en `gameEngine.js` se "activa" lo que quedó armado la ronda anterior, y solo entonces `resolveIndustryImmunity()` anula (mueve a `context.forceInactive` y borra del mapa de votos) cualquier ataque que reciba esa facción esa ronda. Verificado en dos niveles: una prueba unitaria aislada de `resolveIndustryImmunity()` (con un `context` de mentira, sin pasar por generación de mapa) confirma que anula SOLO los ataques que le llegan a la facción con tregua y deja intactos los demás; y una partida real de punta a punta confirma que, tras cruzar el nivel 4, un ataque real de otra facción no causa bajas ni conquista ninguna casilla.

**Nombres nuevos en la interfaz**: `TIER_LABELS` en `public/index.html` (resumen de ronda), la columna "Caballeros" de la clasificación (antes "Tanques"), y la etiqueta 🐴 en el roster (antes 🛡) — todo lo que decía `tank`/`unitType==='tank'` pasa a `knight`.

### Logotipo

`#gameLogo` en `public/index.html`, arriba del todo y centrado, con `z-index` por encima de la barra de madera para que sobresalga por encima de ella (`height: calc(var(--map-margin-y) * 1.7)`, a propósito más grande que pidió el streamer — "mejor que sobre y lo recorte yo"). `pointer-events:none`: es solo una imagen superpuesta, nunca le roba el click al título ni a los botones de debajo. Placeholder: `public/sprites/logo.png` (320×140, fondo transparente, un escudo dorado simple), generado por `tools/bakeSpritePlaceholders.js`. Sobrescribe el archivo y recarga.

### Bot de Twitch: una línea de chat mala ya no se comía el resto de la tanda

Bug real encontrado al investigar el aviso del streamer de que a veces el bot "no lee todos los comandos" cuando el chat va muy rápido. Twitch manda varias líneas IRC (varios mensajes de chat) dentro de un único frame de WebSocket cuando hay mucho tráfico. `server/twitchBot.js` las recorría con un `forEach(handleLine)` sin ningún `try/catch`: si UNA línea de la tanda hacía saltar una excepción en cualquier punto (parseo raro, o más abajo en el motor/broadcast), el `forEach` entero se paraba ahí y **todas las líneas siguientes de esa misma tanda se perdían sin más** — comandos de chat válidos incluidos, o incluso el PONG de un PING que llegara después en la misma tanda (lo que a la larga puede hacer que Twitch cierre la conexión). Arreglado envolviendo el procesado de cada línea en su propio `try/catch`: una línea rara ahora solo se pierde a sí misma, el resto de la tanda sigue igual. No es un límite de Twitch (el bot es de solo lectura, con sesión anónima — el límite de "20 mensajes/30s" de Twitch es para mensajes que el bot ENVÍA al chat, no para los que recibe), era un bug de verdad en este repositorio.

### Probeta de industria: los datos ya estaban bien, el problema era el tamaño

El aviso del streamer de que "el líquido no sube y las 4 rayas no se ven" se investigó con datos reales del motor (no a ojo): tanto `industryGainedLastRound` como `industryThresholds` llegan correctos al cliente en cada ronda, y el SVG de la probeta ya incluía el rectángulo de líquido y las 4 líneas de marca con los valores exactos — no había ningún bug de datos. Lo que pasaba es que a 26×72 píxeles reales (el tamaño con el que se venía dibujando) una marca sin alcanzar quedaba en un trazo de menos de 1px, prácticamente invisible, y con los umbrales ya afinados a "ritmo medio" (sección 9) el líquido tarda muchas rondas reales en notarse. Se agrandó el renderizado un 40% (`FLASK_RENDER_SCALE` en `public/factionCards.js`, sin tocar el `viewBox` ni ninguna coordenada del dibujo — así no hizo falta recalcular a mano la docena de puntos del cristal/corcho) y se subió el contraste de las marcas sin alcanzar (antes `#7a6a52` al 50% de opacidad, ahora `#5a4a32` al 80%, con más grosor de trazo).

### Panel de facciones con 1 o con 100 jugadores: sin solapes

Comprobado con una partida real (una facción de 100 jugadores, otra de 1) y una comprobación de solapes de verdad (rectángulos de cada tarjeta/estadística/probeta/etiqueta del roster, no "se ven cerca" sino intersección de área > 0) sobre 113 elementos: **0 solapes**. `.factionCardMain`/`.rosterMini` ya usan `flex-wrap`, así que las estadísticas y las etiquetas de jugador simplemente pasan a la siguiente línea en vez de superponerse — con 100 jugadores la tarjeta sale más alta (muchas líneas de etiquetas), no rota. El panel entero (`.sidePanel`) ya tenía `overflow-y:auto`, así que una tarjeta muy alta no rompe nada, solo hace más largo el scroll.
