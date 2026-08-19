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
 * Forma de una Tile: { id, neighborIds: [id...], ownerFactionNumber: number|null, neutral: bool, industryCount: number }
 * Forma de mapLayout (estático, no cambia durante la partida, se manda al cliente
 * una única vez para poder dibujar el mapa): { cols, rows, cellTileIds: [tileId por celda del raster, o OCEAN], centroids: [{x,y} por tile] }
 *
 * Resolucion del reparto de territorios vs. resolucion del terreno horneado:
 * `server/worldLandMask.js` (COLS x ROWS, actualmente 8800x4604) es la
 * resolucion a la que se hornea offline `public/terrain/world.png` (ver
 * `tools/bakeWorldTerrain.js`) — el detalle visual de costas/relieve sale
 * ENTERO de ese PNG estatico, que se descarga una vez y no cuesta nada por
 * partida. El reparto de territorios (este archivo) NO necesita esa misma
 * resolucion: el color/borde de cada territorio se pinta como un TINTE
 * semitransparente encima del PNG (ver ALPHA_BY_KIND en
 * public/mapRenderer.js), asi que unas fronteras un poco menos afiladas que
 * la costa real no se notan. Por eso este archivo trabaja sobre una rejilla
 * mucho mas basta (RASTER_COLS x RASTER_ROWS, ver TERRAIN_DOWNSAMPLE) —
 * genera el mapa en milisegundos en vez de segundos, con una fraccion de la
 * RAM, y el `map:layout` que viaja por WebSocket pasa de ~50MB a menos de
 * 1MB. `public/mapRenderer.js` reescala esa rejilla basta hasta el tamaño en
 * pixeles del PNG horneado al dibujar (ver BLOCK_PX ahi) — mismo mecanismo
 * que ya usaba para pasar del raster interno al canvas en pantalla.
 */

const { shuffle } = require('./rules/shared');
const { decodeLandMaskPacked, isLand, COLS: FULL_COLS, ROWS: FULL_ROWS } = require('./worldLandMask');

const OCEAN = -1; // sentinel en cellTileIds: la celda es oceano, no pertenece a ningun tile

// Cuantas celdas del raster horneado (FULL_COLS x FULL_ROWS) equivalen a UNA
// celda de la rejilla de territorios. 8 da 1100x576 (~633K celdas) — de sobra
// para fronteras suaves al zoom maximo del juego (MAX_SCALE=2.5 en
// public/mapRenderer.js; ver el comentario de mas arriba). Subir este numero
// = mapas mas rapidos/ligeros pero fronteras mas bastas; bajarlo = al reves.
const TERRAIN_DOWNSAMPLE = 8;
const RASTER_COLS = Math.round(FULL_COLS / TERRAIN_DOWNSAMPLE);
const RASTER_ROWS = Math.round(FULL_ROWS / TERRAIN_DOWNSAMPLE);

// La mascara y la lista de celdas de tierra se construyen una unica vez al
// cargar el modulo (no por partida) — server/worldLandMask.js seccion "Como
// se genera" tiene el detalle de donde sale esta silueta.
//
// Se lee directamente del Buffer empaquetado (`decodeLandMaskPacked()`, ~5MB)
// en vez de desempaquetar antes la mascara completa a resolucion de horneado
// (`decodeLandMask()`, ~40,5MB y ~1s de CPU) — como esta rejilla solo
// necesita 1 de cada TERRAIN_DOWNSAMPLE^2 celdas, desempaquetar TODO antes
// de tirar el 98% seria trabajo desperdiciado.
//
// `landCellsX`/`landCellsY` van en arrays tipados PAREJOS (no un array de
// objetos {x,y}) por la misma razon de siempre: son mas baratos de barajar
// (ver `shuffleParallel` mas abajo) que un array de objetos JS.
const packedLandMask = decodeLandMaskPacked();
const landMask = new Uint8Array(RASTER_COLS * RASTER_ROWS);
let landCellCount = 0;
for (let ry = 0; ry < RASTER_ROWS; ry++) {
  const fy = Math.min(FULL_ROWS - 1, ry * TERRAIN_DOWNSAMPLE);
  for (let rx = 0; rx < RASTER_COLS; rx++) {
    const fx = Math.min(FULL_COLS - 1, rx * TERRAIN_DOWNSAMPLE);
    if (isLand(packedLandMask, fx, fy)) {
      landMask[ry * RASTER_COLS + rx] = 1;
      landCellCount++;
    }
  }
}
const landCellsX = new Int32Array(landCellCount);
const landCellsY = new Int32Array(landCellCount);
{
  let k = 0;
  for (let ry = 0; ry < RASTER_ROWS; ry++) {
    for (let rx = 0; rx < RASTER_COLS; rx++) {
      if (landMask[ry * RASTER_COLS + rx]) { landCellsX[k] = rx; landCellsY[k] = ry; k++; }
    }
  }
}

