'use strict';

/**
 * Único módulo del proyecto que sabe dibujar el mapa (rectángulo raster estilo
 * Risk). Lo usan tanto `public/index.html` como `admin/index.html` — ninguna
 * de las dos páginas reimplementa este dibujado por su cuenta. Ver
 * docs/ACCIONES.md sección 6 para la forma de `mapLayout`, `tiles` y `players`.
 *
 * Uso:
 *   const map = CondejorgeMap.createMapController({ viewportEl, canvasEl, markersEl });
 *   map.setLayout(mapLayoutRecibidoPorWs); // una vez, cuando llega `map:layout`
 *   map.setTiles(state.tiles, state.factions, state.players); // cada vez que llega state:public/admin
 *   map.zoom(1.25); map.reset(); // botones +/-/centrar
 *   map.focusOnPlayer('nombre'); // buscador del panel de jugadores
 *
 * Dos canvases superpuestos (mismo tamaño, mismo transform aplicado a los dos
 * a la vez, ver applyTransform()):
 *   - `canvasEl` (`#mapCanvas`): el raster de tierra/océano/fronteras. Caro de
 *     repintar (recorre cada celda del raster), así que solo se repinta de
 *     verdad cuando cambia qué facción es dueña de cada casilla — ver
 *     `paint()` y el "fingerprint" de propiedad.
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

  function createMapController({ viewportEl, canvasEl, markersEl, showLabels = true }) {
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

    function setLayout(newLayout) {
      layout = newLayout;
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

      cellRenderKind = computeCellRenderKind(layout);
      lastRasterFingerprint = null; // fuerza el repintado del raster la primera vez con este layout

      hasFitOnce = false;
      if (lastTiles) paint(lastTiles, lastFactions, lastPlayers);
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
        image.data[p + 3] = 255;
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
        if (!canvasEl.width) return;
        setView(mapView.scale, mapView.x, mapView.y);
      });
    }

    setupInteraction();
    return { setLayout, setTiles, zoom, reset, focusOnPlayer };
  }

  window.CondejorgeMap = { createMapController };
})();
