'use strict';

/**
 * Único módulo del proyecto que sabe dibujar el mapa (rectángulo raster estilo
 * Risk). Lo usan tanto `public/index.html` como `admin/index.html` — ninguna
 * de las dos páginas reimplementa este dibujado por su cuenta. Ver
 * docs/ACCIONES.md sección 6 para la forma de `mapLayout`, `tiles` y `players`.
 *
 * Uso:
 *   const map = CondejorgeMap.createMapController({ viewportEl, canvasEl, markersEl, terrainBgEl, objectsEl });
 *   map.setLayout(mapLayoutRecibidoPorWs); // una vez, cuando llega `map:layout`
 *   map.setTiles(state.tiles, state.factions, state.players); // cada vez que llega state:public/admin
 *   map.zoom(1.25); map.reset(); // botones +/-/centrar
 *   map.focusOnPlayer('nombre'); // buscador del panel de jugadores
 *
 * Cuatro capas superpuestas dentro de `#mapViewport`, de fondo a primer plano:
 *   - `terrainBgEl` (`#mapTerrainBg`, <img>): el terreno horneado
 *     (`public/terrain/world.png` — ver `tools/bakeWorldTerrain.js`), a
 *     tamaño natural (mismo tamaño en píxeles que el raster). Recibe el
 *     MISMO transform que `canvasEl` (ver applyTransform()) para que quede
 *     pixel a pixel alineado con él al hacer pan/zoom — es estático, nunca
 *     se repinta.
 *   - `canvasEl` (`#mapCanvas`): el raster de territorios (tierra/océano/
 *     fronteras, coloreado por dueño). Caro de repintar (recorre cada celda
 *     del raster), así que solo se repinta de verdad cuando cambia qué
 *     facción es dueña de cada casilla — ver `paint()` y el "fingerprint" de
 *     propiedad. Se pinta con transparencia (ver ALPHA_BY_KIND) para que el
 *     terreno de `terrainBgEl` se siga viendo por debajo, como un tinte de
 *     propiedad sobre un mapa real en vez de taparlo del todo.
 *   - `objectsEl` (`#mapObjects`, opcional): árboles/rocas/arbustos/conchas/
 *     palmeras — objetos DISCRETOS con posición propia
 *     (`public/terrain/objects.bin`, ver `tools/generateWorldObjects.js`).
 *     A diferencia de las otras capas, ESTA NO recibe el transform CSS: es
 *     un canvas del tamaño del VIEWPORT (no del mundo entero) que se
 *     REDIBUJA en cada pan/zoom, dibujando solo los objetos que caen dentro
 *     de lo visible (+ un margen, para que no aparezcan de golpe al entrar
 *     en pantalla) — el coste es proporcional a cuántos objetos hay en
 *     pantalla, no a cuántos hay en el mundo. Con zoom muy alejado se ocultan
 *     los objetos pequeños (LOD con histéresis, ver drawObjectLayer()) para
 *     no intentar dibujar decenas de miles de objetos de menos de 1px.
 *   - `markersEl` (`#mapMarkers`, opcional pero usado por las dos páginas):
 *     etiquetas de casilla + marcadores de jugador. Barato de repintar
 *     (proporcional a nº de casillas/jugadores, no a celdas de raster), así
 *     que se repinta siempre que llega un `state:*` nuevo, sin tocar el raster.
 */