/** Fisher-Yates in-place, pero sobre DOS arrays tipados en paralelo (misma permutacion en ambos) — equivalente a `shuffle()` de rules/shared.js, que no sirve aqui porque necesitamos mover x[i] e y[i] juntos, no dos barajados independientes. */
function shuffleParallel(xs, ys) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    let t = xs[i]; xs[i] = xs[j]; xs[j] = t;
    t = ys[i]; ys[i] = ys[j]; ys[j] = t;
  }
}

/**
 * modo: 'total' (todo el mapa repartido, sin neutral) o 'neutral' (zonas pequenas + territorio neutral)
 */
function generateMap({ tileCount, factionCount, mode }) {
  if (factionCount < 2) throw new Error('generateMap: se necesitan al menos 2 facciones');
  if (tileCount < factionCount * 2) throw new Error('generateMap: tileCount demasiado pequenio para factionCount');
  if (tileCount > landCellsX.length) throw new Error('generateMap: tileCount demasiado grande, no caben tantos territorios en la tierra del mapa');

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
      // Edificios de industria levantados sobre esta casilla (uno por cada
      // `!industria` que haya salido aqui, ver rules/industry.js). Vive en la
      // CASILLA y no en la faccion a proposito: asi, cuando la casilla se
      // conquista, su industria se va con ella al nuevo dueño sin codigo
      // extra — ver docs/GDD seccion 6 "Industria".
      industryCount: 0,
    });
  }

  const mapLayout = {
    cols: RASTER_COLS,
    rows: RASTER_ROWS,
    cellTileIds,
    centroids,
    decorations: placeDecorations(),
  };
  return { tiles, mode, mapLayout };
}

// ---------------------------------------------------------------------------
// Decoracion del mapa (castillos, puertos, aldeas, arboles, barcos, ballenas,
// kraken). Ver docs/ACCIONES.md seccion 11.
// ---------------------------------------------------------------------------

/**
 * Cuantos elementos de cada tipo se reparten por partida y donde puede caer
 * cada uno. La clave es EXACTAMENTE el nombre del PNG en `public/sprites/`
 * (ver tools/bakeSpritePlaceholders.js): el cliente monta la ruta a partir de
 * ella, asi que añadir un tipo nuevo es añadir una fila aqui y su .png — sin
 * tocar el codigo del cliente.
 *
 *   terrain: 'land'  -> cualquier celda de tierra
 *            'coast' -> celda de tierra que toca el agua (para los puertos)
 *            'water' -> cualquier celda de oceano
 *   minGap: separacion minima entre elementos DEL MISMO TIPO, en celdas de la
 *           rejilla, para que no salgan amontonados en un pegote.
 */
const DECORATION_KINDS = [
  { type: 'castle', count: 10, terrain: 'land', minGap: 40 },
  { type: 'port', count: 15, terrain: 'coast', minGap: 30 },
  { type: 'village', count: 20, terrain: 'land', minGap: 22 },
  { type: 'tree', count: 100, terrain: 'land', minGap: 8 },
  { type: 'ship-small', count: 10, terrain: 'water', minGap: 40 },
  { type: 'ship-big', count: 5, terrain: 'water', minGap: 60 },
  { type: 'whale', count: 5, terrain: 'water', minGap: 60 },
  { type: 'kraken', count: 1, terrain: 'water', minGap: 0 },
];

