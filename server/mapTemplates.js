'use strict';

/**
 * Generador de tablero placeholder para la demo v1 — estilo Risk: un rectángulo
 * dividido en `tileCount` territorios irregulares (nada de cuadrícula uniforme).
 * Las plantillas de mapa "de verdad" (arte + diseño a mano) son trabajo futuro
 * (ver docs/GDD, sección 11). Mientras tanto, esto reemplaza al anillo anterior
 * y es también quien decide la adyacencia REAL del motor: dos territorios son
 * vecinos si sus formas se tocan en el rectángulo (ver docs/ACCIONES.md).
 *
 * Cómo se genera (todo determinista dentro de una única pasada, sin librerías
 * de geometría): se colocan `tileCount` puntos semilla repartidos por el
 * rectángulo (una rejilla aproximada con una posición aleatoria dentro de cada
 * casilla de esa rejilla, para que no queden alineados), y luego se rellena un
 * raster fino asignando cada punto del raster a su semilla más cercana — el
 * resultado visual es el mismo efecto que un diagrama de Voronoi, pero sin
 * tener que calcular polígonos. La adyacencia real sale de recorrer el raster
 * una vez y anotar qué territorios quedan pegados pixel con pixel.
 *
 * Forma de una Tile: { id, neighborIds: [id...], ownerFactionNumber: number|null, neutral: bool, garrison: number }
 * Forma de mapLayout (estático, no cambia durante la partida, se manda al cliente
 * una única vez para poder dibujar el rectángulo): { cols, rows, cellTileIds: [tileId por celda del raster], centroids: [{x,y} por tile] }
 */

const { shuffle } = require('./rules/shared');

const NEUTRAL_GARRISON = 3;
// Resolucion del raster: a mas celdas, fronteras mas finas al hacer zoom (el
// mapa ahora se comporta como un fondo tipo Google Maps sobre el que se hace
// zoom de cerca, ver public/mapRenderer.js). Se duplico frente a la version
// anterior (220x140) porque generar el mapa sigue siendo barato (rasterize
// es O(tileCount * cols * rows) pero solo se ejecuta una vez por partida,
// no por frame: ~60ms para 60 tiles con esta resolucion, medido a mano).
const RASTER_COLS = 440;
const RASTER_ROWS = 280;

/**
 * modo: 'total' (todo el mapa repartido, sin neutral) o 'neutral' (zonas pequenas + territorio neutral)
 */
function generateMap({ tileCount, factionCount, mode }) {
  if (factionCount < 2) throw new Error('generateMap: se necesitan al menos 2 facciones');
  if (tileCount < factionCount * 2) throw new Error('generateMap: tileCount demasiado pequenio para factionCount');

  const seeds = placeSeeds(tileCount, RASTER_COLS, RASTER_ROWS);
  const { cellTileIds, centroids } = rasterize(seeds, RASTER_COLS, RASTER_ROWS);
  const neighborSets = computeNeighbors(cellTileIds, RASTER_COLS, RASTER_ROWS, tileCount);
  const ownerByTile = assignInitialOwners({ tileCount, factionCount, mode, seeds, neighborSets });

  const tiles = [];
  for (let i = 0; i < tileCount; i++) {
    const owner = ownerByTile[i];
    tiles.push({
      id: i,
      neighborIds: [...neighborSets[i]],
      ownerFactionNumber: owner,
      neutral: owner === null,
      garrison: owner === null ? NEUTRAL_GARRISON : 0,
    });
  }

  const mapLayout = { cols: RASTER_COLS, rows: RASTER_ROWS, cellTileIds, centroids };
  return { tiles, mode, mapLayout };
}