(function () {
  // Tamaño en pixeles del terreno horneado (public/terrain/world.png o
  // iberia.png, segun que mapa haya elegido el admin — ver
  // tools/bakeWorldTerrain.js) — MISMA resolucion que COLS x ROWS del land
  // mask de ESE mapa en el servidor (server/worldLandMask.js /
  // server/iberiaLandMask.js). `layout.cols/rows` (lo que manda `map:layout`
  // por partida) es una rejilla mucho mas basta a proposito (ver
  // TERRAIN_DOWNSAMPLE en server/mapTemplates.js: genera el mapa mas rapido y
  // con un payload de red mucho menor) — BLOCK_PX es el factor que reescala
  // esa rejilla basta hasta este tamaño de pantalla al pintar, para que
  // `canvasEl` y `terrainBgEl` (el PNG, a este mismo tamaño) queden
  // perfectamente alineados bajo el mismo transform de pan/zoom.
  // `TERRAIN_IMAGE_COLS/ROWS` y el archivo a cargar ya NO son fijos: llegan
  // en `newLayout.terrainImageCols/Rows/terrainFile` (ver setLayout() mas
  // abajo) y se recalculan en cada `map:layout` — con un valor por defecto
  // (mundo) para no romper si algun caller viejo no los manda.
  let TERRAIN_IMAGE_COLS = 8800;
  let TERRAIN_IMAGE_ROWS = 4604;
  let BLOCK_PX = 1;
  const NEUTRAL_COLOR = '#3a3f45';
  const BORDER_COLOR = '#050a10'; // borde entre dos territorios de tierra
  const COAST_COLOR = '#5fb8d9'; // borde entre tierra y oceano (linea de costa)
  const OCEAN_COLOR = '#0b2436';
  const OCEAN = -1; // mismo sentinel que server/mapTemplates.js — celda de oceano, sin tile
  // No hay MIN_SCALE fijo: el mapa se comporta como un fondo (estilo Google
  // Maps) que nunca puede ser mas pequeño que el viewport. La escala minima
  // se recalcula siempre con coverScale() — ver mas abajo. El oceano (sin
  // repartir entre territorios) ya deja aire alrededor de la tierra incluso
  // al zoom minimo, asi que no hace falta ningun margen artificial aparte.
  const MAX_SCALE = 2.5; // zoom moderado: lo justo para ver bien un territorio y sus vecinos, no arte de detalle
  const FOCUS_SCALE = MAX_SCALE; // zoom que usa focusOnPlayer() al saltar al marcador de un jugador

  // Clasificacion de cada celda del raster, precomputada UNA vez por
  // `mapLayout` (no depende de quien sea el dueño de cada casilla, solo de la
  // geometria fija tierra/oceano/fronteras) — ver computeCellRenderKind().
  const KIND_OCEAN = 0;
  const KIND_COAST = 1;
  const KIND_BORDER = 2;
  const KIND_LAND = 3;

  // Layout de los marcadores de jugador alrededor del centroide de su
  // facción al repartirlos por primera vez: hasta PLAYERS_PER_RING por
  // anillo, cada anillo un poco mas lejos del centro. A partir de ahi cada
  // marcador se mueve por su cuenta (ver la capa de caminantes en
  // createObjectLayer), asi que esto solo decide de donde SALE cada uno.
  // Valores en pixeles de MUNDO.
  const PLAYERS_PER_RING = 8;
  const MARKER_RING_BASE_RADIUS = 26;
  const MARKER_RING_STEP = 24;

  // Sprite del edificio de industria (ver paintIndustryMarkers): PNG
  // sustituible en public/sprites/industry.png (antes era un cuadrado
  // amarillo dibujado a mano). El ancho va en pixeles de MUNDO, igual que
  // `DECOR_SPRITES` mas abajo — a proposito algo mas pequeño que `village`
  // (90 ahi): 67.5 = 75% de 90, tal y como se pidio.
  const INDUSTRY_SPRITE_WORLD_WIDTH = 67.5;
  const industrySpriteImg = new Image();
  industrySpriteImg.src = '/sprites/industry.png';
  industrySpriteImg.addEventListener('error', () => {
    console.warn('[mapRenderer] falta public/sprites/industry.png, no se dibujaran las industrias');
  });

  // Edificios de tropa (!levas/!arqueros/!caballeros, ver
  // rules/troopBuildings.js): mismo tamaño de referencia que village (90),
  // un poco mas pequeño. La posicion ya NO es una cuadricula fija: ver
  // MARKER_SCATTER_* y scatterPosition() mas abajo.
  const TROOP_BUILDING_SPRITE_WORLD_WIDTH = 80;
  function loadBuildingSprite(fileName) {
    const img = new Image();
    img.src = `/sprites/${fileName}.png`;
    img.addEventListener('error', () => {
      console.warn(`[mapRenderer] falta public/sprites/${fileName}.png, no se dibujara ese edificio`);
    });
    return img;
  }
  const barracaSpriteImg = loadBuildingSprite('barraca');
  const campoArqueriaSpriteImg = loadBuildingSprite('campo-arqueria');
  const caballerizaSpriteImg = loadBuildingSprite('caballeriza');
  // Torres (!torre, ver rules/towers.js seccion 28): mismo mecanismo de
  // scatter que barraca/campo-arqueria/caballeriza, dos sprites — una para
  // `towerBuildingCount` (en obras, todavia sin dar defensa) y otra para
  // `towerCount` (terminada, +0.5 de defensa pasiva cada una).
  const torreObrasSpriteImg = loadBuildingSprite('torre-obras');
  const torreSpriteImg = loadBuildingSprite('torre');

  // Maravillas (ver docs/ACCIONES.md sección 30, rules/wonders.js): 6 fijas,
  // cada una con su propio placeholder — se cargan todas de una vez en un
  // mapa `key -> Image` para que paintWonderMarkers() no tenga que hacer un
  // switch largo. SIN teñir de color de facción (landmark del mapa, no "de"
  // nadie, aunque quien posea la casilla se lleve el bono).
  const WONDER_SPRITES = {
    guggenheim: loadBuildingSprite('wonder-guggenheim'),
    numancia: loadBuildingSprite('wonder-numancia'),
    moncloa: loadBuildingSprite('wonder-moncloa'),
    spacex: loadBuildingSprite('wonder-spacex'),
    kebab: loadBuildingSprite('wonder-kebab'),
    contrato: loadBuildingSprite('wonder-contrato'),
  };
  const WONDER_SPRITE_WORLD_W = 60;
  const WONDER_MARKER_OFFSET_Y = 78; // px de mundo por encima del sprite, para el nombre+bono

  // Marcador de guarnición neutral sobre castillo/aldea/puerto todavía sin
  // conquistar (!conquista, ver rules/structures.js y docs/ACCIONES.md
  // sección 20): icono + cuántas tropas de cada tipo tiene + su ataque/
  // defensa ya calculados por el servidor (mismas constantes que las tropas
  // del jugador, ver getPublicState() en gameEngine.js — el cliente no
  // repite esa cuenta, solo la pinta).
  const guardiaSpriteImg = loadBuildingSprite('guardia');
  // Icono del marcador de un dungeon (ver docs/ACCIONES.md sección 27):
  // orco, para diferenciarlo de un vistazo del icono de guarnición normal.
  const orcoSpriteImg = loadBuildingSprite('orco');
  const STRUCTURE_MARKER_ICON_W = 16;
  const STRUCTURE_MARKER_OFFSET_Y = 90; // px de mundo por encima del centroide de la casilla
  const STRUCTURE_TYPE_ICON = { castle: '🏰', village: '🏘️', port: '⚓', dungeon: '💀' };

  // Chapitas de combate en vivo (escudo de defensores / espada de atacantes,
  // ver paintCombatBadges). BADGE_OFFSET_Y va en celdas de rejilla: cuanto se
  // suben respecto al centro de la faccion para no taparse con la nube de
  // marcadores de jugador.
  const BADGE_W = 34;
  const BADGE_H = 16;
  const BADGE_OFFSET_Y = 46;
  const BADGE_DEFEND_BG = 'rgba(46, 138, 62, .92)';
  const BADGE_ATTACK_BG = 'rgba(178, 44, 34, .92)';

  // Transparencia (0-255) de cada tipo de celda al pintar el raster de
  // territorios sobre el terreno horneado (`terrainBgEl`) — ver comentario
  // de cabecera. El océano se deja del todo transparente (el terreno ya
  // dibuja agua+oleaje bonitos), las fronteras casi opacas (tienen que
  // seguir leyéndose nítidas encima de cualquier textura), tierra/costa a
  // medio camino para que se note el tinte de facción sin tapar el terreno.
  const ALPHA_BY_KIND = { [KIND_OCEAN]: 0, [KIND_COAST]: 90, [KIND_BORDER]: 235, [KIND_LAND]: 130 };

  function createMapController({ viewportEl, canvasEl, markersEl, terrainBgEl, objectsEl, showLabels = true }) {
    let layout = null; // { cols, rows, cellTileIds, centroids }
    let offscreen = null; // canvas pequeño (1px por celda de raster) para pintar rapido con ImageData
    let cellRenderKind = null; // Uint8Array, una entrada por celda de raster — ver computeCellRenderKind()
    let mapView = { x: 0, y: 0, scale: 1 };
    let hasFitOnce = false;
    let dragging = false;
    let dragStart = { x: 0, y: 0, viewX: 0, viewY: 0 };
    let lastTiles = null; // ultimo `state.tiles`/`state.factions`/`state.players`/`state.structures` recibidos, por si `map:layout`
    let lastFactions = null; // llega despues de un `state:public`/`state:admin` (el orden de los
    let lastPlayers = null; // mensajes WS no esta garantizado en todos los casos — ver docs/ACCIONES.md seccion 5).
    let lastStructures = null; // estructuras conquistables con guarnicion todavia (ver paintStructureMarkers()).
    let lastWonders = null; // maravillas (ver paintWonderMarkers(), rules/wonders.js seccion 30).
    let lastBosses = null; // bosses (ver syncBossWalkers() en createObjectLayer, rules/bosses.js seccion 31).
    let lastRasterFingerprint = null; // ver paint(): evita repintar el raster si la propiedad de las casillas no cambio
    let overlayRepaintPending = false; // ver scheduleOverlayRepaint()

    // --- capa de objetos (arboles/rocas/etc.), ver createObjectLayer() mas abajo ---
    const objectLayer = objectsEl ? createObjectLayer(objectsEl, viewportEl) : null;

    function setLayout(newLayout) {
      // El servidor manda `cellTileIds` empaquetado (`cellTileIdsPacked`) en
      // vez de un array JSON plano — a esta resolución del mapa (~10M celdas)
      // el array plano pesaría ~27,5MB por mensaje. Se desempaqueta aquí, una
      // única vez por partida (setLayout solo se llama al llegar `map:layout`,
      // que es estático durante toda la partida) — ver decodeCellTileIds() y
      // server/mapLayoutCodec.js (MISMO formato en los dos sitios) y
      // docs/ACCIONES.md sección 6.
      const cellTileIds = decodeCellTileIds(newLayout.cellTileIdsPacked, newLayout.cols * newLayout.rows);
      layout = { cols: newLayout.cols, rows: newLayout.rows, centroids: newLayout.centroids, cellTileIds };
      // Que mapa toca esta partida (mundo/España/...) — ver AVAILABLE_MAPS en
      // server/mapTemplates.js. Con valor por defecto (mundo) por si algun
      // `map:layout` viejo no los manda.
      TERRAIN_IMAGE_COLS = newLayout.terrainImageCols || 8800;
      TERRAIN_IMAGE_ROWS = newLayout.terrainImageRows || 4604;
      const terrainFile = newLayout.terrainFile || '/terrain/world.png';
      offscreen = document.createElement('canvas');
      offscreen.width = layout.cols;
      offscreen.height = layout.rows;

      // `layout.cols/rows` es la rejilla BASTA de reparto de territorios (ver
      // TERRAIN_DOWNSAMPLE en server/mapTemplates.js) — BLOCK_PX es el factor
      // que la reescala hasta el tamaño del terreno horneado (TERRAIN_IMAGE_
      // COLS/ROWS) para que canvasEl y terrainBgEl queden pixel a pixel
      // alineados bajo el mismo transform, sin importar cuan basta sea esa
      // rejilla esa partida.
      BLOCK_PX = TERRAIN_IMAGE_COLS / layout.cols;

      canvasEl.width = Math.round(layout.cols * BLOCK_PX);
      canvasEl.height = Math.round(layout.rows * BLOCK_PX);
      canvasEl.getContext('2d').imageSmoothingEnabled = true; // ver comentario en paintRaster()

      if (markersEl) {
        markersEl.width = canvasEl.width;
        markersEl.height = canvasEl.height;
      }

      // El terreno horneado es estatico (mismo planeta real en toda partida,
      // ver tools/bakeWorldTerrain.js) — se carga una vez. Se fuerza su
      // tamaño en pixeles a que coincida EXACTO con canvasEl (en vez de fiarse
      // de su tamaño natural) porque `layout.cols/rows` ya no coincide
      // siempre con TERRAIN_IMAGE_COLS/ROWS al pixel (redondeos de
      // TERRAIN_DOWNSAMPLE) — la diferencia es minima (<0.1%) pero forzarla
      // evita cualquier desalineacion acumulada al hacer zoom, ya que ambas
      // capas reciben el MISMO transform de pan/zoom (ver applyTransform()).
      if (terrainBgEl) {
        // Comparación por el PATH servido (no por `.src`, que el navegador
        // normaliza a URL absoluta) — así una partida nueva con OTRO mapa
        // recarga el PNG que toca, y una partida nueva con el MISMO mapa no
        // repite la descarga (esto último ya pasaba antes con `!terrainBgEl.src`).
        const currentPath = terrainBgEl.getAttribute('src');
        if (currentPath !== terrainFile) terrainBgEl.setAttribute('src', terrainFile);
        terrainBgEl.width = canvasEl.width;
        terrainBgEl.height = canvasEl.height;
      }

      cellRenderKind = computeCellRenderKind(layout);
      lastRasterFingerprint = null; // fuerza el repintado del raster la primera vez con este layout

      if (objectLayer) {
        objectLayer.onLayout(layout);
        // La decoracion (castillos, arboles, barcos...) se reparte por partida
        // en el servidor y viaja dentro de `map:layout` — ver placeDecorations()
        // en server/mapTemplates.js. Sus coordenadas vienen en celdas de la
        // rejilla, igual que los centroides, asi que se pasan con el mismo
        // BLOCK_PX que el resto del mapa.
        objectLayer.setDecorations(newLayout.decorations, BLOCK_PX);
      }

      hasFitOnce = false;
      if (lastTiles) paint(lastTiles, lastFactions, lastPlayers);
    }

    /**
     * Desempaqueta `cellTileIdsPacked` (ver server/mapLayoutCodec.js — MISMO
     * formato aquí, cualquier cambio en uno hay que reflejarlo en el otro) de
     * vuelta a un array indexado por celda con el id de tile, o -1 (`OCEAN`)
     * si es océano. El resto de este módulo trabaja con esa forma tal cual,
     * sin enterarse de que por la red viajó empaquetado.
     */
    function decodeCellTileIds({ bytesPerCell, base64 }, cellCount) {
      const binary = atob(base64); // "binary string": 1 char = 1 byte (0-255)
      const cellTileIds = new Int32Array(cellCount);
      if (bytesPerCell === 1) {
        for (let i = 0; i < cellCount; i++) {
          cellTileIds[i] = binary.charCodeAt(i) - 1; // 0 -> OCEAN(-1), N -> tile N-1
        }
      } else {
        for (let i = 0; i < cellCount; i++) {
          const hi = binary.charCodeAt(i * 2);
          const lo = binary.charCodeAt(i * 2 + 1);
          cellTileIds[i] = ((hi << 8) | lo) - 1;
        }
      }
      return cellTileIds;
    }

    /**
     * Clasifica cada celda del raster UNA sola vez por `mapLayout` (oceano
     * liso, linea de costa, frontera entre territorios, o interior de
     * tierra) — esto NO depende de que facción posea cada casilla, solo de
     * la geometria fija del mapa, así que no hace falta recalcularlo en cada
     * repintado. Antes esto se recalculaba comparando los 4 vecinos de cada
     * una de las ~10M celdas del raster en CADA `paintRaster()`, lo bastante
     * caro (~100-150ms medido) como para notarse al pulsar "Iniciar
     * partida", cuando llegan varios `state:*` seguidos (cambio de fase +
     * el bot de Twitch conectando/reconectando). Ver docs/ACCIONES.md.
     */
    function computeCellRenderKind({ cols, rows, cellTileIds }) {
      const kind = new Uint8Array(cols * rows);
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const idx = ry * cols + rx;
          const tileId = cellTileIds[idx];
          if (tileId === OCEAN) {
            const touchesLand =
              (rx + 1 < cols && cellTileIds[idx + 1] !== OCEAN) ||
              (ry + 1 < rows && cellTileIds[idx + cols] !== OCEAN) ||
              (rx > 0 && cellTileIds[idx - 1] !== OCEAN) ||
              (ry > 0 && cellTileIds[idx - cols] !== OCEAN);
            kind[idx] = touchesLand ? KIND_COAST : KIND_OCEAN;
          } else {
            const touchesOcean =
              (rx + 1 < cols && cellTileIds[idx + 1] === OCEAN) ||
              (ry + 1 < rows && cellTileIds[idx + cols] === OCEAN) ||
              (rx > 0 && cellTileIds[idx - 1] === OCEAN) ||
              (ry > 0 && cellTileIds[idx - cols] === OCEAN);
            const touchesOtherTile =
              (rx + 1 < cols && cellTileIds[idx + 1] !== tileId && cellTileIds[idx + 1] !== OCEAN) ||
              (ry + 1 < rows && cellTileIds[idx + cols] !== tileId && cellTileIds[idx + cols] !== OCEAN) ||
              (rx > 0 && cellTileIds[idx - 1] !== tileId && cellTileIds[idx - 1] !== OCEAN) ||
              (ry > 0 && cellTileIds[idx - cols] !== tileId && cellTileIds[idx - cols] !== OCEAN);
            kind[idx] = touchesOtherTile ? KIND_BORDER : touchesOcean ? KIND_COAST : KIND_LAND;
          }
        }
      }
      return kind;
    }

    /** tiles: state.tiles (id, neutral, ownerFactionNumber). factions: state.factions (number, color). players: state.players. structures: state.structures (ver paintStructureMarkers()). */
    function setTiles(tiles, factions, players, structures, wonders, bosses) {
      lastTiles = tiles;
      lastFactions = factions;
      lastPlayers = players || [];
      lastStructures = structures || [];
      lastWonders = wonders || [];
      lastBosses = bosses || [];
      if (!layout) return; // aun no ha llegado `map:layout` — se pintara en cuanto llegue, ver setLayout()
      paint(tiles, factions, lastPlayers, lastStructures, lastWonders, lastBosses);
    }

    function paint(tiles, factions, players, structures, wonders, bosses) {
      const colorByTileId = new Array(tiles.length);
      const fingerprintParts = new Array(tiles.length);
      tiles.forEach((t) => {
        let color;
        if (t.neutral) {
          color = NEUTRAL_COLOR;
        } else {
          const faction = factions.find((f) => f.number === t.ownerFactionNumber);
          color = faction ? faction.color : NEUTRAL_COLOR;
        }
        colorByTileId[t.id] = color;
        fingerprintParts[t.id] = color;
      });

      // El raster (tierra/oceano/fronteras) solo depende de que color tiene
      // cada casilla — si eso no cambio desde el ultimo pintado (por ejemplo,
      // este repintado lo disparo solo un cambio de estado del bot de Twitch,
      // no una accion de partida), nos ahorramos recorrer las ~10M celdas
      // otra vez. Los marcadores de jugador SI se repintan siempre: son
      // baratos (proporcional a jugadores, no a celdas de raster) y tienen
      // que reflejar altas/bajas al instante.
      const fingerprint = fingerprintParts.join('|');
      if (fingerprint !== lastRasterFingerprint) {
        paintRaster(colorByTileId);
        lastRasterFingerprint = fingerprint;
      }

      paintOverlay(tiles, factions, players, structures, wonders, bosses);

      // `hasFitOnce` solo se marca a true si reset() de verdad pudo encajar
      // el mapa (viewport con medidas reales). En el panel de admin el mapa
      // se pinta por primera vez mientras #liveControls todavia esta oculto
      // (display:none, viewport a 0x0) — si marcaramos hasFitOnce aqui de
      // todos modos, coverScale() saldria 0 y el mapa se quedaria invisible
      // para siempre (nadie volveria a llamar a reset()). Dejandolo en false
      // se reintenta solo en el proximo pintado (cuando el panel ya es visible).
      if (!hasFitOnce) hasFitOnce = reset();
    }

    function paintRaster(colorByTileId) {
      const { cols, rows, cellTileIds } = layout;
      const ctx = offscreen.getContext('2d');
      const image = ctx.createImageData(cols, rows);
      const rgbByColor = new Map(); // cache hex->[r,g,b] para no re-parsear en cada pixel

      for (let idx = 0; idx < cellTileIds.length; idx++) {
        let hex;
        const kind = cellRenderKind[idx];
        if (kind === KIND_OCEAN) hex = OCEAN_COLOR;
        else if (kind === KIND_COAST) hex = COAST_COLOR;
        else if (kind === KIND_BORDER) hex = BORDER_COLOR;
        else {
          // colorByTileId[tileId] puede faltar por un instante justo al
          // recrear partida (un `state:*` con las tiles nuevas puede llegar
          // un mensaje antes que su `map:layout`, ver docs/ACCIONES.md
          // seccion 5) — se pinta neutral ese frame en vez de romper.
          hex = colorByTileId[cellTileIds[idx]] || NEUTRAL_COLOR;
        }
        const rgb = rgbFor(hex, rgbByColor);
        const p = idx * 4;
        image.data[p] = rgb[0];
        image.data[p + 1] = rgb[1];
        image.data[p + 2] = rgb[2];
        // Transparente en distinto grado segun el tipo de celda para dejar
        // ver el terreno horneado por debajo (terrainBgEl) — ver ALPHA_BY_KIND.
        // Sin terrainBgEl cargado (src vacio) esto igualmente pinta bien: el
        // fondo de #mapViewport es solido oscuro, solo se veria un pelin mas
        // apagado que antes hasta que la imagen cargue.
        image.data[p + 3] = ALPHA_BY_KIND[kind] != null ? ALPHA_BY_KIND[kind] : 255;
      }
      ctx.putImageData(image, 0, 0);

      const mainCtx = canvasEl.getContext('2d');
      // Suavizado ENCENDIDO al reescalar: `offscreen` es la rejilla basta de
      // reparto de territorios (ver TERRAIN_DOWNSAMPLE en
      // server/mapTemplates.js) y aqui se agranda varias veces (BLOCK_PX) para
      // llegar al tamaño de pantalla — sin suavizado se verian bloques
      // cuadrados grandes en vez de fronteras limpias. Antes iba apagado
      // porque `offscreen` ya venia al tamaño final (BLOCK_PX=1, sin
      // reescalado real de por medio).
      mainCtx.imageSmoothingEnabled = true;
      mainCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      mainCtx.drawImage(offscreen, 0, 0, cols, rows, 0, 0, canvasEl.width, canvasEl.height);
    }

    /**
     * Capa barata (etiquetas de casilla + marcadores de jugador), repintada
     * en cada `state:*`. Sin `markersEl` no se dibuja nada aqui (en vez de
     * reusar `canvasEl`, que corromperia el raster si `paintRaster()` se
     * salto este repintado por el fingerprint sin cambios) — las dos paginas
     * del proyecto pasan siempre `markersEl`.
     */
    function paintOverlay(tiles, factions, players, structures, wonders, bosses) {
      // Los marcadores de jugador YA NO se pintan en `markersEl`: se movieron
      // a la capa de objetos (canvas del tamaño del VIEWPORT) porque ahora se
      // animan a 60fps, y `markersEl` es del tamaño del mundo entero —
      // limpiarlo y repintarlo en cada frame seria carisimo. Aqui solo se le
      // pasa a esa capa el estado nuevo para que recalcule a donde va cada uno.
      if (objectLayer) objectLayer.setWalkerWorld({ tiles, factions, players, layout, blockPx: BLOCK_PX, structures, bosses });

      if (!markersEl) return;
      const ctx = markersEl.getContext('2d');
      ctx.clearRect(0, 0, markersEl.width, markersEl.height);
      if (showLabels) paintTileLabels(ctx, tiles);
      // Mapa tileId -> posiciones ya ocupadas en ESA casilla, compartido entre
      // industria y los 3 edificios de tropa (se pintan en este orden, uno
      // "reserva" hueco para el siguiente) para que no se dibujen unos encima
      // de otros aunque cada tipo tenga su propia semilla de dispersion.
      const markerOccupied = new Map();
      paintIndustryMarkers(ctx, tiles, markerOccupied);
      paintBuildingMarkers(ctx, tiles, 'leviesCount', barracaSpriteImg, MARKER_SALT_LEVAS, markerOccupied);
      paintBuildingMarkers(ctx, tiles, 'archeryCount', campoArqueriaSpriteImg, MARKER_SALT_ARQUEROS, markerOccupied);
      paintBuildingMarkers(ctx, tiles, 'cavalryCount', caballerizaSpriteImg, MARKER_SALT_CABALLEROS, markerOccupied);
      paintBuildingMarkers(ctx, tiles, 'towerBuildingCount', torreObrasSpriteImg, MARKER_SALT_TORRE_OBRAS, markerOccupied);
      paintBuildingMarkers(ctx, tiles, 'towerCount', torreSpriteImg, MARKER_SALT_TORRE, markerOccupied);
      paintStructureMarkers(ctx, structures);
      paintWonderMarkers(ctx, wonders, factions);
      paintCombatBadges(ctx, tiles, factions);
    }

    // Semillas de hash01 para que cada tipo de marcador tenga su propia
    // secuencia de dispersion (si no, industria y barraca elegirian el mismo
    // angulo/radio para su primer marcador y se solaparian siempre).
    const MARKER_SALT_INDUSTRY = 0;
    const MARKER_SALT_LEVAS = 1;
    const MARKER_SALT_ARQUEROS = 2;
    const MARKER_SALT_CABALLEROS = 3;
    const MARKER_SALT_TORRE_OBRAS = 4;
    const MARKER_SALT_TORRE = 5;

    // Radio base (pixeles de mundo) del area donde se dispersan los
    // marcadores de una misma casilla, en vez de la cuadricula rigida
    // anterior ("se generan todas casi juntas o en el centro del
    // territorio"). Crece con la raiz de cuantos marcadores ya hay en la
    // casilla para que muchos edificios no se amontonen en el mismo circulo.
    const MARKER_SCATTER_BASE_RADIUS = 55;
    const MARKER_SCATTER_GROWTH = 18;
    const MARKER_MIN_GAP = 34; // separacion minima entre dos marcadores cualesquiera de la misma casilla
    const MARKER_SCATTER_MAX_TRIES = 12;

    function getOccupiedList(markerOccupied, tileId) {
      let list = markerOccupied.get(tileId);
      if (!list) {
        list = [];
        markerOccupied.set(tileId, list);
      }
      return list;
    }

    /**
     * Posicion dispersa determinista (offset en pixeles de mundo respecto al
     * centroide de la casilla) para el marcador `index` del tipo `salt` de la
     * casilla `tileId`. Angulo y radio salen de hash01() (misma tecnica que
     * server/mapTemplates.js placeDecorations, radio con sqrt(random) para
     * cubrir el area de forma uniforme) en vez de Math.random(), para que la
     * posicion no cambie de un repintado a otro. Reintenta hasta
     * MARKER_SCATTER_MAX_TRIES veces si el candidato pisa algo ya colocado en
     * `occupied`; si no encuentra hueco libre se queda con el ultimo intento
     * (mismo criterio de "mejor esfuerzo" que el anti-solape del servidor).
     */
    function scatterPosition(tileId, salt, index, occupied) {
      const radius = MARKER_SCATTER_BASE_RADIUS + Math.sqrt(occupied.length) * MARKER_SCATTER_GROWTH;
      const base = tileId * 977 + index * 31;
      let best = null;
      for (let attempt = 0; attempt < MARKER_SCATTER_MAX_TRIES; attempt++) {
        const ang = hash01(base, salt, attempt * 2 + 1) * Math.PI * 2;
        const r = Math.sqrt(hash01(base, salt, attempt * 2 + 2)) * radius;
        const x = Math.cos(ang) * r;
        const y = Math.sin(ang) * r;
        best = { x, y };
        const clear = !occupied.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < MARKER_MIN_GAP * MARKER_MIN_GAP);
        if (clear) break;
      }
      occupied.push(best);
      return best;
    }

    /**
     * Un sprite de industria por edificio en pie sobre cada casilla
     * (`tile.industryCount`, ver server/rules/industry.js) — PNG sustituible,
     * ver `industrySpriteImg` arriba. Se dibujan en cuadricula alrededor del
     * centroide de SU casilla (no del centro de la faccion) porque la
     * industria pertenece a la casilla: si la casilla se conquista, el
     * sprite se queda donde esta y pasa a contar para el nuevo dueño, que es
     * justo lo que hace el motor.
     *
     * `markersEl` SI recibe el mismo transform CSS que `canvasEl` (a
     * diferencia de la capa de objetos, ver cabecera del archivo), asi que
     * basta con dibujar en pixeles de MUNDO tal cual — el propio navegador
     * escala con el zoom, igual que hace con el resto del raster.
     */
    function paintIndustryMarkers(ctx, tiles, markerOccupied) {
      if (!industrySpriteImg.complete || !industrySpriteImg.naturalWidth) return;
      const drawW = INDUSTRY_SPRITE_WORLD_WIDTH;
      const drawH = drawW * (industrySpriteImg.naturalHeight / industrySpriteImg.naturalWidth);
      tiles.forEach((t) => {
        const count = t.industryCount || 0;
        if (count <= 0) return;
        const c = layout.centroids[t.id];
        if (!c) return;
        const occupied = getOccupiedList(markerOccupied, t.id);
        for (let i = 0; i < count; i++) {
          const p = scatterPosition(t.id, MARKER_SALT_INDUSTRY, i, occupied);
          const cx = c.x * BLOCK_PX + p.x;
          const cy = c.y * BLOCK_PX + p.y;
          // Anclado por la base (abajo-centro), igual que las decoraciones.
          ctx.drawImage(industrySpriteImg, cx - drawW / 2, cy - drawH, drawW, drawH);
        }
      });
    }

    /**
     * Generico para los 3 edificios de tropa (barraca/campo-arqueria/
     * caballeriza) — igual que paintIndustryMarkers pero con su propia
     * semilla `salt` de dispersion (ver scatterPosition) para que cada tipo
     * caiga en un sitio distinto de la casilla en vez de agruparse.
     */
    function paintBuildingMarkers(ctx, tiles, tileField, spriteImg, salt, markerOccupied) {
      if (!spriteImg.complete || !spriteImg.naturalWidth) return;
      const drawW = TROOP_BUILDING_SPRITE_WORLD_WIDTH;
      const drawH = drawW * (spriteImg.naturalHeight / spriteImg.naturalWidth);
      tiles.forEach((t) => {
        const count = t[tileField] || 0;
        if (count <= 0) return;
        const c = layout.centroids[t.id];
        if (!c) return;
        const occupied = getOccupiedList(markerOccupied, t.id);
        for (let i = 0; i < count; i++) {
          const p = scatterPosition(t.id, salt, i, occupied);
          const cx = c.x * BLOCK_PX + p.x;
          const cy = c.y * BLOCK_PX + p.y;
          ctx.drawImage(spriteImg, cx - drawW / 2, cy - drawH, drawW, drawH);
        }
      });
    }

    /**
     * Marcador sobre cada castillo/aldea/puerto que TODAVÍA tiene guarnición
     * neutral (los ya conquistados no vienen en `structures`, ver
     * getPublicState()) — icono del tipo, cuántas tropas de cada clase tiene
     * (guardia por unidad, hasta un máximo visual) y su ataque/defensa ya
     * calculados por el servidor, para saber de un vistazo si merece la pena
     * intentar `!conquista`.
     */
    function paintStructureMarkers(ctx, structures) {
      if (!structures || !structures.length || !layout) return;
      // Las ya conquistadas viajan en `structures` (ver getPublicState()) solo
      // para que la capa de aldeanos sepa DONDE dibujarlos (ver
      // drawSiteWalkers) — aqui, en la chapa de guarnicion/ataque/defensa, no
      // hay nada que enseñar de ellas (guarnicion a 0), asi que se omiten.
      structures.filter((s) => !s.conquered).forEach((s) => {
        // Posicion EXACTA del edificio (no el centroide de toda la
        // casilla, que apilaría varias estructuras de la misma casilla en
        // el mismo punto — ver docs/ACCIONES.md sección 26).
        if (s.x == null || s.y == null) return;
        const cx = s.x * BLOCK_PX;
        const cy = s.y * BLOCK_PX - STRUCTURE_MARKER_OFFSET_Y;

        const label = s.type === 'dungeon'
          ? `${STRUCTURE_TYPE_ICON[s.type] || ''} Or${s.orcCount} Gb${s.goblinCount}  ⚔${s.attackPower} 🛡${s.defensePower}`
          : `${STRUCTURE_TYPE_ICON[s.type] || ''} Lv${s.aiTroops} Ar${s.archerTroops} Cb${s.cavalryTroops}  ⚔${s.attackPower} 🛡${s.defensePower}`;
        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const paddingX = 8;
        const textW = ctx.measureText(label).width;
        const boxW = textW + paddingX * 2 + STRUCTURE_MARKER_ICON_W;
        const boxH = 22;

        ctx.fillStyle = 'rgba(30, 14, 12, .82)';
        ctx.strokeStyle = 'rgba(140, 60, 52, .9)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, cx - boxW / 2, cy - boxH / 2, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        const markerIcon = s.type === 'dungeon' ? orcoSpriteImg : guardiaSpriteImg;
        if (markerIcon.complete && markerIcon.naturalWidth) {
          const iw = STRUCTURE_MARKER_ICON_W;
          const ih = iw * (markerIcon.naturalHeight / markerIcon.naturalWidth);
          ctx.drawImage(markerIcon, cx - boxW / 2 + 4, cy - ih / 2, iw, ih);
        }

        ctx.fillStyle = '#f5e9df';
        ctx.fillText(label, cx + STRUCTURE_MARKER_ICON_W / 2 + 2, cy + 1);
      });
    }

    /**
     * Maravillas (ver docs/ACCIONES.md sección 30, rules/wonders.js): el
     * placeholder de cada una se pinta SIEMPRE (no hay "sin conquistar" que
     * ocultar, a diferencia de castillo/aldea/puerto/dungeon), con su nombre
     * y el bono que da encima, tal y como se pidió ("aparecerán con el
     * nombre arriba de su placeholder y el bonus que dan"). Si alguna
     * facción posee su casilla ahora mismo, el borde de la chapa se tiñe de
     * su color para que se note de un vistazo quién se la está llevando.
     */
    function paintWonderMarkers(ctx, wonders, factions) {
      if (!wonders || !wonders.length || !layout) return;
      wonders.forEach((w) => {
        if (w.x == null || w.y == null) return;
        const cx = w.x * BLOCK_PX;
        const baseY = w.y * BLOCK_PX; // el sprite se ancla por su base aqui, igual que el resto de decoracion

        const sprite = WONDER_SPRITES[w.key];
        if (sprite && sprite.complete && sprite.naturalWidth) {
          const sw = WONDER_SPRITE_WORLD_W;
          const sh = sw * (sprite.naturalHeight / sprite.naturalWidth);
          ctx.drawImage(sprite, cx - sw / 2, baseY - sh, sw, sh);
        }

        const bonusIcon = w.bonusType === 'industry' ? '⚒️' : '🛡️';
        const label = `${w.icon || ''} ${w.name}  +${w.bonusAmount} ${bonusIcon}`;
        const owner = w.ownerFactionNumber != null ? (factions || []).find((f) => f.number === w.ownerFactionNumber) : null;

        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const paddingX = 10;
        const textW = ctx.measureText(label).width;
        const boxW = textW + paddingX * 2;
        const boxH = 22;
        const labelY = baseY - WONDER_MARKER_OFFSET_Y; // por encima del sprite entero (~40-44 de alto) + hueco

        ctx.fillStyle = 'rgba(30, 14, 12, .82)';
        ctx.strokeStyle = owner ? owner.color : 'rgba(140, 60, 52, .9)';
        ctx.lineWidth = owner ? 2.5 : 1.5;
        roundRect(ctx, cx - boxW / 2, labelY - boxH / 2, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f5e9df';
        ctx.fillText(label, cx, labelY + 1);
      });
    }

    /** Rectángulo con esquinas redondeadas — sin `ctx.roundRect()` nativo por compatibilidad, usado por paintStructureMarkers()/paintWonderMarkers(). */
    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /**
     * Escudo verde con el numero de defensores y espada roja con el numero de
     * atacantes que tiene encima cada faccion, EN VIVO durante la fase de
     * accion (el servidor los recalcula en cada comando de chat, ver
     * countLiveActions() en server/gameEngine.js). Se dibujan sobre el
     * territorio ancla de la faccion, encima de sus marcadores de jugador, y
     * desaparecen solos al salir de la fase de accion porque el servidor manda
     * los contadores a 0.
     */
    function paintCombatBadges(ctx, tiles, factions) {
      (factions || []).forEach((f) => {
        const defenders = f.defendersThisRound || 0;
        const attackers = f.incomingAttackersThisRound || 0;
        if (defenders <= 0 && attackers <= 0) return;

        const centroid = computeFactionCentroid(tiles, f.number);
        if (!centroid) return;

        // Los dos van en fila sobre el centro de la faccion, por encima de la
        // nube de marcadores de jugador (de ahi el desplazamiento hacia
        // arriba) — si solo hay uno de los dos, queda centrado el solo.
        const both = defenders > 0 && attackers > 0;
        const baseX = centroid.x * BLOCK_PX;
        const baseY = centroid.y * BLOCK_PX - screenPx(BADGE_OFFSET_Y);
        const gap = screenPx(BADGE_W) * 0.72;

        if (defenders > 0) drawBadge(ctx, both ? baseX - gap : baseX, baseY, '🛡', defenders, BADGE_DEFEND_BG);
        if (attackers > 0) drawBadge(ctx, both ? baseX + gap : baseX, baseY, '⚔', attackers, BADGE_ATTACK_BG);
      });
    }

    /** Chapita redondeada con un icono y un numero — usada por paintCombatBadges. */
    function drawBadge(ctx, cx, cy, icon, count, bg) {
      const w = screenPx(BADGE_W), h = screenPx(BADGE_H), r = screenPx(3);
      const x = cx - w / 2, y = cy - h / 2;

      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = screenPx(1);
      ctx.strokeStyle = 'rgba(4,20,28,.85)';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.font = `${h * 0.62}px system-ui, sans-serif`;
      ctx.fillText(`${icon}${count}`, cx, cy);
    }

    function paintTileLabels(ctx, tiles) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      tiles.forEach((t) => {
        const c = layout.centroids[t.id];
        if (!c) return;
        ctx.fillText(String(t.id), c.x * BLOCK_PX, c.y * BLOCK_PX);
      });
    }

    /**
     * Posicion (en coordenadas de raster) del "territorio ancla" de una
     * facción: el centroide de UNA sola de sus casillas (la de id mas bajo,
     * para que sea determinista), no la media de todas. Promediar los
     * centroides de todas las casillas se probó y se descartó: cuando una
     * facción tiene territorios no contiguos (habitual con el reparto estilo
     * Voronoi — p.ej. una pieza en Sudamérica y otra en África), la media
     * cae en pleno océano, entre los dos, y los marcadores de sus jugadores
     * aparecían flotando en agua en vez de sobre tierra. Con un ancla fija
     * en una sola casilla real, los marcadores siempre caen dentro de
     * territorio propio. Se mueve solo si esa casilla concreta cambia de
     * dueño (conquista) — única fuente de "donde esta" una facción en el
     * mapa: la usan las chapitas de combate (escudo/espada) y el reparto
     * inicial de los caminantes (`spawnPosition()` en la capa de objetos).
     */
    function computeFactionCentroid(tiles, factionNumber) {
      const owned = tiles.filter((t) => !t.neutral && t.ownerFactionNumber === factionNumber);
      if (owned.length === 0) return null;
      const anchorTile = owned.reduce((a, b) => (a.id <= b.id ? a : b));
      return layout.centroids[anchorTile.id] || null;
    }

    /**
     * Busca un jugador por nombre (exacto o parcial, sin mayusculas/minusculas)
     * entre los vivos con marcador en el mapa, y centra la vista ahí con un
     * zoom cómodo — usado por la caja de búsqueda del panel de jugadores.
     * Devuelve `true` si encontró y centró, `false` si no hay ningún jugador
     * vivo con ese nombre (con marcador dibujado).
     */
    function focusOnPlayer(username) {
      if (!layout || !username || !objectLayer) return false;
      const needle = username.trim().toLowerCase();
      if (!needle) return false;

      // Las posiciones las lleva ahora la capa de caminantes, que es quien las
      // mueve — se le piden en el momento de buscar (y no se cachean aqui)
      // para saltar a donde esta el jugador AHORA, no a donde estaba en el
      // ultimo cambio de estado.
      const positions = objectLayer.getMarkerPositions();
      let target = null;
      for (const [, m] of positions) {
        if (m.username.toLowerCase() === needle) {
          target = m;
          break;
        }
      }
      if (!target) {
        for (const [, m] of positions) {
          if (m.username.toLowerCase().includes(needle)) {
            target = m;
            break;
          }
        }
      }
      if (!target) return false;

      // Ya vienen en pixeles de mundo, no en celdas de rejilla.
      const cx = target.x;
      const cy = target.y;
      const viewportCx = viewportEl.clientWidth / 2;
      const viewportCy = viewportEl.clientHeight / 2;
      setView(FOCUS_SCALE, viewportCx - cx * FOCUS_SCALE, viewportCy - cy * FOCUS_SCALE);
      return true;
    }

    function rgbFor(hex, cache) {
      if (cache.has(hex)) return cache.get(hex);
      const value = hex.replace('#', '');
      const rgb = [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
      cache.set(hex, rgb);
      return rgb;
    }

    function applyTransform() {
      const transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})`;
      canvasEl.style.transform = transform;
      if (markersEl) markersEl.style.transform = transform;
      if (terrainBgEl) terrainBgEl.style.transform = transform;
      // objectsEl NO recibe este transform a proposito — es un canvas del
      // tamaño del viewport que se redibuja el mismo con la vista actual, ver
      // createObjectLayer()/drawObjectLayer() mas abajo.
      if (objectLayer) objectLayer.onViewChanged(mapView);
      // Los indicadores de la capa de marcadores (escudo/espada e industrias)
      // se dibujan a tamaño de PANTALLA constante, o sea compensando el zoom
      // — al cambiar la escala hay que volver a dibujarlos con el nuevo
      // factor, si no se quedarian con el tamaño del zoom anterior. Ver
      // screenPx() y scheduleOverlayRepaint().
      scheduleOverlayRepaint();
    }

    /**
     * Convierte un tamaño en PIXELES DE PANTALLA al tamaño que hay que dibujar
     * en la capa de marcadores para que se vea asi de grande en pantalla.
     *
     * `markersEl` lleva el mismo `transform: scale()` que el mapa, asi que
     * todo lo que se pinta en el se encoge/agranda con el zoom. Para el mapa
     * (territorios, terreno) eso es lo que queremos; para los indicadores de
     * "de un vistazo" (escudo de defensores, espada de atacantes, cuadros de
     * industria) NO: al alejar el zoom quedaban de 4px y no se leian, que es
     * justo lo contrario de para lo que estan. Dividiendo por la escala actual
     * se quedan del mismo tamaño en pantalla a cualquier zoom, como los pines
     * de un mapa de verdad.
     */
    function screenPx(px) {
      return px / (mapView.scale || 1);
    }

    /**
     * Repinta solo la capa de marcadores (barata: proporcional a jugadores y
     * casillas, no a celdas del raster) como mucho una vez por frame. La capa
     * cara del raster de territorios no se toca aqui.
     */
    function scheduleOverlayRepaint() {
      if (!markersEl || !layout || !lastTiles || overlayRepaintPending) return;
      overlayRepaintPending = true;
      requestAnimationFrame(() => {
        overlayRepaintPending = false;
        if (layout && lastTiles) paintOverlay(lastTiles, lastFactions, lastPlayers, lastStructures, lastWonders, lastBosses);
      });
    }

    /**
     * Escala minima permitida: el mapa (canvasEl, a escala 1) nunca puede ser
     * mas pequeño que el viewport en ningun eje — igual que un mapa de fondo
     * tipo Google Maps, el zoom-out maximo siempre deja la pantalla llena de
     * mapa, nunca hueco vacio alrededor.
     */
    function coverScale() {
      if (!canvasEl.width || !canvasEl.height) return 1;
      return Math.max(viewportEl.clientWidth / canvasEl.width, viewportEl.clientHeight / canvasEl.height);
    }

    /** Recorta x/y para que, a la escala dada, no se pueda arrastrar el mapa dejando hueco vacio en ningun borde. */
    function clampPan(x, y, scale) {
      const scaledW = canvasEl.width * scale;
      const scaledH = canvasEl.height * scale;
      const minX = Math.min(0, viewportEl.clientWidth - scaledW);
      const minY = Math.min(0, viewportEl.clientHeight - scaledH);
      return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) };
    }

    /** Punto unico por el que pasan reset/zoom/drag/focusOnPlayer: aplica los limites de escala y de paneo siempre juntos. */
    function setView(scale, x, y) {
      mapView.scale = Math.min(MAX_SCALE, Math.max(coverScale(), scale));
      const clamped = clampPan(x, y, mapView.scale);
      mapView.x = clamped.x;
      mapView.y = clamped.y;
      applyTransform();
    }

    /** Devuelve true si pudo encajar el mapa de verdad; false si el viewport todavia no tiene medidas (oculto). */
    function reset() {
      if (!canvasEl.width) return false;
      if (!viewportEl.clientWidth || !viewportEl.clientHeight) return false;
      const scale = coverScale();
      const x = (viewportEl.clientWidth - canvasEl.width * scale) / 2;
      const y = (viewportEl.clientHeight - canvasEl.height * scale) / 2;
      setView(scale, x, y);
      return true;
    }

    /**
     * Cambia la escala manteniendo fijo un punto de la pantalla (por defecto
     * el centro del viewport; la rueda del raton pasa la posicion del
     * cursor). Sin esto, setView() conserva mapView.x/y tal cual y todo el
     * mapa crece/encoge desde su esquina superior izquierda, que es lo que
     * se veia como "el mapa se va hacia arriba-izquierda" al hacer zoom.
     *
     * El clamp de escala (MAX_SCALE/coverScale) se aplica AQUI, antes de
     * calcular el paneo — no dentro de setView() como antes. Si no, al pedir
     * mas zoom del que se puede dar (tope de MAX_SCALE) el paneo se seguia
     * calculando para la escala "de mentira" que se pidio, no para la que de
     * verdad se aplicaba, y el mapa se iba desplazando solo cada vez que se
     * insistia en hacer zoom estando ya al maximo.
     */
    function zoom(factor, anchor) {
      const ax = anchor ? anchor.x : viewportEl.clientWidth / 2;
      const ay = anchor ? anchor.y : viewportEl.clientHeight / 2;
      const worldX = (ax - mapView.x) / mapView.scale;
      const worldY = (ay - mapView.y) / mapView.scale;
      const nextScale = Math.min(MAX_SCALE, Math.max(coverScale(), mapView.scale * factor));
      setView(nextScale, ax - worldX * nextScale, ay - worldY * nextScale);
    }

    function setupInteraction() {
      viewportEl.addEventListener('mousedown', (e) => {
        dragging = true;
        viewportEl.classList.add('dragging');
        dragStart = { x: e.clientX, y: e.clientY, viewX: mapView.x, viewY: mapView.y };
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
        viewportEl.classList.remove('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        setView(mapView.scale, dragStart.viewX + (e.clientX - dragStart.x), dragStart.viewY + (e.clientY - dragStart.y));
      });
      viewportEl.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const rect = viewportEl.getBoundingClientRect();
          zoom(e.deltaY < 0 ? 1.1 : 0.9, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        },
        { passive: false }
      );
      // Si cambia el tamaño de la ventana, la escala de cobertura (coverScale)
      // cambia con ella — recalcula limites para que el mapa siga sin dejar
      // hueco vacio ni quedar descentrado tras el resize.
      window.addEventListener('resize', () => {
        if (objectLayer) objectLayer.onResize();
        if (!canvasEl.width) return;
        setView(mapView.scale, mapView.x, mapView.y);
      });
    }

    setupInteraction();
    return {
      setLayout,
      setTiles,
      zoom,
      reset,
      focusOnPlayer,
      /**
       * Posicion actual de cada marcador de jugador, en pixeles de mundo:
       * Map<userId, {x, y, color, username}>. La usa `focusOnPlayer()` por
       * dentro y se expone tambien aqui para que cualquier otra parte de la
       * interfaz (o una prueba) pueda saber donde esta cada uno sin duplicar
       * la logica de movimiento.
       */
      getPlayerPositions: () => (objectLayer ? objectLayer.getMarkerPositions() : new Map()),
      /** Posicion de la vaca-easter-egg y su acompañante (px de mundo), o null. Ver docs/ACCIONES.md sección 15. */
      getCowPosition: () => (objectLayer ? objectLayer.getCowPosition() : null),
    };
  }

  // ===========================================================================
  // Capa de objetos discretos (arboles, rocas, arbustos, ramas/madera de
  // deriva, conchas, palmeras) — ver comentario de cabecera del archivo y
  // `tools/generateWorldObjects.js` (MISMO formato binario y MISMOS numeros
  // de tipo aqui, cualquier cambio hay que reflejarlo en los dos sitios).
  //
  // A diferencia del raster de territorios (pre-renderizado una vez a tamaño
  // completo del mundo y paneado/zoomeado gratis via CSS transform), esta
  // capa hace lo que investigamos que hace streamer-wars.com: los datos de
  // TODOS los objetos del mundo se cargan una unica vez (fetch, no por
  // tile/zoom — el fichero entero pesa unos pocos cientos de KB, ver
  // tools/generateWorldObjects.js), pero el DIBUJADO solo procesa los
  // objetos que caen dentro del viewport actual (+ un margen) cada vez que
  // cambia el pan/zoom. Asi el coste de pintar es proporcional a "cuantos
  // objetos hay en pantalla ahora", no a "cuantos objetos hay en el mundo
  // entero" — es lo que permite hacer mucho zoom sin que el mapa pese mas ni
  // vaya mas lento, y es la misma pieza que mas adelante puede llevar
  // aldeanos/edificios/unidades (mismo mecanismo, solo cambia que se dibuja).
  // ===========================================================================

  const OBJECT_TYPES = {
    TREE_ROUND: 0, TREE_PINE_HILL: 1, TREE_PINE_TUNDRA: 2, TREE_PINE_SNOW: 3,
    ROCK: 4, BUSH: 5, BRANCH_FOREST: 6, BRANCH_DESERT: 7, DRIFTWOOD: 8, SHELL: 9, PALM: 10,
  };

  // Radio (en pixeles de MUNDO) por debajo del cual un tipo de objeto se
  // considera "pequeño" a efectos de LOD — a poco zoom se ocultan los
  // pequeños primero (rocas, conchas, arbustos, ramas) y se dejan los
  // arboles grandes como unica pista de "aqui hay bosque", igual que un mapa
  // de verdad no dibuja piedras sueltas a vista de pais.
  const SMALL_OBJECT_TYPES = new Set([
    OBJECT_TYPES.ROCK, OBJECT_TYPES.BUSH, OBJECT_TYPES.BRANCH_FOREST,
    OBJECT_TYPES.BRANCH_DESERT, OBJECT_TYPES.DRIFTWOOD, OBJECT_TYPES.SHELL,
  ]);

  // Tamaño (en pixeles de MUNDO) de cada "cubo" de la rejilla espacial usada
  // para no recorrer los ~53K objetos del mundo entero en cada frame — solo
  // se miran los cubos que tocan el rectangulo visible actual.
  const OBJ_GRID_CELL = 512;

  // Margen de colchon (pixeles de MUNDO, se divide entre el zoom actual mas
  // abajo) alrededor del viewport visible: los objetos un poco fuera de
  // pantalla ya estan dibujados antes de entrar en ella al arrastrar el
  // mapa, para que no aparezcan "de golpe" (popping) justo en el borde.
  const OBJ_VIEWPORT_MARGIN_PX = 140; // en pixeles de PANTALLA, constante en cualquier zoom

  // Umbrales de escala del mapa para el LOD, CON histeresis: subir de nivel
  // de detalle exige pasar el umbral "up" (mas alto), bajar exige pasar el
  // umbral "down" (mas bajo) — el hueco entre ambos evita parpadeo si el
  // usuario se queda haciendo zoom justo en el borde de un umbral.
  const LOD_NONE_UP = 0.55, LOD_NONE_DOWN = 0.45; // por debajo: no se dibuja ningun objeto
  const LOD_SMALL_UP = 1.15, LOD_SMALL_DOWN = 0.95; // por debajo: solo objetos grandes (arboles/palmeras)

  // ===========================================================================
  // Sprites de decoracion del mapa (castillos, puertos, aldeas, arboles,
  // barcos, ballenas, kraken). El servidor los reparte por partida y los manda
  // en `map:layout` (ver placeDecorations() en server/mapTemplates.js); aqui
  // solo se dibujan.
  //
  // Cada tipo se carga como IMAGEN desde `public/sprites/<tipo>.png`, no como
  // formas dibujadas en codigo: para poner arte definitivo basta sobrescribir
  // el PNG en esa carpeta, sin tocar nada de aqui. Lo unico ajustable es el
  // ancho con el que se dibuja en el mapa (`worldWidth`, en pixeles de mundo);
  // la altura sale sola del aspecto real del PNG, asi que un arte mas alto o
  // mas estrecho encaja sin cambiar este archivo.
  // ===========================================================================
  const DECOR_SPRITES = {
    castle: { worldWidth: 150 },
    port: { worldWidth: 115 },
    village: { worldWidth: 90 },
    tree: { worldWidth: 55 },
    'ship-small': { worldWidth: 95 },
    'ship-big': { worldWidth: 140 },
    whale: { worldWidth: 130 },
    kraken: { worldWidth: 320 },
  };

  // Por debajo de esta escala de mapa no se dibuja decoracion: a vista de
  // planeta entero serian manchas de 2px que solo ensucian. Mismo criterio de
  // LOD que la capa de objetos de terreno.
  const DECOR_MIN_SCALE = 0.14;

  /**
   * Carga (una sola vez para toda la pagina) el PNG de cada tipo de
   * decoracion. Si alguno falta o falla, ese tipo simplemente no se dibuja y
   * el resto del mapa sigue igual — la decoracion nunca puede tumbar el mapa.
   */
  const decorImages = (() => {
    const images = {};
    for (const type of Object.keys(DECOR_SPRITES)) {
      const img = new Image();
      img.src = `/sprites/${type}.png`;
      img.addEventListener('error', () => {
        console.warn(`[mapRenderer] falta public/sprites/${type}.png, no se dibujara ese elemento`);
      });
      images[type] = img;
    }
    return images;
  })();

  /** Carga (una sola vez) un PNG suelto de `public/sprites/` que no forma parte de `DECOR_SPRITES`. */
  function loadSprite(name) {
    const img = new Image();
    img.src = `/sprites/${name}.png`;
    img.addEventListener('error', () => {
      console.warn(`[mapRenderer] falta public/sprites/${name}.png, no se dibujara ese elemento`);
    });
    return img;
  }

  // Marcador de jugador (antes triangulo dibujado a mano, ver drawWalkers):
  // dos sprites, uno por sentido, que se alternan solos segun hacia donde se
  // mueve cada caminante (ver stepWalkers()). El ancho/alto van en pixeles de
  // MUNDO — igual que DECOR_SPRITES — porque esta capa SI escala con el zoom.
  const soldierImages = { right: loadSprite('soldier-right'), left: loadSprite('soldier-left') };
  const WALKER_SPRITE_WORLD_W = 22;
  const WALKER_SPRITE_WORLD_H = 36;

  // Caballero (mejora de industria nivel 1/3, ver docs/ACCIONES.md sección
  // 16): mismo mecanismo de sprite por sentido que el soldado, pero con su
  // propio par de imágenes y "algo más grande, no mucho" como se pidió.
  const knightImages = { right: loadSprite('knight-right'), left: loadSprite('knight-left') };
  const KNIGHT_SPRITE_WORLD_W = 26;
  const KNIGHT_SPRITE_WORLD_H = 42;
  // Se mueve mas rapido que un soldado a pie ("simula un caballo") — se
  // aplica como multiplicador sobre las dos velocidades normales (paseo y
  // marcha) en vez de un numero fijo, para que la diferencia se note en los
  // dos casos por igual.
  const KNIGHT_SPEED_MULTIPLIER = 1.6;

  // Tropas de IA (ver docs/ACCIONES.md sección 18, server/rules/troops.js):
  // cada una es un acompañante que sigue SIEMPRE al jugador que la lleva,
  // mismo mecanismo que el acompañante de la vaca (sección 15) — sigue el
  // RASTRO real del caminante, no su posición actual, para no cortar camino
  // por sitios por los que su "general" no ha pasado. Con más de una tropa,
  // cada una va a un retraso mayor sobre ese mismo rastro (fila india).
  const troopImg = loadSprite('troop');
  // Arquero (!arqueros) y caballero de IA (!caballeros, ver
  // rules/troopBuildings.js) — mismo mecanismo de seguimiento que `troop`
  // (soldado), sprite propio. El de caballero es un pelin mas grande (va a
  // caballo), igual que el caballero de verdad es mas grande que el soldado.
  const archerTroopImg = loadSprite('troop-archer');
  const cavalryTroopImg = loadSprite('troop-cavalry');
  const TROOP_SPRITE_WORLD_W = 12;
  const CAVALRY_TROOP_SPRITE_WORLD_W = 14;
  // Cono de posiciones detras del jugador donde se colocan sus tropas (ver
  // syncFollowerCone()/stepFollowerCone() mas abajo) — reemplaza a la
  // antigua fila india que seguia el rastro exacto del jugador, "poco
  // organica" segun se pidio. Cada tropa tiene su propio angulo dentro del
  // cono y su propia velocidad de "alcance" (TROOP_FOLLOWER_EASE_MIN/MAX),
  // sorteados una vez al aparecer, para que no se muevan todas a la vez.
  const TROOP_FOLLOWER_CONE_HALF_ANGLE = (50 * Math.PI) / 180; // +-50 grados respecto a "justo detras"
  const TROOP_FOLLOWER_BASE_DIST = 20; // px de mundo por detras del jugador
  const TROOP_FOLLOWER_DIST_JITTER = 14; // variacion de esa distancia, para no formar un arco perfecto
  const TROOP_FOLLOWER_EASE_MIN = 2.2; // "que tan rapido alcanza su sitio" (1/s), cada tropa el suyo
  const TROOP_FOLLOWER_EASE_MAX = 4.5;

  // Aldeanos (ver docs/ACCIONES.md): pasean alrededor de un castillo/aldea/
  // puerto ya conquistado y alrededor de la capital de cada faccion — ver
  // syncSiteWalkers()/stepSiteWalkers()/drawSiteWalkers() dentro de
  // createObjectLayer. Mismo tamaño que `guardia` (la guarnicion a la que
  // sustituyen al conquistar).
  const aldeanoSpriteImg = loadSprite('aldeano');
  const ALDEANO_SPRITE_WORLD_W = 13;
  // Guarnición neutral paseando (castillo/aldea/puerto SIN conquistar,
  // sección 23): sprite PROPIO, distinto del de las tropas del propio
  // jugador (antes reutilizaban troop/troop-archer/troop-cavalry, lo que
  // impedía re-skinearlos por separado como "bárbaros" — se pidió
  // expresamente separarlos). Mismos tamaños que su equivalente de tropa.
  const barbaroImg = loadSprite('barbaro');
  const barbaroArcherImg = loadSprite('barbaro-arquero');
  const barbaroCavalryImg = loadSprite('barbaro-caballero');
  // Capital de faccion: placeholder gris que se tiñe del color de la
  // faccion en tiempo real (ver drawTintedSprite), igual que el marcador de
  // jugador.
  const capitalSpriteImg = loadSprite('capital');
  const CAPITAL_SPRITE_WORLD_W = 60;
  // Dungeon (ver docs/ACCIONES.md sección 27, !dungeon): guarnición de
  // orcos (más grandes) y goblins (más pequeños) paseando alrededor,
  // número SIEMPRE fijo (2 orcos + 4 goblins) a diferencia de castillo/
  // aldea/puerto (que escalan con la guarnición real).
  const orcoImg = loadSprite('orco');
  const goblinImg = loadSprite('goblin');
  const ORCO_SPRITE_WORLD_W = 18;
  const GOBLIN_SPRITE_WORLD_W = 11;
  // Trofeo por derrotar un dungeon: una estatua junto a la capital de la
  // facción que lo mató, con sus propios aldeanos alrededor (igual que la
  // capital) — ver desiredSiteSpecs().
  const estatuaImg = loadSprite('estatua');
  const ESTATUA_SPRITE_WORLD_W = 34;
  const ESTATUA_RING_RADIUS = 75; // px de mundo de la capital, fuera de su sprite (60px de ancho)
  const ESTATUA_ANGLE_STEP = (137.5 * Math.PI) / 180; // angulo dorado: buen reparto en anillo sea cual sea el numero de estatuas
  // Trofeo por derrotar un boss (ver docs/ACCIONES.md sección 31, !boss):
  // un museo junto a la capital, "igual que el monumento" (mismo mecanismo
  // que la estatua de arriba) pero en un anillo más ancho para no
  // solaparse si la facción tiene trofeos de los dos tipos a la vez.
  const museoImg = loadSprite('museo');
  const MUSEO_SPRITE_WORLD_W = 40;
  const MUSEO_RING_RADIUS = ESTATUA_RING_RADIUS + 40;
  // Castillo especial del nivel 4 de industria (ver rules/industry.js): UNA
  // sola vez por facción, a un lado fijo de la capital (no en anillo como
  // las estatuas, que pueden ser varias — este es siempre uno solo), con sus
  // propias tropas especiales paseando alrededor y SIN aldeanos.
  const castilloEspecialImg = loadSprite('castillo-especial');
  const tropaEspecialImg = loadSprite('tropa-especial');
  const CASTILLO_ESPECIAL_SPRITE_WORLD_W = 70;
  const CASTILLO_ESPECIAL_OFFSET_X = 95; // px de mundo, a la derecha de la capital
  const TROPA_ESPECIAL_SPRITE_WORLD_W = 14;
  // Bosses (ver docs/ACCIONES.md sección 31, !boss): 3 sprites fijos, uno
  // por tipo — "grandotes", bastante más anchos que la vaca (40) o un
  // troop. Su ataque/defensa (5-10, sorteado por instancia) se pinta encima
  // de la cabeza, ver drawBossWalkers().
  const BOSS_SPRITES = {
    ogro: [loadSprite('ogro'), 62],
    troll: [loadSprite('troll'), 54],
    behemot: [loadSprite('behemot'), 70],
  };
  // Radio de paseo (px de mundo) alrededor de un castillo/aldea/puerto/
  // capital para su guarnicion/aldeanos — mucho mas pequeño que el de un
  // jugador paseando por su territorio: son NPCs "de guardia", no viajan.
  const SITE_WANDER_RADIUS = 46;
  const SITE_WALK_SPEED = 34;
  const SITE_PAUSE_MS = 1100;

  // ===========================================================================
  // Caminantes: el marcador de cada jugador vivo, que se mueve por el mapa.
  //
  // Toda la animacion es LOCAL de cada navegador. El servidor no manda
  // posiciones — mandarlas a 60fps por WebSocket para decenas de jugadores no
  // seria viable — sino solo QUE esta haciendo cada uno (`player.action`, ver
  // getPublicState() en server/gameEngine.js). Con eso, cada cliente decide a
  // donde tiene que ir ese marcador y lo mueve por su cuenta. Que dos
  // espectadores vean al mismo aldeano dos pasos desplazado da igual: es
  // decoracion, no estado de juego.
  //
  // Segun el comando escrito en el chat, el destino cambia:
  //   sin comando / fuera de la fase de accion -> pasea por su territorio
  //   !ataque N   -> se va a la frontera con la faccion N
  //   !defender   -> se va al castillo/aldea mas cercano de su territorio
  //   !expansion  -> se va a la frontera con el territorio neutral
  //   !industria  -> se va a una casilla suya que tenga industria
  // Al resolverse la ronda, el servidor deja de mandar accion y los
  // supervivientes vuelven solos a pasear.
  // ===========================================================================

  // Dos velocidades, en pixeles de MUNDO por segundo. Pasear es un paseo; ir
  // a cumplir una orden es una marcha, y bastante mas rapida: el territorio de
  // una faccion puede medir varios miles de pixeles de mundo, y a paso de
  // paseo no daba tiempo a llegar a la frontera dentro de la fase de accion
  // (medido: ~1.100px hasta un castillo, que a 70px/s son 16 segundos). Que
  // ademas se note el cambio de ritmo al dar una orden es justo lo que hace
  // legible de un vistazo quien esta yendo a algun sitio y quien no.
  const WALK_SPEED_WANDER = 55;
  const WALK_SPEED_MARCH = 300;
  const WALK_ARRIVE_DIST = 6;     // a que distancia se considera que ya llego
  const WANDER_RADIUS = 130;      // como de lejos puede irse el siguiente paseo
  const WANDER_PAUSE_MS = 900;    // descanso al llegar antes de elegir otro sitio
  const HOP_HEIGHT = 9;           // altura del brinquito, en pixeles de mundo
  const HOP_SPEED = 7.5;          // brincos por segundo
  // Umbral de movimiento horizontal (px de mundo por frame) para decidir si
  // el caminante mira a izquierda o derecha (ver stepWalkers()). Un umbral
  // pequeño pero no cero evita que el sprite "tiemble" cambiando de sentido
  // cuando el movimiento es casi vertical.
  const WALKER_DIR_THRESHOLD = 0.05;
  // El NOMBRE, en cambio, va a tamaño de pantalla fijo: escalarlo con el mundo
  // lo hace ilegible de lejos y gigante de cerca.
  const WALKER_NAME_PX = 11;
  // Por debajo de esta escala no se escriben los nombres: a vista de planeta
  // se solapan todos y dibujar texto es, de largo, lo mas caro de esta capa.
  const WALKER_NAME_MIN_SCALE = 0.5;
  // Circulito del color de la faccion a la izquierda del nombre (sustituye
  // al tinte semitransparente que antes llevaba el propio sprite del
  // jugador, ver drawWalkers()) — tamaño en pixeles de PANTALLA, igual que
  // el nombre, para que se lea igual de lejos que de cerca.
  const WALKER_DOT_DIAMETER = 9;
  const WALKER_DOT_GAP = 4;
  // Icono junto al nombre segun la orden que tenga puesta esa ronda (ver
  // walker.action, que ya se usaba para decidir a donde caminar — aqui solo
  // se reutiliza para pintarlo). Sin entrada = sin icono (paseando, sin
  // orden). Se pidio expresamente que expansion NO fuera un arco: al ser
  // "ganar terreno" se usa una banderita, no un icono de ataque a distancia.
  const ACTION_ICONS = {
    ATTACK: ' ⚔️', DEFEND: ' 🛡️', INDUSTRY: ' ⚒️', EXPAND: ' 🚩',
    LEVAS: ' 🏕️', ARQUEROS: ' 🏹', CABALLEROS: ' 🐎', CONQUISTA: ' 🗡️', DUNGEON: ' 💀', TORRE: ' 🗼', BOSS: ' 👹',
  };

  /** Hash determinista 2D -> [0,1) — variacion "de sabor" (angulo de rama, tono de roca...) sin gastar bytes extra por objeto en el fichero, ver cabecera de tools/generateWorldObjects.js. */
  function hash01(x, y, salt) {
    let h = (x * 374761393 + y * 668265263 + salt * 2654435761) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 100000) / 100000;
  }

  function createObjectLayer(objectsEl, viewportEl) {
    let objs = null; // { count, type: Uint8Array, x: Uint16Array, y: Uint16Array, r: Uint8Array }
    let grid = null; // Map<bucketKey, number[]> (indices en objs)
    let gridCols = 0, gridRows = 0;
    let currentView = { x: 0, y: 0, scale: 1 };
    let lodTier = 'full'; // 'none' | 'small' | 'full' — con histeresis, ver umbrales arriba
    let rafPending = false;
    let ready = false;
    // Decoracion de la partida (castillos, puertos, aldeas, arboles, barcos,
    // ballenas, kraken) — llega del servidor dentro de `map:layout`, ver
    // setDecorations(). Va aparte de `objs` porque su origen y su forma son
    // distintos (sprites PNG con posicion en celdas de rejilla, no formas
    // dibujadas a mano con radio en pixeles de mundo).
    let decorations = [];
    let decorBlockPx = 1;
    // Caminantes: un marcador animado por jugador vivo. Ver la seccion
    // "Caminantes" de mas arriba para el porque de animarlos aqui y no en el
    // servidor. `walkerWorld` es la ultima foto del estado (casillas, quien
    // manda en cada una, que ha escrito cada jugador) sobre la que se deciden
    // los destinos.
    const walkers = new Map(); // userId -> { x, y, tx, ty, color, username, ... }
    let walkerWorld = null;
    let walkerLoopRunning = false;
    let lastFrameAt = 0;

    // Guarnicion de castillo/aldea/puerto (mientras no esten conquistados) y
    // aldeanos (ya conquistados, o alrededor de la capital de cada faccion)
    // — ver syncSiteWalkers()/stepSiteWalkers()/drawSiteWalkers() mas abajo.
    // siteKey -> { home: {x,y}, factionColor, list: [{spriteKey,x,y,tx,ty,dir,pauseUntil,hopSeed}] }
    const siteWalkers = new Map();

    // Easter egg: una unica vaca vagando por tierra, con un acompañante que
    // la sigue a corta distancia — ver stepCow()/drawCow() y
    // docs/ACCIONES.md seccion 15. Se siembra sola en cuanto hay mapa (no
    // depende de que haya partida ni jugadores).
    let cow = null;

    // Bosses (ver docs/ACCIONES.md sección 31, !boss, rules/bosses.js):
    // igual idea que la vaca (un placeholder grande vagando solo), pero
    // LEASHED a la casilla en la que salió ("se van moviendo solo por el
    // terreno en el que spawnearon", tal y como se pidió) en vez de recorrer
    // el mapa entero — ver syncBossWalkers()/stepBossWalkers()/
    // drawBossWalkers() mas abajo. key -> { x,y,tx,ty,tileId,bossKey,
    // attackPower,defensePower,dir,pauseUntil,hopSeed }
    const bossWalkers = new Map();

    // Nubes del cielo (decorativo, ver stepClouds()/drawClouds()): pocas a
    // la vez, en pantalla (no en coordenadas de mundo), cruzando solo la
    // franja del mapa.
    const clouds = [];
    let nextCloudSpawnAt = 0;

    const ctx = objectsEl.getContext('2d');

    fetch('/terrain/objects.bin')
      .then((r) => {
        // Sin comprobar el status, un 404 acababa intentando parsear la
        // pagina de error como si fuera el binario, y el fallo salia por
        // consola como un "Array buffer allocation failed" que no dice nada
        // de lo que pasa de verdad (que el asset no esta generado).
        if (!r.ok) throw new Error(`no encontrado (HTTP ${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        objs = parseObjectBuffer(buf);
        buildGrid();
        ready = true;
        scheduleRedraw();
      })
      .catch((err) => {
        // El terreno/objetos son decoracion — si el fetch falla (asset no
        // desplegado todavia, red rara en un panel de admin local, etc.) el
        // resto del mapa (territorios, marcadores) tiene que seguir
        // funcionando igual, solo sin arboles/rocas encima.
        console.warn('[mapRenderer] no se pudo cargar objects.bin, se sigue sin capa de objetos:', err);
      });

    function parseObjectBuffer(buf) {
      const dv = new DataView(buf);
      const count = dv.getUint32(1, true); // little-endian, ver tools/generateWorldObjects.js
      const type = new Uint8Array(count);
      const x = new Uint16Array(count);
      const y = new Uint16Array(count);
      const r = new Uint8Array(count);
      let off = 5;
      for (let i = 0; i < count; i++) {
        type[i] = dv.getUint8(off);
        x[i] = dv.getUint16(off + 1, false); // big-endian, ver tools/generateWorldObjects.js
        y[i] = dv.getUint16(off + 3, false);
        r[i] = dv.getUint8(off + 5);
        off += 6;
      }
      return { count, type, x, y, r };
    }

    function bucketKey(bx, by) { return by * gridCols + bx; }

    function buildGrid() {
      // gridCols/Rows se calculan a partir del propio rango de coordenadas de
      // los objetos (no depende de recibir `layout` primero) para que la
      // capa funcione aunque se cargue objects.bin antes que map:layout.
      let maxX = 1, maxY = 1;
      for (let i = 0; i < objs.count; i++) {
        if (objs.x[i] > maxX) maxX = objs.x[i];
        if (objs.y[i] > maxY) maxY = objs.y[i];
      }
      gridCols = Math.max(1, Math.ceil((maxX + 1) / OBJ_GRID_CELL));
      gridRows = Math.max(1, Math.ceil((maxY + 1) / OBJ_GRID_CELL));
      grid = new Map();
      for (let i = 0; i < objs.count; i++) {
        const bx = (objs.x[i] / OBJ_GRID_CELL) | 0;
        const by = (objs.y[i] / OBJ_GRID_CELL) | 0;
        const key = bucketKey(bx, by);
        let bucket = grid.get(key);
        if (!bucket) { bucket = []; grid.set(key, bucket); }
        bucket.push(i);
      }
    }

    function onLayout() {
      resizeCanvas();
      initClouds(); // por si el viewport no tenia medidas todavia al construir la capa
      scheduleRedraw();
    }

    // -----------------------------------------------------------------------
    // Caminantes (marcadores de jugador animados)
    // -----------------------------------------------------------------------

    /**
     * Recibe la foto de estado nueva y actualiza los caminantes: da de alta a
     * los que acaban de unirse, de baja a los que han muerto o se han ido, y
     * recalcula el destino de cada uno segun el comando que tenga escrito.
     * Se llama en cada `state:*`, no en cada frame.
     */
    function setWalkerWorld({ tiles, factions, players, layout, blockPx, structures, bosses }) {
      if (!layout) return;
      walkerWorld = { tiles: tiles || [], factions: factions || [], layout, blockPx: blockPx || 1 };
      if (!cow) spawnCow();
      syncSiteWalkers(structures || [], factions || []);
      syncBossWalkers(bosses || []);

      const alive = new Set();
      const byFaction = new Map();
      for (const p of players || []) {
        if (!p.alive) continue; // los muertos dejan de tener marcador, como antes
        alive.add(p.userId);
        if (!byFaction.has(p.factionNumber)) byFaction.set(p.factionNumber, []);
        byFaction.get(p.factionNumber).push(p);
      }

      // Baja de los que ya no estan (muertos o partida nueva)
      for (const userId of [...walkers.keys()]) {
        if (!alive.has(userId)) walkers.delete(userId);
      }

      byFaction.forEach((roster, factionNumber) => {
        const faction = walkerWorld.factions.find((f) => f.number === factionNumber);
        const color = faction ? faction.color : NEUTRAL_COLOR;

        roster.forEach((p, index) => {
          let walker = walkers.get(p.userId);
          if (!walker) {
            // Alta: se reparte alrededor del ancla de su faccion para que no
            // salgan todos apilados en el mismo pixel el primer frame.
            const start = spawnPosition(factionNumber, index, roster.length);
            if (!start) return; // faccion sin territorio todavia: se intentara en el proximo estado
            walker = {
              x: start.x, y: start.y, tx: start.x, ty: start.y,
              hopSeed: Math.random() * Math.PI * 2,
              pauseUntil: 0,
              path: [], // tramos pendientes de la ruta actual, ver setRoute()
              action: null, actionTarget: null,
              dir: 'right', // que sprite le toca (soldier-left/right), ver stepWalkers()
              facingAngle: 0, // hacia donde mira (radianes) — el cono de tropas se coloca DETRAS de esto, ver stepFollowerCone()
              aiTroops: 0,
              archerTroops: 0,
              cavalryTroops: 0,
              // Posicion propia de cada tropa que le sigue, ver
              // syncFollowerCone()/stepFollowerCone() — sustituye a la
              // antigua fila india por rastro (trailPositionAt): ahora cada
              // una vive en un punto del cono de detras del jugador y va
              // "alcanzándolo" a su propio ritmo, para que no se muevan
              // todas sincronizadas.
              followers: { aiTroops: [], archerTroops: [], cavalryTroops: [] },
            };
            walkers.set(p.userId, walker);
          }
          walker.color = color;
          walker.username = p.username;
          walker.factionNumber = factionNumber;
          walker.unitType = p.unitType; // 'soldier' | 'knight' — ver drawWalkers()/stepWalkers()
          walker.aiTroops = p.aiTroops || 0; // cuantos acompañantes le siguen, ver drawWalkers()
          walker.archerTroops = p.archerTroops || 0;
          walker.cavalryTroops = p.cavalryTroops || 0;
          syncFollowerCone(walker.followers.aiTroops, walker.aiTroops, walker.x, walker.y);
          syncFollowerCone(walker.followers.archerTroops, walker.archerTroops, walker.x, walker.y);
          syncFollowerCone(walker.followers.cavalryTroops, walker.cavalryTroops, walker.x, walker.y);

          // Solo se recalcula el destino si la orden ha cambiado; si no, se
          // deja que termine de andar hacia donde ya iba (si no, cada `state:*`
          // — que llegan a menudo — le reiniciaria el paseo).
          const actionChanged = walker.action !== p.action || walker.actionTarget !== p.actionTargetFactionNumber;
          walker.action = p.action;
          walker.actionTarget = p.actionTargetFactionNumber;
          if (actionChanged) {
            const dest = destinationFor(walker);
            if (dest) setRoute(walker, dest);
          }
        });
      });

      startWalkerLoop();
    }

    /** Casillas que controla una faccion, en la ultima foto de estado. */
    function ownedTilesOf(factionNumber) {
      if (!walkerWorld) return [];
      return walkerWorld.tiles.filter((t) => !t.neutral && t.ownerFactionNumber === factionNumber);
    }

    /** Centro de una casilla, en pixeles de mundo. */
    function tileCenter(tileId) {
      const c = walkerWorld.layout.centroids[tileId];
      return c ? { x: c.x * walkerWorld.blockPx, y: c.y * walkerWorld.blockPx } : null;
    }

    function randomOf(list) {
      return list.length ? list[Math.floor(Math.random() * list.length)] : null;
    }

    /**
     * Posicion inicial: alrededor del ancla de su faccion, en anillos, para
     * que no salgan todos apilados en el mismo pixel. Si el sitio del anillo
     * cae fuera del territorio (el ancla puede estar pegada a la costa), se
     * usa el centro de la casilla, que siempre es tierra propia.
     */
    function spawnPosition(factionNumber, index, rosterSize) {
      const owned = ownedTilesOf(factionNumber);
      if (!owned.length) return null;
      const anchor = owned.reduce((a, b) => (a.id <= b.id ? a : b));
      const center = tileCenter(anchor.id);
      if (!center) return null;

      const ring = Math.floor(index / PLAYERS_PER_RING);
      const posInRing = index % PLAYERS_PER_RING;
      const countInRing = Math.min(PLAYERS_PER_RING, rosterSize - ring * PLAYERS_PER_RING);
      const angle = (2 * Math.PI * posInRing) / countInRing;
      const radius = MARKER_RING_BASE_RADIUS + ring * MARKER_RING_STEP;
      const spot = { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };

      const ownedIds = new Set(owned.map((t) => t.id));
      return ownedIds.has(tileIdAtWorld(spot.x, spot.y)) ? spot : center;
    }

    /**
     * A donde tiene que ir este caminante segun el comando que haya escrito.
     * Todo se calcula a nivel de CASILLA (unas pocas decenas), no de celda del
     * raster (cientos de miles), asi que sale practicamente gratis. Si el
     * destino que toca no existe (defiende pero no hay castillos suyos, ataca
     * a alguien con quien no tiene frontera...), devuelve null y el caminante
     * se queda paseando, que siempre es un destino valido.
     */
    function destinationFor(walker) {
      switch (walker.action) {
        case 'ATTACK': return borderPointWith(walker.factionNumber, walker.actionTarget) || wanderTarget(walker);
        case 'EXPAND': return neutralBorderPoint(walker.factionNumber) || wanderTarget(walker);
        case 'DEFEND': return strongholdPoint(walker.factionNumber) || wanderTarget(walker);
        case 'INDUSTRY': return industryPoint(walker.factionNumber) || wanderTarget(walker);
        default: return wanderTarget(walker);
      }
    }

    /** Punto medio entre una casilla propia y una vecina de la faccion objetivo: "la frontera". */
    /**
     * A donde va un atacante. Lo normal es la frontera de tierra con la
     * faccion atacada, pero en este mapa (el mundo real) es MUY habitual que
     * dos facciones no se toquen por tierra: estan en continentes distintos y
     * la adyacencia del juego solo existe entre casillas que se tocan pixel a
     * pixel. En ese caso se manda al caminante al borde de su territorio que
     * MIRA hacia el enemigo — se lee como "juntandose en la costa para
     * embarcar", que es lo que se quiere ver, en vez de dejarlo paseando como
     * si no hubiera dado ninguna orden.
     */
    function borderPointWith(factionNumber, targetFactionNumber) {
      if (!targetFactionNumber) return null;
      const shared = frontLinePoint(
        factionNumber,
        (neighbor) => !neighbor.neutral && neighbor.ownerFactionNumber === targetFactionNumber
      );
      if (shared) return shared;
      return coastFacing(factionNumber, targetFactionNumber);
    }

    /** Punto del territorio propio mas cercano al de la faccion objetivo, mirando hacia ella. */
    function coastFacing(factionNumber, targetFactionNumber) {
      const owned = ownedTilesOf(factionNumber);
      const targets = ownedTilesOf(targetFactionNumber);
      if (!owned.length || !targets.length) return null;

      let best = null;
      for (const mine of owned) {
        const a = tileCenter(mine.id);
        if (!a) continue;
        for (const theirs of targets) {
          const b = tileCenter(theirs.id);
          if (!b) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (!best || d < best.d) best = { d, a, b, tileId: mine.id };
        }
      }
      if (!best) return null;

      // Se avanza hacia el enemigo lo que se pueda sin dejar tierra propia:
      // acaba justo en la costa que da hacia el.
      const ownedIds = new Set(owned.map((t) => t.id));
      let point = best.a;
      for (const bias of [0.45, 0.35, 0.25, 0.15, 0.07]) {
        const p = {
          x: best.a.x + (best.b.x - best.a.x) * bias + (Math.random() - 0.5) * 24,
          y: best.a.y + (best.b.y - best.a.y) * bias + (Math.random() - 0.5) * 24,
        };
        if (ownedIds.has(tileIdAtWorld(p.x, p.y))) { point = p; break; }
      }
      return point;
    }

    /** Igual, pero contra territorio neutral (para `!expansion`). */
    function neutralBorderPoint(factionNumber) {
      return frontLinePoint(factionNumber, (neighbor) => neighbor.neutral);
    }

    /**
     * Elige al azar una pareja "casilla propia / casilla vecina que cumple
     * `matches`" y devuelve un punto en esa frontera. Comun a `!ataque` (el
     * vecino es de la faccion atacada) y a `!expansion` (el vecino es
     * neutral). Si no hay ninguna frontera asi, devuelve null y quien llama
     * deja al caminante paseando.
     */
    function frontLinePoint(factionNumber, matches) {
      const owned = ownedTilesOf(factionNumber);
      const ownedIds = new Set(owned.map((t) => t.id));
      const byId = new Map(walkerWorld.tiles.map((t) => [t.id, t]));
      const pairs = [];
      for (const tile of owned) {
        for (const nid of tile.neighborIds || []) {
          const neighbor = byId.get(nid);
          if (neighbor && matches(neighbor)) pairs.push([tile.id, nid]);
        }
      }
      const pick = randomOf(pairs);
      return pick ? midpointOfTiles(pick[0], pick[1], ownedIds) : null;
    }

    /**
     * Punto de "primera linea": sobre la recta que une el centro de una
     * casilla propia con el de la casilla vecina, pero SIN llegar a la mitad,
     * para que el caminante se plante mirando a la frontera y no dentro del
     * territorio de enfrente.
     *
     * Se prueban varios avances de mas a menos y se coge el primero que
     * todavia caiga en tierra PROPIA: dos centros de casilla vecinos pueden
     * tener mar en medio (islas, penínsulas, un estrecho), y sin esta
     * comprobacion los atacantes acababan plantados en el agua.
     */
    function midpointOfTiles(ownTileId, otherTileId, ownedIds) {
      const a = tileCenter(ownTileId);
      const b = tileCenter(otherTileId);
      if (!a || !b) return null;

      const jitter = () => (Math.random() - 0.5) * 26; // que no se apilen todos en el mismo punto
      for (const bias of [0.38, 0.3, 0.22, 0.15, 0.08]) {
        const p = {
          x: a.x + (b.x - a.x) * bias + jitter(),
          y: a.y + (b.y - a.y) * bias + jitter(),
        };
        if (ownedIds.has(tileIdAtWorld(p.x, p.y))) return p;
      }
      return a; // ni acercandose: se queda en el centro de su casilla fronteriza
    }

    /** Castillo o aldea dentro del territorio de la faccion (para `!defender`). */
    function strongholdPoint(factionNumber) {
      const owned = new Set(ownedTilesOf(factionNumber).map((t) => t.id));
      if (!owned.size) return null;
      const candidates = decorations.filter(
        (d) => (d.type === 'castle' || d.type === 'village') && owned.has(tileIdAtWorld(d.wx, d.wy))
      );
      const pick = randomOf(candidates);
      if (!pick) return null;
      // Se plantan alrededor del castillo, no todos clavados en el mismo
      // pixel — pero sin salirse de tierra propia (un castillo costero tiene
      // agua a un lado).
      return scatterOnOwnLand(pick.wx, pick.wy, 30, 22, owned);
    }

    /** Punto cerca de (x,y) que siga en tierra de la faccion; si no lo hay, el propio (x,y). */
    function scatterOnOwnLand(x, y, spreadX, spreadY, ownedIds) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const p = { x: x + (Math.random() - 0.5) * spreadX, y: y + (Math.random() - 0.5) * spreadY };
        if (ownedIds.has(tileIdAtWorld(p.x, p.y))) return p;
      }
      return { x, y };
    }

    /** Casilla propia con industria levantada (para `!industria`). */
    function industryPoint(factionNumber) {
      const owned = ownedTilesOf(factionNumber);
      const withIndustry = owned.filter((t) => (t.industryCount || 0) > 0);
      const tile = randomOf(withIndustry);
      if (!tile) return null;
      const c = tileCenter(tile.id);
      if (!c) return null;
      return scatterOnOwnLand(c.x, c.y, 40, 30, new Set(owned.map((t) => t.id)));
    }

    /** Que casilla hay en un punto del mundo (o -1 si es oceano). */
    function tileIdAtWorld(wx, wy) {
      const { layout, blockPx } = walkerWorld;
      const gx = Math.floor(wx / blockPx);
      const gy = Math.floor(wy / blockPx);
      if (gx < 0 || gy < 0 || gx >= layout.cols || gy >= layout.rows) return -1;
      return layout.cellTileIds[gy * layout.cols + gx];
    }

    /**
     * ¿Se puede ir en linea recta de (x0,y0) a (x1,y1) sin salirse del
     * territorio propio? Comprueba varios puntos a lo largo del trayecto, no
     * solo el destino: los caminantes andan en linea recta, asi que validar
     * unicamente el punto final los hacia cruzar bahias y brazos de mar
     * andando sobre el agua cuando el origen y el destino estaban en dos
     * peninsulas distintas.
     */
    function pathStaysInside(x0, y0, x1, y1, ownedIds) {
      const SAMPLES = 6;
      for (let i = 1; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        if (!ownedIds.has(tileIdAtWorld(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))) return false;
      }
      return true;
    }

    /**
     * Siguiente paso del paseo: un punto cercano al que se pueda llegar sin
     * salir del territorio de su faccion (se prueban unas cuantas direcciones
     * al azar y, si ninguna vale, se queda donde esta — asi nunca se ponen a
     * pasear por el mar ni por tierra ajena).
     */
    function wanderTarget(walker) {
      const owned = ownedTilesOf(walker.factionNumber);
      if (!owned.length) return null;
      const ownedIds = new Set(owned.map((t) => t.id));

      for (let attempt = 0; attempt < 10; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = WANDER_RADIUS * (0.3 + Math.random() * 0.7);
        const x = walker.x + Math.cos(angle) * dist;
        const y = walker.y + Math.sin(angle) * dist;
        if (pathStaysInside(walker.x, walker.y, x, y, ownedIds)) return { x, y };
      }
      // Sin sitio al que ir sin mojarse (islote de una sola casilla, esquina
      // muy estrecha...): se queda quieto hasta el proximo intento.
      return null;
    }

    // -----------------------------------------------------------------------
    // Guarnicion/aldeanos "de guardia": un grupito de caminantes ambientales
    // atado a un sitio fijo (un castillo/aldea/puerto o la capital de una
    // faccion), a diferencia de los caminantes de jugador (que recorren todo
    // su territorio). Ver docs/ACCIONES.md.
    //
    //   - Estructura SIN conquistar: la guarnicion neutral pasea con el
    //     mismo placeholder que las tropas de un jugador (troop/
    //     troop-archer/troop-cavalry, ver rules/structures.js aiTroops/
    //     archerTroops/cavalryTroops), un puñado por tipo presente (no todos
    //     a la vez: con guarniciones de 10-15 no cabrian, es solo "un par
    //     paseando" para dar la sensacion de que hay alguien).
    //   - Estructura YA conquistada: 3 aldeanos (aldeano.png).
    //   - Capital de cada faccion: capitalVillagerCount aldeanos (4-8,
    //     sorteado una vez en el servidor al crear la partida).
    // -----------------------------------------------------------------------

    /** Cuantos caminantes de que tipo le tocan a un sitio, sin listar posiciones todavia. */
    function desiredSiteSpecs(structures, factions) {
      const sites = new Map(); // siteKey -> { home:{x,y}, factionColor, buildingKind, specs: [{spriteKey, n}] }

      (structures || []).forEach((s) => {
        if (s.x == null || s.y == null) return; // partida vieja/estado incompleto: sin posicion no hay donde pintar
        const isDungeon = s.type === 'dungeon';
        const specs = [];
        if (!s.conquered) {
          if (isDungeon) {
            // Numero SIEMPRE fijo (2 orcos + 4 goblins), a diferencia de
            // castillo/aldea/puerto — asi se pidio explicitamente.
            specs.push({ spriteKey: 'orco', n: 2 });
            specs.push({ spriteKey: 'goblin', n: 4 });
          } else {
            // Un par por tipo presente en la guarnicion (tope 3, para no
            // amontonar 15 sprites encima de un castillo grande).
            if (s.aiTroops > 0) specs.push({ spriteKey: 'barbaro', n: Math.min(3, Math.max(1, Math.ceil(s.aiTroops / 4))) });
            if (s.archerTroops > 0) specs.push({ spriteKey: 'barbaro-arquero', n: Math.min(3, Math.max(1, Math.ceil(s.archerTroops / 4))) });
            if (s.cavalryTroops > 0) specs.push({ spriteKey: 'barbaro-caballero', n: Math.min(3, Math.max(1, Math.ceil(s.cavalryTroops / 4))) });
          }
        } else if (!isDungeon) {
          // Un dungeon derrotado NO deja aldeanos en su sitio — su
          // recompensa es una estatua junto a la capital (ver más abajo),
          // no producción para la casilla como castillo/aldea/puerto.
          specs.push({ spriteKey: 'aldeano', n: 3 });
        }
        if (!specs.length) return;
        // Clave por tileId+type (no solo tileId): varias estructuras pueden
        // compartir casilla (ver sección 22 de docs/ACCIONES.md), cada una
        // con su propio grupo de paseantes anclado a SU posición exacta
        // (`s.x`/`s.y`, celdas de rejilla -> px de mundo), no al centroide
        // medio de la casilla entera.
        sites.set(`struct:${s.tileId}:${s.type}`, {
          home: { x: s.x * walkerWorld.blockPx, y: s.y * walkerWorld.blockPx },
          factionColor: null,
          buildingKind: null,
          specs,
        });
      });

      (factions || []).forEach((f) => {
        if (f.capitalTileId == null) return;
        const home = tileCenter(f.capitalTileId);
        if (!home) return;
        sites.set(`capital:${f.number}`, {
          home,
          factionColor: f.color,
          buildingKind: 'capital',
          specs: [{ spriteKey: 'aldeano', n: Math.max(1, f.capitalVillagerCount || 0) }],
        });

        // Trofeos de dungeon (sección 27): una estatua nueva por cada
        // dungeon derrotado, repartidas en un anillo alrededor de la
        // capital (ángulo dorado para que no se amontonen sea cual sea el
        // número) — "la capital va creciendo según haces cosas", cada una
        // con sus propios 4 aldeanos alrededor, igual que la capital.
        const trophies = f.dungeonTrophies || 0;
        for (let i = 0; i < trophies; i++) {
          const angle = i * ESTATUA_ANGLE_STEP;
          sites.set(`trophy:${f.number}:${i}`, {
            home: {
              x: home.x + Math.cos(angle) * ESTATUA_RING_RADIUS,
              y: home.y + Math.sin(angle) * ESTATUA_RING_RADIUS,
            },
            factionColor: null,
            buildingKind: 'estatua',
            specs: [{ spriteKey: 'aldeano', n: 4 }],
          });
        }

        // Museos (trofeo de `!boss`, ver rules/bosses.js sección 31): "se
        // spawnea igual que el monumento alrededor de la capital", tal y
        // como se pidió — mismo mecanismo de anillo con ángulo dorado y
        // los mismos 4 aldeanos alrededor que una estatua de dungeon, pero
        // en un anillo MÁS ANCHO (MUSEO_RING_RADIUS) para no solaparse con
        // las estatuas si la facción tiene trofeos de los dos tipos a la vez.
        const museums = f.bossTrophies || 0;
        for (let i = 0; i < museums; i++) {
          const angle = i * ESTATUA_ANGLE_STEP;
          sites.set(`museo:${f.number}:${i}`, {
            home: {
              x: home.x + Math.cos(angle) * MUSEO_RING_RADIUS,
              y: home.y + Math.sin(angle) * MUSEO_RING_RADIUS,
            },
            factionColor: null,
            buildingKind: 'museo',
            specs: [{ spriteKey: 'aldeano', n: 4 }],
          });
        }

        // Castillo especial del nivel 4 de industria (rules/industry.js): UNA
        // sola vez, a un lado fijo de la capital (no en anillo, a diferencia
        // de las estatuas — solo puede haber uno). Sin aldeanos alrededor,
        // solo sus propias tropas especiales, tal y como se pidió.
        if (f.specialCastleBuilt) {
          sites.set(`castillo-especial:${f.number}`, {
            home: { x: home.x + CASTILLO_ESPECIAL_OFFSET_X, y: home.y },
            factionColor: f.color,
            buildingKind: 'castilloEspecial',
            specs: [{ spriteKey: 'tropa-especial', n: Math.max(1, f.specialTroopCount || 0) }],
          });
        }
      });

      return sites;
    }

    /**
     * Ajusta `siteWalkers` a lo que toca AHORA (guarnicion/aldeanos por
     * sitio), dando de alta/baja solo lo que cambio — igual que los
     * caminantes de jugador, nunca se reposiciona a uno que ya estaba
     * paseando, para que una estructura conquistada a mitad de partida no
     * "teletransporte" a nadie: los soldados barbaros que sobran se borran y
     * los aldeanos nuevos aparecen cerca de la casa, sin más.
     */
    function syncSiteWalkers(structures, factions) {
      const desired = desiredSiteSpecs(structures, factions);

      for (const key of [...siteWalkers.keys()]) {
        if (!desired.has(key)) siteWalkers.delete(key);
      }

      desired.forEach((site, key) => {
        const home = site.home;
        let group = siteWalkers.get(key);
        if (!group) { group = { home, factionColor: site.factionColor, buildingKind: site.buildingKind, list: [] }; siteWalkers.set(key, group); }
        group.home = home;
        group.factionColor = site.factionColor;
        group.buildingKind = site.buildingKind;

        const wantCounts = new Map();
        site.specs.forEach(({ spriteKey, n }) => wantCounts.set(spriteKey, (wantCounts.get(spriteKey) || 0) + n));
        const haveCounts = new Map();
        group.list.forEach((w) => haveCounts.set(w.spriteKey, (haveCounts.get(w.spriteKey) || 0) + 1));

        for (const spriteKey of new Set([...haveCounts.keys(), ...wantCounts.keys()])) {
          let have = haveCounts.get(spriteKey) || 0;
          const want = wantCounts.get(spriteKey) || 0;
          while (have > want) {
            const idx = group.list.findIndex((w) => w.spriteKey === spriteKey);
            if (idx === -1) break;
            group.list.splice(idx, 1);
            have--;
          }
          while (have < want) {
            const angle = Math.random() * Math.PI * 2;
            const dist = SITE_WANDER_RADIUS * Math.random();
            group.list.push({
              spriteKey,
              x: home.x + Math.cos(angle) * dist,
              y: home.y + Math.sin(angle) * dist,
              tx: home.x, ty: home.y,
              dir: 'right', pauseUntil: 0, hopSeed: Math.random() * Math.PI * 2,
            });
            have++;
          }
        }
      });
    }

    /** Siguiente sitio al que vagar, igual que cowWanderTarget() pero atado a un radio pequeño alrededor de `home`. */
    function siteWanderTarget(home, w) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = SITE_WANDER_RADIUS * (0.3 + Math.random() * 0.7);
        const x = home.x + Math.cos(angle) * dist;
        const y = home.y + Math.sin(angle) * dist;
        if (pathStaysOnLand(w.x, w.y, x, y)) return { x, y };
      }
      return null;
    }

    function stepSiteWalkers(dt, now) {
      siteWalkers.forEach((group) => {
        group.list.forEach((w) => {
          const dx = w.tx - w.x, dy = w.ty - w.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= WALK_ARRIVE_DIST) {
            if (now >= w.pauseUntil) {
              const next = siteWanderTarget(group.home, w);
              if (next) { w.tx = next.x; w.ty = next.y; }
              w.pauseUntil = now + SITE_PAUSE_MS * (0.5 + Math.random());
            }
          } else {
            const step = Math.min(dist, SITE_WALK_SPEED * dt);
            w.x += (dx / dist) * step;
            w.y += (dy / dist) * step;
            if (dx > WALKER_DIR_THRESHOLD) w.dir = 'right';
            else if (dx < -WALKER_DIR_THRESHOLD) w.dir = 'left';
          }
        });
      });
    }

    const SITE_WALKER_SPRITES = {
      barbaro: [barbaroImg, TROOP_SPRITE_WORLD_W],
      'barbaro-arquero': [barbaroArcherImg, TROOP_SPRITE_WORLD_W],
      'barbaro-caballero': [barbaroCavalryImg, CAVALRY_TROOP_SPRITE_WORLD_W],
      aldeano: [aldeanoSpriteImg, ALDEANO_SPRITE_WORLD_W],
      orco: [orcoImg, ORCO_SPRITE_WORLD_W],
      goblin: [goblinImg, GOBLIN_SPRITE_WORLD_W],
      'tropa-especial': [tropaEspecialImg, TROPA_ESPECIAL_SPRITE_WORLD_W],
    };

    /** Dibuja el edificio del sitio (capital teñida de su facción, o estatua-trofeo sin teñir) y los caminantes de cada sitio. */
    function drawSiteWalkers(w, h) {
      if (!siteWalkers.size) return;
      const { x: vx, y: vy, scale } = currentView;
      const margin = OBJ_VIEWPORT_MARGIN_PX / scale;
      const wx0 = (0 - vx) / scale - margin, wx1 = (w - vx) / scale + margin;
      const wy0 = (0 - vy) / scale - margin, wy1 = (h - vy) / scale + margin;
      const t = performance.now() / 1000;

      siteWalkers.forEach((group) => {
        const { home } = group;
        const inView = home.x >= wx0 && home.x <= wx1 && home.y >= wy0 && home.y <= wy1;
        if (inView && group.buildingKind === 'capital' && capitalSpriteImg.complete && capitalSpriteImg.naturalWidth) {
          const cw = CAPITAL_SPRITE_WORLD_W * scale;
          const chh = cw * (capitalSpriteImg.naturalHeight / capitalSpriteImg.naturalWidth);
          drawTintedSprite(capitalSpriteImg, home.x * scale + vx - cw / 2, home.y * scale + vy - chh, cw, chh, group.factionColor, 0.65);
        } else if (inView && group.buildingKind === 'estatua' && estatuaImg.complete && estatuaImg.naturalWidth) {
          const ew = ESTATUA_SPRITE_WORLD_W * scale;
          const eh = ew * (estatuaImg.naturalHeight / estatuaImg.naturalWidth);
          ctx.drawImage(estatuaImg, home.x * scale + vx - ew / 2, home.y * scale + vy - eh, ew, eh);
        } else if (inView && group.buildingKind === 'castilloEspecial' && castilloEspecialImg.complete && castilloEspecialImg.naturalWidth) {
          const kw = CASTILLO_ESPECIAL_SPRITE_WORLD_W * scale;
          const kh = kw * (castilloEspecialImg.naturalHeight / castilloEspecialImg.naturalWidth);
          drawTintedSprite(castilloEspecialImg, home.x * scale + vx - kw / 2, home.y * scale + vy - kh, kw, kh, group.factionColor, 0.65);
        } else if (inView && group.buildingKind === 'museo' && museoImg.complete && museoImg.naturalWidth) {
          const mw = MUSEO_SPRITE_WORLD_W * scale;
          const mh = mw * (museoImg.naturalHeight / museoImg.naturalWidth);
          ctx.drawImage(museoImg, home.x * scale + vx - mw / 2, home.y * scale + vy - mh, mw, mh);
        }

        group.list.forEach((walker) => {
          if (walker.x < wx0 || walker.x > wx1 || walker.y < wy0 || walker.y > wy1) return;
          const spec = SITE_WALKER_SPRITES[walker.spriteKey];
          if (!spec) return;
          const [img, worldW] = spec;
          if (!img.complete || !img.naturalWidth) return;
          const drawW = worldW * scale;
          const drawH = drawW * (img.naturalHeight / img.naturalWidth);
          const moving = Math.hypot(walker.tx - walker.x, walker.ty - walker.y) > WALK_ARRIVE_DIST;
          const hop = moving ? Math.abs(Math.sin(t * HOP_SPEED + walker.hopSeed)) * HOP_HEIGHT : 0;
          const sx = walker.x * scale + vx;
          const sy = (walker.y - hop) * scale + vy;
          ctx.drawImage(img, sx - drawW / 2, sy - drawH, drawW, drawH);
        });
      });
    }

    // -----------------------------------------------------------------------
    // Bosses (ver docs/ACCIONES.md sección 31, !boss, rules/bosses.js): un
    // placeholder grande por boss vivo, vagando SOLO por la casilla en la
    // que salió (a diferencia de la vaca, que recorre todo el mapa) — se
    // reutiliza `pathStaysInside()` con un único tileId como territorio
    // permitido, en vez del territorio entero de una facción.
    // -----------------------------------------------------------------------
    const BOSS_WALK_SPEED = 30; // mas lento que la vaca: son grandes y torpes
    const BOSS_WANDER_RADIUS = 90;
    const BOSS_PAUSE_MS = 1600;
    const BOSS_LABEL_OFFSET_Y = 14; // px de mundo extra por encima del sprite para el atk/def

    /** Da de alta/baja los bosses vivos, sin reposicionar los que ya estaban paseando. */
    function syncBossWalkers(bosses) {
      const desiredKeys = new Set();
      (bosses || []).forEach((b) => {
        if (b.defeated || b.x == null || b.y == null) return;
        const key = `${b.tileId}:${b.key}`;
        desiredKeys.add(key);
        if (bossWalkers.has(key)) return;
        const home = { x: b.x * walkerWorld.blockPx, y: b.y * walkerWorld.blockPx };
        bossWalkers.set(key, {
          x: home.x, y: home.y, tx: home.x, ty: home.y,
          tileId: b.tileId, bossKey: b.key,
          attackPower: b.attackPower, defensePower: b.defensePower,
          dir: 'right', pauseUntil: 0, hopSeed: Math.random() * Math.PI * 2,
        });
      });
      for (const key of [...bossWalkers.keys()]) {
        if (!desiredKeys.has(key)) bossWalkers.delete(key);
      }
    }

    /** Siguiente sitio al que vagar SIN salir de `tileId` — mismo patrón que wanderTarget()/cowWanderTarget(). */
    function bossWanderTarget(w) {
      const ownedIds = new Set([w.tileId]);
      for (let attempt = 0; attempt < 10; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = BOSS_WANDER_RADIUS * (0.3 + Math.random() * 0.7);
        const x = w.x + Math.cos(angle) * dist;
        const y = w.y + Math.sin(angle) * dist;
        if (pathStaysInside(w.x, w.y, x, y, ownedIds)) return { x, y };
      }
      return null; // casilla muy pequeña/estrecha: se queda quieto hasta el proximo intento
    }

    function stepBossWalkers(dt, now) {
      bossWalkers.forEach((w) => {
        const dx = w.tx - w.x, dy = w.ty - w.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= WALK_ARRIVE_DIST) {
          if (now >= w.pauseUntil) {
            const next = bossWanderTarget(w);
            if (next) { w.tx = next.x; w.ty = next.y; }
            w.pauseUntil = now + BOSS_PAUSE_MS * (0.5 + Math.random());
          }
        } else {
          const step = Math.min(dist, BOSS_WALK_SPEED * dt);
          w.x += (dx / dist) * step;
          w.y += (dy / dist) * step;
          if (dx > WALKER_DIR_THRESHOLD) w.dir = 'right';
          else if (dx < -WALKER_DIR_THRESHOLD) w.dir = 'left';
        }
      });
    }

    /** Dibuja cada boss vivo y su ataque/defensa encima de la cabeza, si cae dentro de lo visible. */
    function drawBossWalkers(w, h) {
      if (!bossWalkers.size) return;
      const { x: vx, y: vy, scale } = currentView;
      const margin = OBJ_VIEWPORT_MARGIN_PX / scale;
      const wx0 = (0 - vx) / scale - margin, wx1 = (w - vx) / scale + margin;
      const wy0 = (0 - vy) / scale - margin, wy1 = (h - vy) / scale + margin;
      const t = performance.now() / 1000;

      bossWalkers.forEach((walker) => {
        if (walker.x < wx0 || walker.x > wx1 || walker.y < wy0 || walker.y > wy1) return;
        const spec = BOSS_SPRITES[walker.bossKey];
        if (!spec) return;
        const [img, worldW] = spec;
        if (!img.complete || !img.naturalWidth) return;
        const drawW = worldW * scale;
        const drawH = drawW * (img.naturalHeight / img.naturalWidth);
        const moving = Math.hypot(walker.tx - walker.x, walker.ty - walker.y) > WALK_ARRIVE_DIST;
        const hop = moving ? Math.abs(Math.sin(t * HOP_SPEED + walker.hopSeed)) * HOP_HEIGHT * 0.6 : 0;
        const sx = walker.x * scale + vx;
        const sy = (walker.y - hop) * scale + vy;
        ctx.drawImage(img, sx - drawW / 2, sy - drawH, drawW, drawH);

        // Mismo estilo que el nombre de un jugador (sombra oscura detras +
        // relleno claro, sin caja) — roundRect()/screenPx() viven en el
        // closure de createMapController, no en este de createObjectLayer.
        const label = `⚔${walker.attackPower} 🛡${walker.defensePower}`;
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const labelY = sy - drawH - BOSS_LABEL_OFFSET_Y * scale;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(6,18,26,.85)';
        ctx.strokeText(label, sx, labelY);
        ctx.fillStyle = '#f5fbff';
        ctx.fillText(label, sx, labelY);
      });
    }

    // -----------------------------------------------------------------------
    // Easter egg: la vaca. Unica en todo el mapa, vaga por TIERRA sin mirar
    // de quien es el territorio (a diferencia de los caminantes, que solo se
    // mueven dentro de su propia facción) — es puro decorado, no cuenta para
    // ninguna regla. Un acompañante (un unico sprite, sin variante de
    // sentido) la sigue siempre a poca distancia seguiendo su propio rastro,
    // asi nunca "corta camino" por sitios por los que la vaca no ha pasado.
    // Ver docs/ACCIONES.md seccion 15.
    // -----------------------------------------------------------------------
    const COW_WALK_SPEED = 42; // px de mundo por segundo, mas lento que un paseo normal de jugador
    const COW_WANDER_RADIUS = 170;
    const COW_PAUSE_MS = 1400;
    const COW_TRAIL_SAMPLE_MS = 110; // cada cuanto se apunta un punto del rastro
    const COW_FOLLOWER_LAG_MS = 650; // "a poco espacio": cuanto por detras va el acompañante
    const cowFollowerImg = loadSprite('cow-follower');
    const cowImages = { right: loadSprite('cow-right'), left: loadSprite('cow-left') };
    const COW_SPRITE_WORLD_W = 34;
    const COW_FOLLOWER_SPRITE_WORLD_W = 15;

    /** ¿Hay tierra en este punto del mundo? (cualquier facción o neutral, da igual). */
    function isLandAtWorld(wx, wy) {
      return tileIdAtWorld(wx, wy) !== OCEAN;
    }

    /** Igual que pathStaysInside() pero sin restringir a ninguna facción: solo "que no se moje". */
    function pathStaysOnLand(x0, y0, x1, y1) {
      const SAMPLES = 6;
      for (let i = 1; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        if (!isLandAtWorld(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
      }
      return true;
    }

    function spawnCow() {
      const tile = randomOf(walkerWorld.tiles);
      if (!tile) return; // sin mapa todavia
      const start = tileCenter(tile.id);
      if (!start) return;
      cow = {
        x: start.x, y: start.y, tx: start.x, ty: start.y,
        dir: 'right', pauseUntil: 0, hopSeed: Math.random() * Math.PI * 2,
        trail: [{ x: start.x, y: start.y, t: performance.now() }],
        lastSampleAt: 0,
        follower: { x: start.x, y: start.y },
      };
      startWalkerLoop();
    }

    /** Siguiente sitio al que vagar, igual que wanderTarget() pero sin mirar de quien es la tierra. */
    function cowWanderTarget() {
      for (let attempt = 0; attempt < 10; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = COW_WANDER_RADIUS * (0.3 + Math.random() * 0.7);
        const x = cow.x + Math.cos(angle) * dist;
        const y = cow.y + Math.sin(angle) * dist;
        if (pathStaysOnLand(cow.x, cow.y, x, y)) return { x, y };
      }
      return null;
    }

    /** Avanza la vaca y, a poca distancia detras, a su acompañante (sigue el rastro, nunca atajos). */
    function stepCow(dt, now) {
      if (!cow) return;
      const dx = cow.tx - cow.x, dy = cow.ty - cow.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= WALK_ARRIVE_DIST) {
        if (now >= cow.pauseUntil) {
          const next = cowWanderTarget();
          if (next) { cow.tx = next.x; cow.ty = next.y; }
          cow.pauseUntil = now + COW_PAUSE_MS * (0.5 + Math.random());
        }
      } else {
        const step = Math.min(dist, COW_WALK_SPEED * dt);
        cow.x += (dx / dist) * step;
        cow.y += (dy / dist) * step;
        if (dx > WALKER_DIR_THRESHOLD) cow.dir = 'right';
        else if (dx < -WALKER_DIR_THRESHOLD) cow.dir = 'left';
      }

      // Rastro para el acompañante: se apunta la posicion cada pocos ms y se
      // recorta lo que ya no hace falta (mas viejo que el retraso que necesita).
      if (now - cow.lastSampleAt >= COW_TRAIL_SAMPLE_MS) {
        cow.trail.push({ x: cow.x, y: cow.y, t: now });
        cow.lastSampleAt = now;
        const cutoff = now - COW_FOLLOWER_LAG_MS - 500;
        while (cow.trail.length > 2 && cow.trail[0].t < cutoff) cow.trail.shift();
      }
      const targetT = now - COW_FOLLOWER_LAG_MS;
      let followPoint = cow.trail[0];
      for (const p of cow.trail) {
        if (p.t > targetT) break;
        followPoint = p;
      }
      cow.follower.x = followPoint.x;
      cow.follower.y = followPoint.y;
    }

    /** Dibuja la vaca y su acompañante, si caen dentro de lo visible. */
    function drawCow(w, h) {
      if (!cow) return;
      const { x: vx, y: vy, scale } = currentView;
      const margin = OBJ_VIEWPORT_MARGIN_PX / scale;
      const wx0 = (0 - vx) / scale - margin, wx1 = (w - vx) / scale + margin;
      const wy0 = (0 - vy) / scale - margin, wy1 = (h - vy) / scale + margin;

      const followerImg = cowFollowerImg;
      if (followerImg.complete && followerImg.naturalWidth &&
          cow.follower.x >= wx0 && cow.follower.x <= wx1 && cow.follower.y >= wy0 && cow.follower.y <= wy1) {
        const fw = COW_FOLLOWER_SPRITE_WORLD_W * scale;
        const fh = fw * (followerImg.naturalHeight / followerImg.naturalWidth);
        ctx.drawImage(followerImg, cow.follower.x * scale + vx - fw / 2, cow.follower.y * scale + vy - fh, fw, fh);
      }

      const cowImg = cowImages[cow.dir] || cowImages.right;
      if (cowImg.complete && cowImg.naturalWidth &&
          cow.x >= wx0 && cow.x <= wx1 && cow.y >= wy0 && cow.y <= wy1) {
        const cwWidth = COW_SPRITE_WORLD_W * scale;
        const cwHeight = cwWidth * (cowImg.naturalHeight / cowImg.naturalWidth);
        ctx.drawImage(cowImg, cow.x * scale + vx - cwWidth / 2, cow.y * scale + vy - cwHeight, cwWidth, cwHeight);
      }
    }

    // -----------------------------------------------------------------------
    // Nubes del cielo: decoracion pura, sin ninguna relacion con el mapa de
    // la partida. Van en coordenadas de PANTALLA (no de mundo: no hay que
    // convertir nada al hacer pan/zoom) y se dibujan en ESTE mismo canvas,
    // que ya esta recortado exactamente a la franja del mapa entre las dos
    // barras de madera (ver `#mapViewport` en shared.css) — por eso nunca
    // hace falta comprobar aparte que no se salgan hacia los menus ni se
    // superpongan a un popup (los popups van muy por encima en z-index).
    // Ver docs/ACCIONES.md seccion 15.
    // -----------------------------------------------------------------------
    const CLOUD_SPRITE_NAMES = ['cloud-1', 'cloud-2', 'cloud-3'];
    const cloudImages = CLOUD_SPRITE_NAMES.map((name) => loadSprite(name));
    const CLOUD_ALPHA = 0.3; // "muy transparentes", ver cabecera de esta seccion
    const CLOUD_SPEED_MIN = 10, CLOUD_SPEED_MAX = 20; // px de PANTALLA por segundo
    const CLOUD_MAX_ON_SCREEN = 9;
    const CLOUD_SPAWN_MIN_MS = 4000, CLOUD_SPAWN_MAX_MS = 9000;
    const CLOUD_GROUP_GAP_PX = 26; // "a pocos cm" entre nubes de un mismo grupo
    let cloudsInitialized = false;

    /** 55% solas, 30% en pareja, 15% en grupo de 4 — "no muchas, unas pocas". */
    function pickCloudGroupSize() {
      const r = Math.random();
      if (r < 0.55) return 1;
      if (r < 0.85) return 2;
      return 4;
    }

    /**
     * Crea un grupo de nubes nuevo. `seeded` es solo para el sembrado inicial
     * (al cargar la pagina): esas aparecen ya repartidas por la pantalla en
     * vez de entrando por un borde, para que el cielo no se vea vacio los
     * primeros segundos. El resto de grupos, ya en marcha la partida, entran
     * siempre por un lado y van derechas hacia el otro sin rebotar ni
     * "engancharse" al tocar el borde — se despachan solas en stepClouds().
     */
    function spawnCloudBatch(seeded) {
      const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
      if (!w || !h) return;
      const ltr = Math.random() < 0.5; // izquierda->derecha o al reves, al azar
      const speed = CLOUD_SPEED_MIN + Math.random() * (CLOUD_SPEED_MAX - CLOUD_SPEED_MIN);
      const vx = ltr ? speed : -speed;
      const groupSize = pickCloudGroupSize();
      const baseY = h * (0.08 + Math.random() * 0.7);
      for (let i = 0; i < groupSize; i++) {
        const img = cloudImages[Math.floor(Math.random() * cloudImages.length)];
        const naturalW = img.naturalWidth || 68;
        const groupOffset = i * CLOUD_GROUP_GAP_PX * (ltr ? -1 : 1); // el resto del grupo, por detras
        const x = seeded ? Math.random() * w : (ltr ? -naturalW : w + naturalW) + groupOffset;
        clouds.push({ img, x, y: baseY + (Math.random() - 0.5) * 30, vx, naturalW });
      }
    }

    function initClouds() {
      if (cloudsInitialized) return;
      if (!viewportEl.clientWidth || !viewportEl.clientHeight) return; // se reintenta en el proximo onLayout/onResize
      cloudsInitialized = true;
      spawnCloudBatch(true);
      spawnCloudBatch(true);
      nextCloudSpawnAt = performance.now() + 2000 + Math.random() * 3000;
      startWalkerLoop();
    }

    /** Avanza las nubes y retira las que ya salieron del todo por el lado contrario (no rebotan). */
    function stepClouds(dt, now) {
      const w = viewportEl.clientWidth;
      for (let i = clouds.length - 1; i >= 0; i--) {
        const c = clouds[i];
        c.x += c.vx * dt;
        const margin = c.naturalW + 40;
        if (c.x < -margin || c.x > w + margin) clouds.splice(i, 1);
      }
      if (now >= nextCloudSpawnAt && clouds.length < CLOUD_MAX_ON_SCREEN) {
        spawnCloudBatch(false);
        nextCloudSpawnAt = now + CLOUD_SPAWN_MIN_MS + Math.random() * (CLOUD_SPAWN_MAX_MS - CLOUD_SPAWN_MIN_MS);
      }
    }

    function drawClouds(w, h) {
      if (!clouds.length) return;
      ctx.save();
      ctx.globalAlpha = CLOUD_ALPHA;
      for (const c of clouds) {
        if (!c.img.complete || !c.img.naturalWidth) continue;
        const dw = c.img.naturalWidth, dh = c.img.naturalHeight;
        ctx.drawImage(c.img, c.x - dw / 2, c.y - dh / 2, dw, dh);
      }
      ctx.restore();
    }

    /**
     * Fija el destino de un caminante como una RUTA POR TIERRA, no como una
     * linea recta: se busca el camino entre casillas vecinas (que por
     * definicion se tocan por tierra) y se va pasando por el centro de cada
     * una. Sin esto, un soldado que marcha a la frontera puede cruzar una
     * bahia andando sobre el agua, porque el destino era valido pero la recta
     * hasta el no.
     *
     * Si no hay camino por territorio propio (dos islas de la misma faccion),
     * se va en linea recta: es preferible a quedarse plantado.
     */
    function setRoute(walker, dest) {
      walker.path = routeTo(walker, dest);
      const next = walker.path.shift();
      walker.tx = next.x;
      walker.ty = next.y;
      walker.pauseUntil = 0;
    }

    function routeTo(walker, dest) {
      const from = tileIdAtWorld(walker.x, walker.y);
      const to = tileIdAtWorld(dest.x, dest.y);
      if (from < 0 || to < 0 || from === to) return [dest];

      const tiles = tilePathBetween(from, to, walker.factionNumber);
      if (!tiles) return [dest];
      // El primer elemento es la casilla donde ya esta: se salta.
      const points = tiles.slice(1).map((id) => tileCenter(id)).filter(Boolean);
      points.push(dest);
      return points;
    }

    /**
     * Camino mas corto (en numero de casillas) entre dos casillas, pasando
     * SOLO por territorio de esa faccion — no se atraviesa tierra ajena para
     * llegar a un castillo propio. Busqueda en anchura sobre el grafo de
     * casillas, que tiene unas pocas decenas de nodos: cuesta nada.
     */
    function tilePathBetween(fromTileId, toTileId, factionNumber) {
      const allowed = new Set(ownedTilesOf(factionNumber).map((t) => t.id));
      if (!allowed.has(fromTileId) || !allowed.has(toTileId)) return null;

      const byId = new Map(walkerWorld.tiles.map((t) => [t.id, t]));
      const cameFrom = new Map([[fromTileId, null]]);
      const queue = [fromTileId];

      while (queue.length) {
        const current = queue.shift();
        if (current === toTileId) {
          const path = [];
          for (let at = current; at !== null; at = cameFrom.get(at)) path.unshift(at);
          return path;
        }
        for (const nid of byId.get(current)?.neighborIds || []) {
          if (!allowed.has(nid) || cameFrom.has(nid)) continue;
          cameFrom.set(nid, current);
          queue.push(nid);
        }
      }
      return null; // territorio partido en trozos sin conexion por tierra
    }

    /**
     * Da de alta/baja tropas en el cono de `list` hasta que tenga `count`
     * elementos — igual filosofia que los caminantes de sitio (nunca se
     * reposiciona a una tropa que ya estaba ahi, las nuevas aparecen ya
     * cerca del jugador). El angulo/distancia/velocidad de cada una se
     * sortea UNA vez al nacer, no cada frame, para que su comportamiento sea
     * consistente en el tiempo (una tropa "nerviosa" lo es siempre, no solo
     * a veces) aunque distinto entre tropas — de ahi lo "organico".
     */
    function syncFollowerCone(list, count, leaderX, leaderY) {
      while (list.length > count) list.pop();
      while (list.length < count) {
        list.push({
          x: leaderX, y: leaderY,
          angleOffset: (Math.random() * 2 - 1) * TROOP_FOLLOWER_CONE_HALF_ANGLE,
          distFactor: 1 + ((Math.random() * 2 - 1) * TROOP_FOLLOWER_DIST_JITTER) / TROOP_FOLLOWER_BASE_DIST,
          ease: TROOP_FOLLOWER_EASE_MIN + Math.random() * (TROOP_FOLLOWER_EASE_MAX - TROOP_FOLLOWER_EASE_MIN),
          hopSeed: Math.random() * Math.PI * 2,
        });
      }
    }

    /**
     * Mueve las tropas de `w` hacia su sitio dentro del cono de detras del
     * jugador (`w.facingAngle + PI`, ver stepWalkers()) — no en linea recta
     * ni por su rastro exacto, sino con un suavizado exponencial
     * independiente por tropa (`ease`, sorteado en syncFollowerCone) para
     * que "se mueven igual que el jugador pero no sincronizadas", tal y
     * como se pidió.
     */
    function stepFollowerCone(w, dt) {
      const behindAngle = w.facingAngle + Math.PI;
      for (const type of ['aiTroops', 'archerTroops', 'cavalryTroops']) {
        const list = w.followers[type];
        for (const f of list) {
          const dist = TROOP_FOLLOWER_BASE_DIST * f.distFactor;
          const targetAngle = behindAngle + f.angleOffset;
          const targetX = w.x + Math.cos(targetAngle) * dist;
          const targetY = w.y + Math.sin(targetAngle) * dist;
          const k = 1 - Math.exp(-f.ease * dt);
          f.x += (targetX - f.x) * k;
          f.y += (targetY - f.y) * k;
        }
      }
    }

    /** Avanza todos los caminantes `dt` segundos hacia su destino. */
    function stepWalkers(dt, now) {
      if (!walkerWorld) return;
      walkers.forEach((w) => {
        // Las tropas del cono se mueven SIEMPRE, se mueva o no el jugador
        // (para que "salten"/se acomoden incluso parado) — va antes de los
        // `return` de mas abajo a proposito, para que nunca se salte.
        stepFollowerCone(w, dt);

        const dx = w.tx - w.x;
        const dy = w.ty - w.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= WALK_ARRIVE_DIST) {
          // ¿Quedan tramos de la ruta? (ver setRoute: las marchas largas van
          // por el centro de cada casilla del camino, no en linea recta).
          if (w.path && w.path.length) {
            const next = w.path.shift();
            w.tx = next.x;
            w.ty = next.y;
            return;
          }
          // Ha llegado del todo. Los que estan paseando descansan un poco y
          // siguen a otro sitio; los que fueron a una posicion concreta
          // (frontera, castillo...) se quedan ahi hasta que cambie la orden.
          if (!w.action && now >= w.pauseUntil) {
            const next = wanderTarget(w);
            if (next) { w.tx = next.x; w.ty = next.y; }
            w.pauseUntil = now + WANDER_PAUSE_MS * (0.5 + Math.random());
          }
          return;
        }

        const baseSpeed = w.action ? WALK_SPEED_MARCH : WALK_SPEED_WANDER;
        const speed = w.unitType === 'knight' ? baseSpeed * KNIGHT_SPEED_MULTIPLIER : baseSpeed;
        const step = Math.min(dist, speed * dt);
        w.x += (dx / dist) * step;
        w.y += (dy / dist) * step;
        // Hacia donde mira de verdad (radianes) — el cono de tropas se
        // coloca detras de esto (ver stepFollowerCone()), no solo del
        // sentido horizontal de dir.
        w.facingAngle = Math.atan2(dy, dx);
        // Sprite de izquierda/derecha segun el sentido horizontal del ultimo
        // paso — con umbral, para que un tramo casi vertical no lo haga
        // parpadear entre los dos sprites.
        if (dx > WALKER_DIR_THRESHOLD) w.dir = 'right';
        else if (dx < -WALKER_DIR_THRESHOLD) w.dir = 'left';
      });
    }

    /**
     * Tiñe un sprite ya dibujado con un color plano, respetando su silueta:
     * `source-atop` solo pinta donde el propio sprite ya dejo pixeles
     * opacos, asi que el rectangulo de color no se sale de su forma. Es lo
     * que permite tener UN solo PNG de soldado (gris neutro) y que cada
     * facción se vea de su color sin necesitar un PNG por facción.
     */
    function drawTintedSprite(img, dx, dy, dw, dh, color, alpha) {
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(dx, dy, dw, dh);
      ctx.restore();
    }

    /** Dibuja los caminantes visibles, con su brinquito, su sprite segun sentido y su nombre. */
    function drawWalkers(w, h) {
      if (!walkers.size || !walkerWorld) return;
      const { x: vx, y: vy, scale } = currentView;
      const margin = OBJ_VIEWPORT_MARGIN_PX / scale;
      const wx0 = (0 - vx) / scale - margin, wx1 = (w - vx) / scale + margin;
      const wy0 = (0 - vy) / scale - margin, wy1 = (h - vy) / scale + margin;

      const showNames = scale >= WALKER_NAME_MIN_SCALE;
      const t = performance.now() / 1000;

      if (showNames) {
        ctx.font = `${WALKER_NAME_PX}px system-ui, sans-serif`;
        ctx.textAlign = 'left'; // el circulito de color va a la izquierda del nombre, ver mas abajo
        ctx.textBaseline = 'bottom';
      }

      walkers.forEach((walker) => {
        if (walker.x < wx0 || walker.x > wx1 || walker.y < wy0 || walker.y > wy1) return;

        const isKnight = walker.unitType === 'knight';
        const images = isKnight ? knightImages : soldierImages;
        const img = images[walker.dir] || images.right;
        if (!img.complete || !img.naturalWidth) return;
        const drawW = (isKnight ? KNIGHT_SPRITE_WORLD_W : WALKER_SPRITE_WORLD_W) * scale;
        const drawH = (isKnight ? KNIGHT_SPRITE_WORLD_H : WALKER_SPRITE_WORLD_H) * scale;

        // Brinquito: solo mientras se mueve de verdad, para que los que estan
        // parados en la frontera o en un castillo se queden quietos.
        const moving = Math.hypot(walker.tx - walker.x, walker.ty - walker.y) > WALK_ARRIVE_DIST;
        const hop = moving ? Math.abs(Math.sin(t * HOP_SPEED + walker.hopSeed)) * HOP_HEIGHT : 0;

        const sx = walker.x * scale + vx;
        const sy = (walker.y - hop) * scale + vy;

        // Tropas de IA: se dibujan ANTES que al jugador, para que quede
        // claro que van detras/debajo de su "general" — cada una en su
        // propio punto del cono de detras (ver stepFollowerCone()), no en
        // una fila india siguiendo su rastro exacto.
        if (walker.aiTroops > 0 || walker.archerTroops > 0 || walker.cavalryTroops > 0) {
          const followerGroups = [
            { list: walker.followers.aiTroops, img: troopImg, worldW: TROOP_SPRITE_WORLD_W },
            { list: walker.followers.archerTroops, img: archerTroopImg, worldW: TROOP_SPRITE_WORLD_W },
            { list: walker.followers.cavalryTroops, img: cavalryTroopImg, worldW: CAVALRY_TROOP_SPRITE_WORLD_W },
          ];
          for (const group of followerGroups) {
            if (!group.list.length) continue;
            if (!group.img.complete || !group.img.naturalWidth) continue;
            const tw = group.worldW * scale;
            const th = tw * (group.img.naturalHeight / group.img.naturalWidth);
            for (const f of group.list) {
              // Brinco propio, algo mas bajo que el del jugador para
              // diferenciarlos — con su propia semilla, para que no salten
              // todas a la vez.
              const fhop = Math.abs(Math.sin(t * HOP_SPEED + f.hopSeed)) * HOP_HEIGHT * 0.6;
              const tsx = f.x * scale + vx;
              const tsy = (f.y - fhop) * scale + vy;
              ctx.drawImage(group.img, tsx - tw / 2, tsy - th, tw, th);
            }
          }
        }

        // Anclado por la base (abajo-centro), como el resto de sprites del
        // mapa — SIN teñir: el color de facción ya no va sobre el sprite
        // (antes un tinte semitransparente), ahora es el circulito junto
        // al nombre de mas abajo.
        ctx.drawImage(img, sx - drawW / 2, sy - drawH, drawW, drawH);

        if (showNames) {
          // Circulito del color de la facción a la IZQUIERDA del nombre,
          // que a su vez lleva el icono de accion a la derecha — todo el
          // grupo (circulo + nombre + icono) centrado sobre el caminante.
          const label = walker.username + (ACTION_ICONS[walker.action] || '');
          const textW = ctx.measureText(label).width;
          const totalW = WALKER_DOT_DIAMETER + WALKER_DOT_GAP + textW;
          const labelY = sy - drawH - 3;
          const groupLeft = sx - totalW / 2;
          const dotCx = groupLeft + WALKER_DOT_DIAMETER / 2;
          const dotCy = labelY - WALKER_NAME_PX * 0.32;

          ctx.beginPath();
          ctx.arc(dotCx, dotCy, WALKER_DOT_DIAMETER / 2, 0, Math.PI * 2);
          ctx.fillStyle = walker.color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(6,18,26,.85)';
          ctx.stroke();

          // Sombra fina detras del nombre: sobre terreno claro (desierto,
          // nieve) el texto blanco solo se perdia del todo.
          const textX = groupLeft + WALKER_DOT_DIAMETER + WALKER_DOT_GAP;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(6,18,26,.85)';
          ctx.strokeText(label, textX, labelY);
          ctx.fillStyle = '#f5fbff';
          ctx.fillText(label, textX, labelY);
        }
      });
    }

    /**
     * Posiciones actuales, en pixeles de MUNDO — las usa el buscador de
     * jugadores del panel (`focusOnPlayer`) para saltar a donde esta cada uno
     * ahora mismo.
     */
    function getMarkerPositions() {
      const out = new Map();
      walkers.forEach((w, userId) => out.set(userId, { x: w.x, y: w.y, color: w.color, username: w.username }));
      return out;
    }

    /** Hay algo que necesite el bucle de animacion corriendo ahora mismo. */
    function needsAnimationLoop() {
      return walkers.size > 0 || siteWalkers.size > 0 || bossWalkers.size > 0 || cow != null || clouds.length > 0;
    }

    /**
     * Bucle de animacion. Solo corre mientras haga falta (caminantes, la
     * vaca o alguna nube en pantalla): sin partida ni jugadores, antes de que
     * se hornee la primera nube, la capa vuelve a repintarse solo cuando hace
     * falta, sin gastar un frame cada 16ms. Una vez hay nubes (ver
     * spawnCloudBatch(), se siembran solas nada mas cargar la pagina) el
     * bucle practicamente no para nunca, y eso esta bien: es un efecto de
     * cielo pensado para estar siempre ahi.
     */
    function startWalkerLoop() {
      if (walkerLoopRunning || !needsAnimationLoop()) return;
      walkerLoopRunning = true;
      lastFrameAt = performance.now();
      const tick = () => {
        if (!needsAnimationLoop()) { walkerLoopRunning = false; drawObjectLayer(); return; }
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrameAt) / 1000); // techo por si la pestaña estuvo en segundo plano
        lastFrameAt = now;
        stepWalkers(dt, now);
        stepSiteWalkers(dt, now);
        stepBossWalkers(dt, now);
        stepCow(dt, now);
        stepClouds(dt, now);
        drawObjectLayer();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    /**
     * Guarda la decoracion de esta partida (llega en `map:layout`) pasando ya
     * sus coordenadas de celdas de rejilla a pixeles de MUNDO, que es en lo
     * que trabaja el resto de esta capa. No hace falta rejilla espacial como
     * la de `objs`: son ~166 objetos, recorrerlos enteros y descartar los que
     * no se ven cuesta menos que mantener los cubos.
     */
    function setDecorations(list, blockPx) {
      decorBlockPx = blockPx || 1;
      decorations = (list || []).map((d) => ({
        type: d.type,
        wx: d.x * decorBlockPx,
        wy: d.y * decorBlockPx,
      }));
      scheduleRedraw();
    }

    function onViewChanged(mapView) {
      currentView = mapView;
      scheduleRedraw();
    }

    function onResize() {
      resizeCanvas();
      initClouds();
      scheduleRedraw();
    }

    function resizeCanvas() {
      const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
      if (!w || !h) return;
      // devicePixelRatio para que arboles/lineas finas no se vean borrosos en
      // pantallas retina — esta capa (a diferencia de canvasEl) SI se
      // redibuja cada vez, asi que el coste extra de mas pixeles de verdad
      // solo importa aqui, no en el raster de territorios.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      objectsEl.width = Math.round(w * dpr);
      objectsEl.height = Math.round(h * dpr);
      objectsEl.style.width = w + 'px';
      objectsEl.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function scheduleRedraw() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        drawObjectLayer();
      });
    }

    function updateLodTier(scale) {
      if (lodTier === 'none') {
        if (scale >= LOD_NONE_UP) lodTier = scale >= LOD_SMALL_UP ? 'full' : 'small';
      } else if (lodTier === 'small') {
        if (scale < LOD_NONE_DOWN) lodTier = 'none';
        else if (scale >= LOD_SMALL_UP) lodTier = 'full';
      } else {
        if (scale < LOD_SMALL_DOWN) lodTier = scale < LOD_NONE_DOWN ? 'none' : 'small';
      }
    }

    function drawObjectLayer() {
      const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
      if (!w || !h) return;
      if (!objectsEl.width || !objectsEl.height) resizeCanvas();
      ctx.clearRect(0, 0, w, h);

      // Orden de capas dentro de este canvas, de atras hacia delante:
      // decoracion del mapa -> objetos de terreno -> vaca -> caminantes ->
      // nubes. Los caminantes van antes de las nubes pero despues de todo lo
      // demas del suelo para que nunca se los coma un arbol ni un castillo:
      // son lo que hay que poder seguir con la vista. Las nubes van las
      // ULTIMAS de todas, por encima de todo, como corresponde al cielo.
      drawDecorations(w, h);
      drawTerrainObjects(w, h);
      drawSiteWalkers(w, h);
      drawBossWalkers(w, h);
      drawCow(w, h);
      drawWalkers(w, h);
      drawClouds(w, h);
    }

    /** Arboles/rocas/etc. de `objects.bin` (si ese asset llego a generarse). */
    function drawTerrainObjects(w, h) {
      if (!ready || !objs || !objs.count) return;
      // `objects.bin` esta horneado en el espacio de pixeles del MUNDO
      // (8800x4604, ver tools/generateWorldObjects.js) — en cualquier otro
      // mapa (España...) esas mismas coordenadas no significan nada (arboles
      // aparecerian en sitios al azar, la mayoria fuera del lienzo mas
      // pequeño), asi que esta capa solo se pinta cuando el mapa activo es
      // el mundo.
      if (TERRAIN_IMAGE_COLS !== 8800 || TERRAIN_IMAGE_ROWS !== 4604) return;

      const { x: vx, y: vy, scale } = currentView;
      updateLodTier(scale);
      if (lodTier === 'none') return;

      // Rectangulo visible en coordenadas de MUNDO (inverso de screenX =
      // worldX*scale + vx), con colchon extra para que nada aparezca de
      // golpe justo al entrar en pantalla (ver OBJ_VIEWPORT_MARGIN_PX).
      const margin = OBJ_VIEWPORT_MARGIN_PX / scale;
      const wx0 = (0 - vx) / scale - margin;
      const wy0 = (0 - vy) / scale - margin;
      const wx1 = (w - vx) / scale + margin;
      const wy1 = (h - vy) / scale + margin;

      const bx0 = Math.max(0, Math.floor(wx0 / OBJ_GRID_CELL));
      const by0 = Math.max(0, Math.floor(wy0 / OBJ_GRID_CELL));
      const bx1 = Math.min(gridCols - 1, Math.floor(wx1 / OBJ_GRID_CELL));
      const by1 = Math.min(gridRows - 1, Math.floor(wy1 / OBJ_GRID_CELL));
      if (bx1 < bx0 || by1 < by0) return;

      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const bucket = grid.get(bucketKey(bx, by));
          if (!bucket) continue;
          for (const i of bucket) {
            const ox = objs.x[i], oy = objs.y[i], r = objs.r[i], type = objs.type[i];
            if (ox < wx0 || ox > wx1 || oy < wy0 || oy > wy1) continue;
            if (lodTier === 'small' && SMALL_OBJECT_TYPES.has(type)) continue;
            drawObject(type, ox * scale + vx, oy * scale + vy, r * scale, ox, oy);
          }
        }
      }
    }

    /**
     * Dibuja la decoracion de la partida que cae dentro del viewport actual.
     *
     * Optimizacion (es la pregunta de fondo de esta funcion): NO se dibuja el
     * mundo entero cada frame. Se calcula el rectangulo visible en
     * coordenadas de mundo y se descarta todo lo que queda fuera antes de
     * tocar el canvas, asi que el coste va con "cuantos elementos se ven
     * ahora", no con "cuantos hay en el mapa". Con ~166 objetos basta un
     * recorrido lineal — la rejilla espacial de `objs` (pensada para decenas
     * de miles) aqui seria mas cara de mantener que el propio recorrido.
     *
     * Los sprites se anclan por su BASE (abajo-centro), como en cualquier
     * juego 2.5D: asi un castillo alto se apoya en el suelo en vez de quedar
     * centrado sobre su punto, y se dibujan ordenados por Y (los de mas al
     * sur tapan a los de mas al norte) para que el solape entre vecinos se
     * lea como profundidad.
     */
    function drawDecorations(w, h) {
      if (!decorations.length) return;
      const { x: vx, y: vy, scale } = currentView;
      if (scale < DECOR_MIN_SCALE) return;

      const margin = OBJ_VIEWPORT_MARGIN_PX / scale;
      const wx0 = (0 - vx) / scale - margin;
      const wy0 = (0 - vy) / scale - margin;
      const wx1 = (w - vx) / scale + margin;
      const wy1 = (h - vy) / scale + margin;

      const visible = [];
      for (const d of decorations) {
        if (d.wx < wx0 || d.wx > wx1 || d.wy < wy0 || d.wy > wy1) continue;
        visible.push(d);
      }
      visible.sort((a, b) => a.wy - b.wy);

      for (const d of visible) {
        const spec = DECOR_SPRITES[d.type];
        const img = decorImages[d.type];
        if (!spec || !img || !img.complete || !img.naturalWidth) continue;

        const drawW = spec.worldWidth * scale;
        const drawH = drawW * (img.naturalHeight / img.naturalWidth);
        ctx.drawImage(img, d.wx * scale + vx - drawW / 2, d.wy * scale + vy - drawH, drawW, drawH);
      }
    }

    function drawObject(type, sx, sy, sr, worldX, worldY) {
      // sx/sy/sr: posicion y radio ya en pixeles de PANTALLA (post pan/zoom).
      switch (type) {
        case OBJECT_TYPES.TREE_ROUND: return drawTreeRound(sx, sy, sr, '#3a5430', '#567032');
        case OBJECT_TYPES.TREE_PINE_HILL: return drawTreePine(sx, sy, sr, '#364a38', false);
        case OBJECT_TYPES.TREE_PINE_TUNDRA: return drawTreePine(sx, sy, sr, '#46584e', false);
        case OBJECT_TYPES.TREE_PINE_SNOW: return drawTreePine(sx, sy, sr, '#3a4e4a', true);
        case OBJECT_TYPES.ROCK: return drawRock(sx, sy, sr, worldX, worldY);
        case OBJECT_TYPES.BUSH: return drawBush(sx, sy, sr);
        case OBJECT_TYPES.BRANCH_FOREST: return drawBranch(sx, sy, sr, worldX, worldY, '#5a4430');
        case OBJECT_TYPES.BRANCH_DESERT: return drawBranch(sx, sy, sr, worldX, worldY, '#92744e');
        case OBJECT_TYPES.DRIFTWOOD: return drawDriftwood(sx, sy, sr, worldX, worldY);
        case OBJECT_TYPES.SHELL: return drawShell(sx, sy, sr);
        case OBJECT_TYPES.PALM: return drawPalm(sx, sy, sr, worldX, worldY);
        default: return;
      }
    }

    function ellipse(cx, cy, rx, ry, color) {
      if (rx <= 0 || ry <= 0) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawTreeRound(sx, sy, r, colDark, colLight) {
      if (r < 0.6) { ellipse(sx, sy, Math.max(0.6, r), Math.max(0.6, r), colDark); return; }
      ctx.strokeStyle = '#4a3828'; ctx.lineWidth = Math.max(1, r / 4);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy + r * 0.6); ctx.stroke();
      ellipse(sx, sy - r * 0.9, r, r * 0.7, colDark);
      ellipse(sx - r * 0.05, sy - r * 1.0, r * 0.55, r * 0.5, colLight);
    }

    function drawTreePine(sx, sy, r, snow) {
      const col = snow ? '#3a4e4a' : '#354a37';
      if (r < 0.6) { ellipse(sx, sy, Math.max(0.6, r), Math.max(0.6, r), col); return; }
      ctx.strokeStyle = '#42322a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy + r * 0.4); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(sx, sy - r * 2); ctx.lineTo(sx - r * 0.8, sy); ctx.lineTo(sx + r * 0.8, sy); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx, sy - r * 2.5); ctx.lineTo(sx - r * 0.55, sy - r * 0.9); ctx.lineTo(sx + r * 0.55, sy - r * 0.9); ctx.closePath(); ctx.fill();
      if (snow) {
        ctx.strokeStyle = '#e8eef0'; ctx.lineWidth = Math.max(1, r * 0.12);
        ctx.beginPath(); ctx.moveTo(sx - r * 0.35, sy - r * 2.15); ctx.lineTo(sx + r * 0.35, sy - r * 2.15); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx - r * 0.5, sy - r * 0.95); ctx.lineTo(sx + r * 0.5, sy - r * 0.95); ctx.stroke();
      }
    }

    function drawRock(sx, sy, r, worldX, worldY) {
      const tone = Math.round((hash01(worldX, worldY, 1) - 0.5) * 28);
      const c = Math.max(0, Math.min(255, 168 + tone));
      ellipse(sx, sy, r, r * 0.7, `rgb(${c},${Math.max(0, Math.min(255, 158 + tone))},${Math.max(0, Math.min(255, 148 + tone))})`);
    }

    function drawBush(sx, sy, r) {
      ellipse(sx - r * 0.2, sy - r * 0.1, r * 0.8, r * 0.6, '#4e6238');
      ellipse(sx + r * 0.1, sy - r * 0.35, r * 0.7, r * 0.4, '#6e824c');
    }

    function drawBranch(sx, sy, r, worldX, worldY, color) {
      const ang = hash01(worldX, worldY, 2) * Math.PI;
      const dx = Math.cos(ang) * r, dy = Math.sin(ang) * r;
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.beginPath(); ctx.moveTo(sx - dx, sy - dy); ctx.lineTo(sx + dx, sy + dy); ctx.stroke();
    }

    function drawDriftwood(sx, sy, r, worldX, worldY) {
      const ang = hash01(worldX, worldY, 3) * Math.PI;
      const dx = Math.cos(ang) * r, dy = Math.sin(ang) * r * 0.4;
      ctx.strokeStyle = '#785842'; ctx.lineWidth = Math.max(1, r * 0.35);
      ctx.beginPath(); ctx.moveTo(sx - dx, sy - dy); ctx.lineTo(sx + dx, sy + dy); ctx.stroke();
    }

    function drawShell(sx, sy, r) {
      ctx.strokeStyle = '#b08c80'; ctx.lineWidth = Math.max(1, r * 0.3);
      ctx.beginPath(); ctx.arc(sx, sy, r, (20 * Math.PI) / 180, (160 * Math.PI) / 180); ctx.stroke();
    }

    function drawPalm(sx, sy, r, worldX, worldY) {
      const lean = (hash01(worldX, worldY, 4) - 0.5) * 0.6;
      const topX = sx + r * lean * 2, topY = sy - r * 2.2;
      ctx.strokeStyle = '#785a3a'; ctx.lineWidth = Math.max(1, r / 3);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(topX, topY); ctx.stroke();
      ctx.strokeStyle = '#68924c';
      for (const ang of [-60, -25, 10, 45, 80]) {
        const rad = (ang * Math.PI) / 180;
        const tipX = topX + Math.cos(rad) * r * 1.6, tipY = topY + Math.sin(rad) * r * 0.9 - r * 0.3;
        ctx.beginPath(); ctx.moveTo(topX, topY); ctx.lineTo(tipX, tipY); ctx.stroke();
      }
    }

    /** Posicion actual de la vaca y su acompañante (px de mundo), o null si no se ha sembrado todavia. */
    function getCowPosition() {
      return cow ? { x: cow.x, y: cow.y, followerX: cow.follower.x, followerY: cow.follower.y } : null;
    }

    return { onLayout, onViewChanged, onResize, setDecorations, setWalkerWorld, getMarkerPositions, getCowPosition };
  }

  window.CondejorgeMap = { createMapController };
})();