// Cuantos intentos como mucho por elemento antes de rendirse y colocarlo sin
// respetar la separacion minima. Evita que un mapa con poca costa (o un
// minGap demasiado exigente) deje el generador dando vueltas para siempre.
const DECOR_MAX_TRIES = 400;

function isLandCell(x, y) {
  return landMask[y * RASTER_COLS + x] === 1;
}

/** Celda de tierra con al menos un vecino (4-conectado) de agua: la orilla. */
function isCoastCell(x, y) {
  if (!isLandCell(x, y)) return false;
  return (
    (x > 0 && !isLandCell(x - 1, y)) ||
    (x < RASTER_COLS - 1 && !isLandCell(x + 1, y)) ||
    (y > 0 && !isLandCell(x, y - 1)) ||
    (y < RASTER_ROWS - 1 && !isLandCell(x, y + 1))
  );
}

function matchesTerrain(kind, x, y) {
  if (kind === 'land') return isLandCell(x, y);
  if (kind === 'water') return !isLandCell(x, y);
  return isCoastCell(x, y);
}

/**
 * Reparte los elementos decorativos por el mapa, distinto en cada partida.
 * Se generan EN EL SERVIDOR (no en cada navegador) para que el streamer y
 * todos los espectadores vean exactamente la misma decoracion; viajan una
 * unica vez dentro del mensaje `map:layout`, y son tan pocos (~166 objetos,
 * unos pocos KB) que no se notan al lado de la rejilla del mapa.
 *
 * Coordenadas en celdas de la rejilla del mapa (las mismas que `centroids`),
 * no en pixeles de pantalla: el cliente las escala con el zoom como el resto
 * del terreno.
 */
function placeDecorations() {
  const decorations = [];

  for (const { type, count, terrain, minGap } of DECORATION_KINDS) {
    const placed = [];
    const minGapSq = minGap * minGap;

    for (let n = 0; n < count; n++) {
      let best = null;
      for (let attempt = 0; attempt < DECOR_MAX_TRIES; attempt++) {
        const x = Math.floor(Math.random() * RASTER_COLS);
        const y = Math.floor(Math.random() * RASTER_ROWS);
        if (!matchesTerrain(terrain, x, y)) continue;
        best = { x, y }; // vale como plan B aunque quede pegado a otro
        if (placed.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= minGapSq)) break;
      }
      if (!best) continue; // no hay sitio de ese terreno (mapa raro): se deja fuera
      placed.push(best);
      decorations.push({ type, x: best.x, y: best.y });
    }
  }

  return decorations;
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
  // Barajar las celdas de tierra (arrays tipados paralelos, ver
  // `shuffleParallel` mas arriba — millones de celdas a esta resolucion) es
  // lo caro de esta funcion, asi que se hace UNA sola vez y se reutiliza el
  // mismo orden en todas las rondas de relajacion de abajo — cada ronda
  // vuelve a examinar la misma lista (algunos candidatos rechazados por
  // estar muy cerca de una semilla pueden pasar en la siguiente ronda, al
  // relajarse `minDist`), pero sin pagar otro barajado completo cada vez.
  shuffleParallel(landCellsX, landCellsY);
  let minDist = Math.sqrt(landCellsX.length / tileCount) * 0.7;
  const seeds = [];

  for (let round = 0; round < 25 && seeds.length < tileCount; round++) {
    const minDistSq = minDist * minDist;
    for (let ci = 0; ci < landCellsX.length; ci++) {
      if (seeds.length >= tileCount) break;
      const cx = landCellsX[ci], cy = landCellsY[ci];
      const farEnough = seeds.every((s) => (s.x - cx) ** 2 + (s.y - cy) ** 2 >= minDistSq);
      if (farEnough) seeds.push({ x: cx, y: cy });
    }
    minDist *= 0.8;
  }

  // Fallback si aun faltan (tileCount muy alto relativo al espacio de tierra
  // disponible): se rellena con celdas de tierra libres al azar, sin exigir
  // distancia minima — el orden de `seeds` define el id de cada tile.
  if (seeds.length < tileCount) {
    const used = new Set(seeds.map((s) => `${s.x},${s.y}`));
    for (let ci = 0; ci < landCellsX.length; ci++) {
      if (seeds.length >= tileCount) break;
      const cx = landCellsX[ci], cy = landCellsY[ci];
      const key = `${cx},${cy}`;
      if (!used.has(key)) {
        seeds.push({ x: cx, y: cy });
        used.add(key);
      }
    }
  }

  return seeds;
}