/** Un punto semilla por tile, repartido en una rejilla aproximada con jitter para que las formas salgan irregulares. */
function placeSeeds(tileCount, rasterCols, rasterRows) {
  const gridCols = Math.max(1, Math.ceil(Math.sqrt(tileCount * (rasterCols / rasterRows))));
  const gridRows = Math.max(1, Math.ceil(tileCount / gridCols));
  const cellW = rasterCols / gridCols;
  const cellH = rasterRows / gridRows;

  const slots = [];
  for (let gy = 0; gy < gridRows; gy++) {
    for (let gx = 0; gx < gridCols; gx++) slots.push({ gx, gy });
  }
  const chosenSlots = shuffle(slots).slice(0, tileCount);

  // El orden de `seeds` define el id de cada tile (seeds[i] -> tile id i).
  return chosenSlots.map(({ gx, gy }) => ({
    x: gx * cellW + cellW * (0.2 + Math.random() * 0.6),
    y: gy * cellH + cellH * (0.2 + Math.random() * 0.6),
  }));
}

/** Recorre el raster una vez: cada celda se queda con la semilla mas cercana. */
function rasterize(seeds, cols, rows) {
  const cellTileIds = new Array(cols * rows);
  const sums = seeds.map(() => ({ x: 0, y: 0, count: 0 }));

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const px = rx + 0.5;
      const py = ry + 0.5;
      let bestId = 0;
      let bestDist = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const dx = seeds[i].x - px;
        const dy = seeds[i].y - py;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestId = i;
        }
      }
      cellTileIds[ry * cols + rx] = bestId;
      sums[bestId].x += rx;
      sums[bestId].y += ry;
      sums[bestId].count++;
    }
  }

  const centroids = sums.map((s) => (s.count ? { x: s.x / s.count, y: s.y / s.count } : { x: 0, y: 0 }));
  return { cellTileIds, centroids };
}

/** Dos tiles son vecinos si en algun punto del raster quedan pegados (misma fila/columna, id distinto). */
function computeNeighbors(cellTileIds, cols, rows, tileCount) {
  const sets = Array.from({ length: tileCount }, () => new Set());

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const idx = ry * cols + rx;
      const id = cellTileIds[idx];

      if (rx + 1 < cols) {
        const rightId = cellTileIds[idx + 1];
        if (rightId !== id) {
          sets[id].add(rightId);
          sets[rightId].add(id);
        }
      }
      if (ry + 1 < rows) {
        const downId = cellTileIds[idx + cols];
        if (downId !== id) {
          sets[id].add(downId);
          sets[downId].add(id);
        }
      }
    }
  }

  return sets;
}

/**
 * Reparto inicial. 'total': el rectangulo se corta en `factionCount` bandas
 * verticales (por posicion X de la semilla de cada tile), sin territorio neutral.
 * 'neutral': cada faccion recibe una tile "capital" al azar dentro de su banda
 * mas una tile vecina suya (vecindad real, ver computeNeighbors) — el resto
 * del mapa queda neutral.
 */
function assignInitialOwners({ tileCount, factionCount, mode, seeds, neighborSets }) {
  const orderByX = [...Array(tileCount).keys()].sort((a, b) => seeds[a].x - seeds[b].x);
  const bandSize = Math.ceil(tileCount / factionCount);

  if (mode === 'total') {
    const owner = new Array(tileCount).fill(null);
    orderByX.forEach((tileId, index) => {
      const factionIndex = Math.min(factionCount - 1, Math.floor(index / bandSize));
      owner[tileId] = factionIndex + 1;
    });
    return owner;
  }

  const owner = new Array(tileCount).fill(null);
  const used = new Set();

  for (let f = 0; f < factionCount; f++) {
    const bandTiles = shuffle(orderByX.slice(f * bandSize, (f + 1) * bandSize).filter((id) => !used.has(id)));
    const fallback = orderByX.find((id) => !used.has(id));
    const capital = bandTiles[0] ?? fallback;
    if (capital == null) continue;
    owner[capital] = f + 1;
    used.add(capital);

    const neighborCandidates = shuffle([...neighborSets[capital]].filter((id) => !used.has(id)));
    const second = neighborCandidates[0] ?? orderByX.find((id) => !used.has(id));
    if (second != null) {
      owner[second] = f + 1;
      used.add(second);
    }
  }

  return owner;
}

module.exports = { generateMap, NEUTRAL_GARRISON };
