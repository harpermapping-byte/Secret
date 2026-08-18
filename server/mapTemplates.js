'use strict';

/**
 * Generador de tablero para la demo v1 — el mapa mundial real (silueta de
 * continentes/océanos, ver `server/worldLandMask.js`) dividido en `tileCount`
 * territorios irregulares SOLO sobre tierra — estilo Risk, nada de cuadrícula
 * uniforme, y las piezas no respetan fronteras de países reales (dependen
 * únicamente de cuántas ponga el admin). El océano nunca se reparte: no tiene
 * dueño, no es territorio, es solo el fondo. Las plantillas de mapa "de
 * verdad" (arte final) siguen siendo trabajo futuro (ver docs/GDD, sección
 * 11) — esto sigue siendo placeholder de color, pero ya con la forma real del
 * planeta en vez de un rectángulo abstracto.
 *
 * Cómo se genera (todo determinista dentro de una única pasada, sin librerías
 * de geometría): se colocan `tileCount` puntos semilla, cada uno sobre una
 * celda de tierra distinta (con una distancia mínima entre ellos para que
 * salgan repartidos por el planeta y no amontonados, ver `placeSeedsOnLand`),
 * y luego se rellena un raster fino asignando cada celda de TIERRA a su
 * semilla más cercana — el resultado visual es el mismo efecto que un
 * diagrama de Voronoi, pero recortado a la silueta real y sin tener que
 * calcular polígonos. Las celdas de océano se quedan fuera de cualquier tile
 * (sentinel `OCEAN`). La adyacencia real sale de recorrer el raster una vez y
 * anotar qué territorios de tierra quedan pegados pixel con pixel.
 *
 * Forma de una Tile: { id, neighborIds: [id...], ownerFactionNumber: number|null, neutral: bool, garrison: number }
 * Forma de mapLayout (estático, no cambia durante la partida, se manda al cliente
 * una única vez para poder dibujar el mapa): { cols, rows, cellTileIds: [tileId por celda del raster, o OCEAN], centroids: [{x,y} por tile] }
 */

const { shuffle } = require('./rules/shared');
const { decodeLandMask, COLS: RASTER_COLS, ROWS: RASTER_ROWS } = require('./worldLandMask');

const NEUTRAL_GARRISON = 3;
const OCEAN = -1; // sentinel en cellTileIds: la celda es oceano, no pertenece a ningun tile

// La mascara y la lista de celdas de tierra se decodifican una unica vez al
// cargar el modulo (no por partida) — server/worldLandMask.js seccion "Como
// se genera" tiene el detalle de donde sale esta silueta.
const landMask = decodeLandMask();
const landCells = [];
for (let ry = 0; ry < RASTER_ROWS; ry++) {
  for (let rx = 0; rx < RASTER_COLS; rx++) {
    if (landMask[ry * RASTER_COLS + rx]) landCells.push({ x: rx, y: ry });
  }
}

/**
 * modo: 'total' (todo el mapa repartido, sin neutral) o 'neutral' (zonas pequenas + territorio neutral)
 */
function generateMap({ tileCount, factionCount, mode }) {
  if (factionCount < 2) throw new Error('generateMap: se necesitan al menos 2 facciones');
  if (tileCount < factionCount * 2) throw new Error('generateMap: tileCount demasiado pequenio para factionCount');
  if (tileCount > landCells.length) throw new Error('generateMap: tileCount demasiado grande, no caben tantos territorios en la tierra del mapa');

  const seeds = placeSeedsOnLand(tileCount);
  const { cellTileIds, centroids } = rasterizeLand(seeds, RASTER_COLS, RASTER_ROWS);
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

/**
 * Un punto semilla por tile, cada uno sobre una celda de tierra distinta.
 * Usa muestreo tipo Poisson-disc (rechazar candidatos demasiado cerca de una
 * semilla ya puesta) para que los territorios salgan de tamaño parecido y
 * repartidos por todo el planeta, en vez de amontonados en un solo
 * continente — si con la distancia mínima actual no caben las `tileCount`
 * semillas, se relaja un poco y se reintenta.
 */
function placeSeedsOnLand(tileCount) {
  // Barajar `landCells` (cientos de miles de celdas a esta resolucion) es lo
  // caro de esta funcion, asi que se hace UNA sola vez y se reutiliza el
  // mismo orden en todas las rondas de relajacion de abajo — cada ronda
  // vuelve a examinar la misma lista (algunos candidatos rechazados por
  // estar muy cerca de una semilla pueden pasar en la siguiente ronda, al
  // relajarse `minDist`), pero sin pagar otro barajado completo cada vez.
  const candidates = shuffle(landCells);
  let minDist = Math.sqrt(landCells.length / tileCount) * 0.7;
  const seeds = [];

  for (let round = 0; round < 25 && seeds.length < tileCount; round++) {
    const minDistSq = minDist * minDist;
    for (const candidate of candidates) {
      if (seeds.length >= tileCount) break;
      const farEnough = seeds.every((s) => (s.x - candidate.x) ** 2 + (s.y - candidate.y) ** 2 >= minDistSq);
      if (farEnough) seeds.push(candidate);
    }
    minDist *= 0.8;
  }

  // Fallback si aun faltan (tileCount muy alto relativo al espacio de tierra
  // disponible): se rellena con celdas de tierra libres al azar, sin exigir
  // distancia minima — el orden de `seeds` define el id de cada tile.
  if (seeds.length < tileCount) {
    const used = new Set(seeds.map((s) => `${s.x},${s.y}`));
    for (const candidate of candidates) {
      if (seeds.length >= tileCount) break;
      const key = `${candidate.x},${candidate.y}`;
      if (!used.has(key)) {
        seeds.push(candidate);
        used.add(key);
      }
    }
  }

  return seeds;
}

/** Recorre el raster una vez: cada celda de TIERRA se queda con la semilla mas cercana; el oceano se queda en OCEAN. */
function rasterizeLand(seeds, cols, rows) {
  const cellTileIds = new Array(cols * rows).fill(OCEAN);
  const sums = seeds.map(() => ({ x: 0, y: 0, count: 0 }));

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const idx = ry * cols + rx;
      if (!landMask[idx]) continue; // oceano: no pertenece a ningun tile

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
      cellTileIds[idx] = bestId;
      sums[bestId].x += rx;
      sums[bestId].y += ry;
      sums[bestId].count++;
    }
  }

  const centroids = sums.map((s) => (s.count ? { x: s.x / s.count, y: s.y / s.count } : { x: 0, y: 0 }));
  return { cellTileIds, centroids };
}

/** Dos tiles son vecinos si en algun punto del raster quedan pegados (misma fila/columna, id distinto, ninguno oceano). */
function computeNeighbors(cellTileIds, cols, rows, tileCount) {
  const sets = Array.from({ length: tileCount }, () => new Set());

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const idx = ry * cols + rx;
      const id = cellTileIds[idx];
      if (id === OCEAN) continue;

      if (rx + 1 < cols) {
        const rightId = cellTileIds[idx + 1];
        if (rightId !== id && rightId !== OCEAN) {
          sets[id].add(rightId);
          sets[rightId].add(id);
        }
      }
      if (ry + 1 < rows) {
        const downId = cellTileIds[idx + cols];
        if (downId !== id && downId !== OCEAN) {
          sets[id].add(downId);
          sets[downId].add(id);
        }
      }
    }
  }

  return sets;
}

/**
 * Reparto inicial. 'total': la tierra se corta en `factionCount` bandas
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

module.exports = { generateMap, NEUTRAL_GARRISON, OCEAN };