/**
 * Reparto tipo Voronoi por inundacion multi-fuente (BFS), NO "semilla mas
 * cercana por fuerza bruta" celda a celda contra TODAS las semillas — esa
 * fuerza bruta es O(celdas_de_tierra * numero_de_tiles), que a la resolucion
 * del raster real (8800x4604, ver server/worldLandMask.js) son miles de
 * millones de comparaciones y tardaba ~26s por partida (medido al subir la
 * resolucion del mapa), justo el tipo de regresion de "Iniciar partida" que
 * ya se corrigio una vez en este proyecto (ver docs/ACCIONES.md seccion 8,
 * horneado de terreno). El BFS multi-fuente visita cada celda de tierra UNA
 * vez — O(celdas_de_tierra), independiente de cuantos tiles haya — a costa
 * de que la metrica de distancia pasa de euclidea exacta a "tablero de
 * ajedrez" (8 vecinos), indistinguible a ojo para fronteras irregulares
 * estilo Risk como estas.
 */
function rasterizeLand(seeds, cols, rows) {
  const cellTileIds = new Int32Array(cols * rows).fill(OCEAN);
  const sums = seeds.map(() => ({ x: 0, y: 0, count: 0 }));

  const queueX = new Int32Array(landCellsX.length);
  const queueY = new Int32Array(landCellsX.length);
  let qHead = 0, qTail = 0;

  for (let i = 0; i < seeds.length; i++) {
    const sx = seeds[i].x, sy = seeds[i].y;
    const idx = sy * cols + sx;
    if (cellTileIds[idx] !== OCEAN) continue; // semilla duplicada, defensivo
    cellTileIds[idx] = i;
    queueX[qTail] = sx; queueY[qTail] = sy; qTail++;
  }

  while (qHead < qTail) {
    const x = queueX[qHead], y = queueY[qHead];
    const id = cellTileIds[y * cols + x];
    qHead++;
    sums[id].x += x; sums[id].y += y; sums[id].count++;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= cols) continue;
        const ni = ny * cols + nx;
        if (!landMask[ni] || cellTileIds[ni] !== OCEAN) continue;
        cellTileIds[ni] = id;
        queueX[qTail] = nx; queueY[qTail] = ny; qTail++;
      }
    }
  }

  // El BFS solo alcanza tierra CONECTADA a una semilla — islas pequeñas sin
  // semilla propia (hay miles a esta resolucion) se quedan sin visitar y
  // seguirian marcadas OCEAN, "perdidas" como si no fueran territorio de
  // nadie. Se rellenan aparte con fuerza bruta de verdad, pero SOLO sobre
  // estas celdas sobrantes (unos cientos de miles, no los millones de tierra
  // totales), así que sigue siendo barato.
  for (let k = 0; k < landCellsX.length; k++) {
    const rx = landCellsX[k], ry = landCellsY[k];
    const idx = ry * cols + rx;
    if (cellTileIds[idx] !== OCEAN) continue;
    let bestId = 0;
    let bestDist = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const dx = seeds[i].x - rx, dy = seeds[i].y - ry;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; bestId = i; }
    }
    cellTileIds[idx] = bestId;
    sums[bestId].x += rx; sums[bestId].y += ry; sums[bestId].count++;
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

module.exports = { generateMap, OCEAN };
