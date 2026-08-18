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
  // Tamaño en pantalla (a escala 1) de cada celda del raster. El raster en sí
  // (server/worldLandMask.js) es 4400x2302 celdas (el doble de detalle que la
  // version anterior, 2200x1151) — este valor esta en 1 para que el canvas
  // final en pantalla no cambie de tamaño (4400*1=4400 x 2302*1=2302px, ~10M
  // pixeles, el mismo presupuesto de siempre) mientras el raster en si trae
  // el doble de detalle nativo (bordes/costas mas finos sin tener que
  // reescalar con nearest-neighbor).
  const BLOCK_PX = 1;
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
  // facción: hasta PLAYERS_PER_RING por anillo, cada anillo un poco mas lejos
  // del centro — ver computePlayerMarkers(). Valores en celdas de raster
  // (equivalen a px a escala 1, ya que BLOCK_PX=1).
  const PLAYERS_PER_RING = 8;
  const MARKER_RING_BASE_RADIUS = 26;
  const MARKER_RING_STEP = 24;
  const MARKER_SIZE = 7; // "radio" del triangulo del marcador

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
    let lastTiles = null; // ultimo `state.tiles`/`state.factions`/`state.players` recibidos, por si `map:layout`
    let lastFactions = null; // llega despues de un `state:public`/`state:admin` (el orden de los
    let lastPlayers = null; // mensajes WS no esta garantizado en todos los casos — ver docs/ACCIONES.md seccion 5).
    let lastRasterFingerprint = null; // ver paint(): evita repintar el raster si la propiedad de las casillas no cambio
    let lastMarkerPositions = new Map(); // userId -> {x,y,color,username}, cacheado para focusOnPlayer()

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
      offscreen = document.createElement('canvas');
      offscreen.width = layout.cols;
      offscreen.height = layout.rows;

      canvasEl.width = layout.cols * BLOCK_PX;
      canvasEl.height = layout.rows * BLOCK_PX;
      canvasEl.getContext('2d').imageSmoothingEnabled = false;

      if (markersEl) {
        markersEl.width = canvasEl.width;
        markersEl.height = canvasEl.height;
      }

      // El terreno horneado es estatico (mismo planeta real en toda partida,
      // ver tools/bakeWorldTerrain.js) — se carga una vez, a tamaño natural
      // (mismo nº de pixeles que el raster, asi que el MISMO transform de
      // canvasEl lo deja alineado sin reescalar, ver applyTransform()).
      if (terrainBgEl && !terrainBgEl.src) terrainBgEl.src = '/terrain/world.png';

      cellRenderKind = computeCellRenderKind(layout);
      lastRasterFingerprint = null; // fuerza el repintado del raster la primera vez con este layout

      if (objectLayer) objectLayer.onLayout(layout);

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

    /** tiles: state.tiles (id, neutral, ownerFactionNumber). factions: state.factions (number, color). players: state.players. */
    function setTiles(tiles, factions, players) {
      lastTiles = tiles;
      lastFactions = factions;
      lastPlayers = players || [];
      if (!layout) return; // aun no ha llegado `map:layout` — se pintara en cuanto llegue, ver setLayout()
      paint(tiles, factions, lastPlayers);
    }

    function paint(tiles, factions, players) {
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

      paintOverlay(tiles, factions, players);

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
      mainCtx.imageSmoothingEnabled = false;
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
    function paintOverlay(tiles, factions, players) {
      if (!markersEl) return;
      const ctx = markersEl.getContext('2d');
      ctx.clearRect(0, 0, markersEl.width, markersEl.height);
      if (showLabels) paintTileLabels(ctx, tiles);
      paintPlayerMarkers(ctx, tiles, factions, players);
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
     * Un triangulo del color de su facción por jugador vivo, agrupado
     * alrededor del centroide del territorio de su facción (ver
     * computePlayerMarkers()), con su nombre encima en texto pequeño — solo
     * se lee bien haciendo zoom, a proposito, para no saturar el mapa a
     * vista general. Esqueleto v1: la posicion es estatica mientras el
     * jugador siga vivo en la misma facción; las animaciones de movimiento
     * por ataque/defensa/industria son trabajo futuro (ver docs/ACCIONES.md).
     * Si el jugador muere (`alive: false`) su marcador deja de dibujarse.
     */
    function paintPlayerMarkers(ctx, tiles, factions, players) {
      const markers = computePlayerMarkers(players, factions, tiles);
      lastMarkerPositions = markers;
      markers.forEach((m) => {
        const cx = m.x * BLOCK_PX;
        const cy = m.y * BLOCK_PX;
        drawTriangleMarker(ctx, cx, cy, m.color);
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillStyle = '#f5fbff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(m.username, cx, cy - MARKER_SIZE - 2);
      });
    }

    function drawTriangleMarker(ctx, cx, cy, color) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - MARKER_SIZE);
      ctx.lineTo(cx - MARKER_SIZE * 0.87, cy + MARKER_SIZE * 0.5);
      ctx.lineTo(cx + MARKER_SIZE * 0.87, cy + MARKER_SIZE * 0.5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#04141c';
      ctx.stroke();
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
     * mapa, la usan tanto `computePlayerMarkers()` como cualquier futuro
     * codigo que necesite "el centro" de una facción.
     */
    function computeFactionCentroid(tiles, factionNumber) {
      const owned = tiles.filter((t) => !t.neutral && t.ownerFactionNumber === factionNumber);
      if (owned.length === 0) return null;
      const anchorTile = owned.reduce((a, b) => (a.id <= b.id ? a : b));
      return layout.centroids[anchorTile.id] || null;
    }

    /**
     * Posicion de marcador (coordenadas de raster) por jugador vivo, en un
     * Map<userId, {x,y,color,username}> — unica funcion del proyecto que
     * calcula esto, la usan tanto el pintado (paintPlayerMarkers) como la
     * busqueda (focusOnPlayer) para no tener dos fuentes de verdad distintas
     * sobre "donde esta" el marcador de un jugador.
     */
    function computePlayerMarkers(players, factions, tiles) {
      const markers = new Map();
      const aliveByFaction = new Map();
      (players || []).forEach((p) => {
        if (!p.alive) return; // sin marcador si el jugador ha muerto
        if (!aliveByFaction.has(p.factionNumber)) aliveByFaction.set(p.factionNumber, []);
        aliveByFaction.get(p.factionNumber).push(p);
      });

      aliveByFaction.forEach((roster, factionNumber) => {
        const centroid = computeFactionCentroid(tiles, factionNumber);
        if (!centroid) return; // facción sin territorio (no deberia pasar, pero por si acaso)
        const faction = (factions || []).find((f) => f.number === factionNumber);
        const color = faction ? faction.color : NEUTRAL_COLOR;
        roster.forEach((p, i) => {
          const ring = Math.floor(i / PLAYERS_PER_RING);
          const posInRing = i % PLAYERS_PER_RING;
          const countInRing = Math.min(PLAYERS_PER_RING, roster.length - ring * PLAYERS_PER_RING);
          const angle = (2 * Math.PI * posInRing) / countInRing;
          const radius = MARKER_RING_BASE_RADIUS + ring * MARKER_RING_STEP;
          markers.set(p.userId, {
            x: centroid.x + radius * Math.cos(angle),
            y: centroid.y + radius * Math.sin(angle),
            color,
            username: p.username,
          });
        });
      });

      return markers;
    }

    /**
     * Busca un jugador por nombre (exacto o parcial, sin mayusculas/minusculas)
     * entre los vivos con marcador en el mapa, y centra la vista ahí con un
     * zoom cómodo — usado por la caja de búsqueda del panel de jugadores.
     * Devuelve `true` si encontró y centró, `false` si no hay ningún jugador
     * vivo con ese nombre (con marcador dibujado).
     */
    function focusOnPlayer(username) {
      if (!layout || !username) return false;
      const needle = username.trim().toLowerCase();
      if (!needle) return false;

      let target = null;
      for (const [, m] of lastMarkerPositions) {
        if (m.username.toLowerCase() === needle) {
          target = m;
          break;
        }
      }
      if (!target) {
        for (const [, m] of lastMarkerPositions) {
          if (m.username.toLowerCase().includes(needle)) {
            target = m;
            break;
          }
        }
      }
      if (!target) return false;

      const cx = target.x * BLOCK_PX;
      const cy = target.y * BLOCK_PX;
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

    function zoom(factor) {
      setView(mapView.scale * factor, mapView.x, mapView.y);
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
          zoom(e.deltaY < 0 ? 1.1 : 0.9);
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
    return { setLayout, setTiles, zoom, reset, focusOnPlayer };
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

    const ctx = objectsEl.getContext('2d');

    fetch('/terrain/objects.bin')
      .then((r) => r.arrayBuffer())
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
      scheduleRedraw();
    }

    function onViewChanged(mapView) {
      currentView = mapView;
      scheduleRedraw();
    }

    function onResize() {
      resizeCanvas();
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
      if (!ready || !objs || !objs.count) return;

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

    return { onLayout, onViewChanged, onResize };
  }

  window.CondejorgeMap = { createMapController };
})();
