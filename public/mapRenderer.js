'use strict';

/**
 * Único módulo del proyecto que sabe dibujar el mapa (rectángulo raster estilo
 * Risk). Lo usan tanto `public/index.html` como `admin/index.html` — ninguna
 * de las dos páginas reimplementa este dibujado por su cuenta. Ver
 * docs/ACCIONES.md sección 6 para la forma de `mapLayout` y de `tiles`.
 *
 * Uso:
 *   const map = CondejorgeMap.createMapController({ viewportEl, canvasEl });
 *   map.setLayout(mapLayoutRecibidoPorWs); // una vez, cuando llega `map:layout`
 *   map.setTiles(state.tiles, state.factions); // cada vez que llega state:public/admin
 *   map.zoom(1.25); map.reset(); // botones +/-/centrar
 */
(function () {
  const BLOCK_PX = 6; // tamaño en pantalla (a escala 1) de cada celda del raster
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

  function createMapController({ viewportEl, canvasEl, showLabels = true }) {
    let layout = null; // { cols, rows, cellTileIds, centroids }
    let offscreen = null; // canvas pequeño (1px por celda de raster) para pintar rapido con ImageData
    let mapView = { x: 0, y: 0, scale: 1 };
    let hasFitOnce = false;
    let dragging = false;
    let dragStart = { x: 0, y: 0, viewX: 0, viewY: 0 };
    let lastTiles = null; // ultimo `state.tiles`/`state.factions` recibidos, por si `map:layout`
    let lastFactions = null; // llega despues de un `state:public`/`state:admin` (el orden de los dos
    // mensajes WS no esta garantizado en todos los casos — ver docs/ACCIONES.md seccion 5).

    function setLayout(newLayout) {
      layout = newLayout;
      offscreen = document.createElement('canvas');
      offscreen.width = layout.cols;
      offscreen.height = layout.rows;

      canvasEl.width = layout.cols * BLOCK_PX;
      canvasEl.height = layout.rows * BLOCK_PX;
      canvasEl.getContext('2d').imageSmoothingEnabled = false;

      hasFitOnce = false;
      if (lastTiles) paint(lastTiles, lastFactions);
    }

    /** tiles: state.tiles (id, neutral, ownerFactionNumber). factions: state.factions (number, color). */
    function setTiles(tiles, factions) {
      lastTiles = tiles;
      lastFactions = factions;
      if (!layout) return; // aun no ha llegado `map:layout` — se pintara en cuanto llegue, ver setLayout()
      paint(tiles, factions);
    }

    function paint(tiles, factions) {
      const colorByTileId = new Array(tiles.length);
      tiles.forEach((t) => {
        if (t.neutral) {
          colorByTileId[t.id] = NEUTRAL_COLOR;
        } else {
          const faction = factions.find((f) => f.number === t.ownerFactionNumber);
          colorByTileId[t.id] = faction ? faction.color : NEUTRAL_COLOR;
        }
      });

      paintRaster(colorByTileId);
      if (showLabels) paintLabels(tiles);

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

      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const idx = ry * cols + rx;
          const tileId = cellTileIds[idx];

          let hex;
          if (tileId === OCEAN) {
            // Oceano: solo se pinta de un color distinto al borde con tierra
            // (linea de costa) si algun vecino es tierra — el resto es oceano liso.
            const touchesLand =
              (rx + 1 < cols && cellTileIds[idx + 1] !== OCEAN) ||
              (ry + 1 < rows && cellTileIds[idx + cols] !== OCEAN) ||
              (rx > 0 && cellTileIds[idx - 1] !== OCEAN) ||
              (ry > 0 && cellTileIds[idx - cols] !== OCEAN);
            hex = touchesLand ? COAST_COLOR : OCEAN_COLOR;
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

            if (touchesOtherTile) {
              hex = BORDER_COLOR;
            } else if (touchesOcean) {
              hex = COAST_COLOR;
            } else {
              // colorByTileId[tileId] puede faltar por un instante justo al
              // recrear partida (un `state:*` con las tiles nuevas puede
              // llegar un mensaje antes que su `map:layout`, ver
              // docs/ACCIONES.md seccion 5) — se pinta neutral ese frame en
              // vez de romper, el siguiente repintado ya lo corrige.
              hex = colorByTileId[tileId] || NEUTRAL_COLOR;
            }
          }
          const rgb = rgbFor(hex, rgbByColor);
          const p = idx * 4;
          image.data[p] = rgb[0];
          image.data[p + 1] = rgb[1];
          image.data[p + 2] = rgb[2];
          image.data[p + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);

      const mainCtx = canvasEl.getContext('2d');
      mainCtx.imageSmoothingEnabled = false;
      mainCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      mainCtx.drawImage(offscreen, 0, 0, cols, rows, 0, 0, canvasEl.width, canvasEl.height);
    }

    function paintLabels(tiles) {
      const ctx = canvasEl.getContext('2d');
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

    function rgbFor(hex, cache) {
      if (cache.has(hex)) return cache.get(hex);
      const value = hex.replace('#', '');
      const rgb = [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
      cache.set(hex, rgb);
      return rgb;
    }

    function applyTransform() {
      canvasEl.style.transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})`;
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

    /** Punto unico por el que pasan reset/zoom/drag: aplica los limites de escala y de paneo siempre juntos. */
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
    return { setLayout, setTiles, zoom, reset };
  }

  window.CondejorgeMap = { createMapController };
})();
