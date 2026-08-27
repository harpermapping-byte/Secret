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
const worldLandMaskMod = require('./worldLandMask');
const iberiaLandMaskMod = require('./iberiaLandMask');

const OCEAN = -1; // sentinel en cellTileIds: la celda es oceano, no pertenece a ningun tile

// Cuantas celdas del raster horneado equivalen a UNA celda de la rejilla de
// territorios. 8 da fronteras suaves al zoom maximo del juego (MAX_SCALE=2.5
// en public/mapRenderer.js) sin tener que barajar millones de celdas por
// partida. Subir este numero = mapas mas rapidos/ligeros pero fronteras mas
// bastas; bajarlo = al reves. Mismo valor para todos los mapas (ver
// MAP_SOURCES) para que el "grano" de frontera se sienta igual en cualquiera.
const TERRAIN_DOWNSAMPLE = 8;
const WORLD_EQUATOR_CIRCUMFERENCE_KM = 40075;

/**
 * Un "source" es todo lo que generateMap() necesita de UN mapa concreto
 * (mundo entero, España...): su rejilla de tierra/oceano ya reducida a
 * resolucion de territorio, la lista plana de celdas de tierra (para
 * sortear semillas), y las medidas del PNG horneado que el cliente tiene
 * que cargar de fondo (ver mapLayout.terrainFile/terrainImageCols/Rows,
 * consumidos por setLayout() en public/mapRenderer.js). Se calcula una
 * UNICA vez por mapa (no por partida) y se cachea — construir la mascara
 * reducida es la unica parte cara (recorrer millones de celdas), y es la
 * misma sea cual sea tileCount/factionCount de la partida.
 */
const mapSourceCache = new Map();

function buildSourceFromMask(decodeFn, fullCols, fullRows, isLandFn, fullWidthKm) {
  const cols = Math.round(fullCols / TERRAIN_DOWNSAMPLE);
  const rows = Math.round(fullRows / TERRAIN_DOWNSAMPLE);
  const landMask = new Uint8Array(cols * rows);
  let landCellCount = 0;
  const full = decodeFn();
  for (let ry = 0; ry < rows; ry++) {
    const fy = Math.min(fullRows - 1, ry * TERRAIN_DOWNSAMPLE);
    for (let rx = 0; rx < cols; rx++) {
      const fx = Math.min(fullCols - 1, rx * TERRAIN_DOWNSAMPLE);
      if (isLandFn(full, fx, fy)) { landMask[ry * cols + rx] = 1; landCellCount++; }
    }
  }
  const landCellsX = new Int32Array(landCellCount);
  const landCellsY = new Int32Array(landCellCount);
  let k = 0;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      if (landMask[ry * cols + rx]) { landCellsX[k] = rx; landCellsY[k] = ry; k++; }
    }
  }
  // Km reales por celda de ESTA rejilla de territorio — necesario para poder
  // pedir "conecta costas a menos de X km" en km reales sin importar la
  // resolución/escala de cada mapa (ver SEA_ADJACENCY_REACH_KM mas abajo).
  const kmPerCell = (fullWidthKm / fullCols) * TERRAIN_DOWNSAMPLE;
  return { cols, rows, landMask, landCellsX, landCellsY, kmPerCell };
}

// Definicion de cada mapa jugable: como reducir su mascara real a rejilla de
// territorio, y que PNG horneado le corresponde de fondo en el cliente (ver
// tools/bakeWorldTerrain.js y la generacion equivalente de España, misma
// tecnica y parametros). Añadir un mapa nuevo en el futuro es añadir una
// entrada aqui, sin tocar el resto de este archivo.
const MAP_SOURCE_DEFS = {
  world: {
    label: 'Mundo',
    // Se lee directamente del Buffer empaquetado (`decodeLandMaskPacked()`,
    // ~5MB) en vez de desempaquetar antes la mascara completa de horneado
    // (`decodeLandMask()`, ~40,5MB y ~1s de CPU) — como esta rejilla solo
    // necesita 1 de cada TERRAIN_DOWNSAMPLE² celdas, desempaquetar TODO
    // antes de tirar el 98% seria trabajo desperdiciado.
    build: () => buildSourceFromMask(
      worldLandMaskMod.decodeLandMaskPacked, worldLandMaskMod.COLS, worldLandMaskMod.ROWS, worldLandMaskMod.isLand,
      WORLD_EQUATOR_CIRCUMFERENCE_KM
    ),
    terrainFile: '/terrain/world.png',
    terrainImageCols: worldLandMaskMod.COLS,
    terrainImageRows: worldLandMaskMod.ROWS,
  },
  iberia: {
    label: 'España',
    build: () => buildSourceFromMask(
      iberiaLandMaskMod.decodeLandMask, iberiaLandMaskMod.COLS, iberiaLandMaskMod.ROWS,
      (mask, x, y) => mask[y * iberiaLandMaskMod.COLS + x] === 1,
      // Ancho real en km de TODO el lienzo (LON_MIN..LON_MAX), a la latitud
      // media de la peninsula — mismo calculo que PX_PER_KM en el script de
      // horneado del terreno.
      (iberiaLandMaskMod.LON_MAX - iberiaLandMaskMod.LON_MIN) * 111.32 *
        Math.cos(((iberiaLandMaskMod.LAT_MIN + iberiaLandMaskMod.LAT_MAX) / 2) * Math.PI / 180)
    ),
    terrainFile: '/terrain/iberia.png',
    // OJO: NO son iberiaLandMaskMod.COLS/ROWS — esas son la resolución del
    // land mask que reparte territorios (fija, no cambia), pero el PNG
    // horneado se generó a una resolución más baja para poder entregarlo
    // (bajo el límite de subida) y son medidas INDEPENDIENTES. Si se
    // regenera public/terrain/iberia.png a otro tamaño, esto hay que
    // actualizarlo a mano para que coincida.
    terrainImageCols: 4600,
    terrainImageRows: 2850,
  },
};
const DEFAULT_MAP_KEY = 'world';

function getMapSource(mapKey) {
  const key = MAP_SOURCE_DEFS[mapKey] ? mapKey : DEFAULT_MAP_KEY;
  if (!mapSourceCache.has(key)) {
    const def = MAP_SOURCE_DEFS[key];
    mapSourceCache.set(key, { ...def.build(), terrainFile: def.terrainFile, terrainImageCols: def.terrainImageCols, terrainImageRows: def.terrainImageRows });
  }
  return mapSourceCache.get(key);
}

// Fuente EN USO durante la llamada a generateMap() en curso — todas las
// funciones de mas abajo (isLandCell, placeDecorations, rasterizeLand...) la
// leen de aqui en vez de recibirla por parametro en cada una: la generacion
// de mapa es siempre sincrona (nunca dos generateMap() a la vez), asi que no
// hace falta mas que esto para que cada partida use el mapa que le toca sin
// tener que enhebrar el parametro por una decena de funciones.
let currentSource = getMapSource(DEFAULT_MAP_KEY);

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
 * mapKey: que mapa jugar ('world' | 'iberia', ver MAP_SOURCE_DEFS) — por defecto el mundo.
 */
function generateMap({ tileCount, factionCount, mode, mapKey, dungeonsEnabled }) {
  if (factionCount < 2) throw new Error('generateMap: se necesitan al menos 2 facciones');
  if (tileCount < factionCount * 2) throw new Error('generateMap: tileCount demasiado pequenio para factionCount');

  currentSource = getMapSource(mapKey);
  if (tileCount > currentSource.landCellsX.length) throw new Error('generateMap: tileCount demasiado grande, no caben tantos territorios en la tierra del mapa');

  const seeds = placeSeedsOnLand(tileCount);
  const { cellTileIds, centroids } = rasterizeLand(seeds, currentSource.cols, currentSource.rows);
  const neighborSets = computeNeighbors(cellTileIds, currentSource.cols, currentSource.rows, tileCount, currentSource.kmPerCell);
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
      // Edificios de tropas de IA (!levas/!arqueros/!caballeros, ver
      // rules/troopBuildings.js), mismo mecanismo que industryCount: viven en
      // la CASILLA, asi que conquistarla se lleva el edificio al nuevo dueño
      // sin codigo extra (incluida una casilla que vuelve a neutral y luego
      // la captura otra faccion, ver neutralizeTile/transferTile).
      leviesCount: 0,
      archeryCount: 0,
      cavalryCount: 0,
      // Torres (!torre, ver rules/towers.js sección 28): mismo mecanismo
      // que industryCount, vive en la CASILLA. towerCount = terminadas
      // (dan +0.5 de defensa pasiva cada una); towerBuildingCount = en
      // obras, se promociona sola la ronda siguiente sin volver a votar.
      towerCount: 0,
      towerBuildingCount: 0,
    });
  }

  // Dungeons (ver docs/ACCIONES.md sección 27, !dungeon): 1 a 5 al azar por
  // partida, SOLO si el admin los activó en el panel — si no, 0 (sin
  // efecto, como el resto de "próximamente" que aún no se implementan).
  const dungeonCount = dungeonsEnabled ? 1 + Math.floor(Math.random() * 5) : 0;
  const decorations = placeDecorations(cellTileIds, currentSource.cols, currentSource.rows, tileCount, dungeonCount);

  const mapLayout = {
    cols: currentSource.cols,
    rows: currentSource.rows,
    cellTileIds,
    centroids,
    decorations,
    // Con que PNG horneado pintar el fondo, y su tamaño real en pixeles —
    // ver setLayout() en public/mapRenderer.js, que ya NO asume world.png.
    terrainFile: currentSource.terrainFile,
    terrainImageCols: currentSource.terrainImageCols,
    terrainImageRows: currentSource.terrainImageRows,
  };
  return { tiles, mode, mapLayout, structures: buildStructures(decorations, cellTileIds) };
}

// ---------------------------------------------------------------------------
// Decoracion del mapa (castillos, puertos, aldeas, arboles, barcos, ballenas,
// kraken). Ver docs/ACCIONES.md seccion 11.
// ---------------------------------------------------------------------------

/**
 * Castillo/aldea/puerto YA NO son un conteo fijo por partida: cada CASILLA
 * de la partida tira sus 3 dados por separado (independientes entre sí, así
 * que una misma casilla puede tener aldea Y puerto Y castillo a la vez, o
 * ninguno) — así la cantidad total escala sola con el tamaño del mapa
 * (`tileCount`) en vez de ser siempre "10 castillos" tenga la partida 10
 * casillas o 200. `terrain: 'coast'` en el puerto significa que la tirada
 * solo cuenta si esa casilla tiene ALGUNA celda de costa — una casilla
 * totalmente interior nunca saca puerto, tenga la suerte que tenga.
 */
const PROBABILISTIC_KINDS = [
  { type: 'village', chance: 0.70, terrain: 'land' },
  { type: 'port', chance: 0.55, terrain: 'coast' },
  { type: 'castle', chance: 0.25, terrain: 'land' },
];

/**
 * El resto de la decoración (paisaje puro, no conquistable) sigue con
 * conteo fijo por partida — la clave es EXACTAMENTE el nombre del PNG en
 * `public/sprites/` (ver tools/bakeSpritePlaceholders.js).
 *
 *   terrain: 'land'  -> cualquier celda de tierra
 *            'water' -> cualquier celda de oceano
 *   minGap: separación mínima frente a CUALQUIER otro elemento ya colocado
 *           (de cualquier tipo, ver placedAll en placeDecorations) para que
 *           nada salga amontonado ni pisando a otra cosa.
 */
const FIXED_COUNT_KINDS = [
  { type: 'tree', count: 100, terrain: 'land', minGap: 8 },
  { type: 'ship-small', count: 10, terrain: 'water', minGap: 40 },
  { type: 'ship-big', count: 5, terrain: 'water', minGap: 60 },
  { type: 'whale', count: 5, terrain: 'water', minGap: 60 },
  { type: 'kraken', count: 1, terrain: 'water', minGap: 0 },
];

// Separación mínima de castillo/aldea/puerto frente a CUALQUIER otro
// elemento ya colocado (misma idea que minGap de FIXED_COUNT_KINDS, pero
// estos no tienen "count" fijo así que viven en su propia tabla).
const STRUCTURE_MIN_GAP = { castle: 40, port: 30, village: 22 };
// Separación mínima de un dungeon frente a cualquier otro elemento —
// grande a propósito, son landmarks poco frecuentes (1-5 por partida).
const DUNGEON_MIN_GAP = 45;

// Cuantos intentos como mucho por elemento antes de rendirse y colocarlo sin
// respetar la separacion minima. Evita que un mapa con poca costa (o un
// minGap demasiado exigente) deje el generador dando vueltas para siempre.
const DECOR_MAX_TRIES = 400;

function isLandCell(x, y) {
  return currentSource.landMask[y * currentSource.cols + x] === 1;
}

/** Celda de tierra con al menos un vecino (4-conectado) de agua: la orilla. */
function isCoastCell(x, y) {
  if (!isLandCell(x, y)) return false;
  return (
    (x > 0 && !isLandCell(x - 1, y)) ||
    (x < currentSource.cols - 1 && !isLandCell(x + 1, y)) ||
    (y > 0 && !isLandCell(x, y - 1)) ||
    (y < currentSource.rows - 1 && !isLandCell(x, y + 1))
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
 * unica vez dentro del mensaje `map:layout`.
 *
 * Coordenadas en celdas de la rejilla del mapa (las mismas que `centroids`),
 * no en pixeles de pantalla: el cliente las escala con el zoom como el resto
 * del terreno.
 *
 * `placedAll` es la lista de TODO lo colocado hasta ahora (cualquier tipo:
 * castillo, aldea, puerto, árbol, barco...) — el anti-solape se comprueba
 * contra ella entera, no solo contra el propio tipo, para que nada quede
 * apilado encima de otra cosa ("regla para evitar se solape cualquier
 * elemento", tal y como se pidió).
 */
function placeDecorations(cellTileIds, cols, rows, tileCount, dungeonCount = 0) {
  const decorations = [];
  const placedAll = [];

  function overlapsAny(x, y, minGap) {
    return placedAll.some((p) => {
      const gap = Math.max(minGap, p.minGap);
      return (p.x - x) ** 2 + (p.y - y) ** 2 < gap * gap;
    });
  }

  function place(type, x, y, minGap) {
    placedAll.push({ x, y, minGap });
    decorations.push({ type, x, y });
  }

  /** Prueba varios candidatos al azar de `candidates` y se queda con el primero libre; si no encuentra ninguno libre en DECOR_MAX_TRIES, coloca igual el último probado (mejor solapado que perdido). */
  function tryPlaceFromCandidates(type, candidates, minGap) {
    if (!candidates.length) return;
    let fallback = null;
    for (let attempt = 0; attempt < DECOR_MAX_TRIES; attempt++) {
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      fallback = c;
      if (!overlapsAny(c.x, c.y, minGap)) { place(type, c.x, c.y, minGap); return; }
    }
    place(type, fallback.x, fallback.y, minGap);
  }

  // 1) Castillo/aldea/puerto: una tirada independiente por CASILLA (ver
  // PROBABILISTIC_KINDS) — hace falta la lista de celdas de tierra/costa DE
  // CADA casilla para poder elegir un punto al azar dentro de ELLA (no del
  // mapa entero), así el edificio de la casilla 7 cae dentro de la casilla
  // 7, nunca en otra.
  const cellsByTile = Array.from({ length: tileCount }, () => ({ land: [], coast: [] }));
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const id = cellTileIds[ry * cols + rx];
      if (id === OCEAN) continue;
      cellsByTile[id].land.push({ x: rx, y: ry });
      if (isCoastCell(rx, ry)) cellsByTile[id].coast.push({ x: rx, y: ry });
    }
  }
  for (let tileId = 0; tileId < tileCount; tileId++) {
    const cells = cellsByTile[tileId];
    for (const { type, chance, terrain } of PROBABILISTIC_KINDS) {
      if (Math.random() >= chance) continue;
      const candidates = terrain === 'coast' ? cells.coast : cells.land;
      tryPlaceFromCandidates(type, candidates, STRUCTURE_MIN_GAP[type]);
    }
  }

  // 1.5) Dungeons (ver docs/ACCIONES.md sección 27): cantidad FIJA por
  // partida (sorteada en generateMap(), 1-5 solo si el admin los activó),
  // en cualquier tierra del mapa entero — no depende de la casilla en la
  // que caigan, a diferencia de castillo/aldea/puerto. Mismo anti-solape
  // global que todo lo demás.
  for (let n = 0; n < dungeonCount; n++) {
    let best = null;
    for (let attempt = 0; attempt < DECOR_MAX_TRIES; attempt++) {
      const x = Math.floor(Math.random() * cols);
      const y = Math.floor(Math.random() * rows);
      if (!matchesTerrain('land', x, y)) continue;
      best = { x, y };
      if (!overlapsAny(x, y, DUNGEON_MIN_GAP)) break;
    }
    if (!best) continue; // mapa sin tierra libre (rarisimo): se deja fuera
    place('dungeon', best.x, best.y, DUNGEON_MIN_GAP);
  }

  // 2) Resto de decoración (paisaje, conteo fijo por partida) — mismo
  // anti-solape global de arriba (placedAll ya tiene dentro los
  // castillos/aldeas/puertos/dungeons recién colocados).
  for (const { type, count, terrain, minGap } of FIXED_COUNT_KINDS) {
    for (let n = 0; n < count; n++) {
      let best = null;
      for (let attempt = 0; attempt < DECOR_MAX_TRIES; attempt++) {
        const x = Math.floor(Math.random() * cols);
        const y = Math.floor(Math.random() * rows);
        if (!matchesTerrain(terrain, x, y)) continue;
        best = { x, y };
        if (!overlapsAny(x, y, minGap)) break;
      }
      if (!best) continue; // no hay sitio de ese terreno (mapa raro): se deja fuera
      place(type, best.x, best.y, minGap);
    }
  }

  return decorations;
}

// ---------------------------------------------------------------------------
// Estructuras conquistables: castillo/aldea/puerto (ver `!conquista`,
// server/rules/structures.js, docs/ACCIONES.md sección 20). Son las MISMAS
// decoraciones de arriba (mismo x/y), no un tipo nuevo de objeto — aquí solo
// se les añade el `tileId` que les toca (para saber "está en TU territorio")
// y una guarnición neutral inicial al azar, distinta por partida ("al
// colocarse cada partida aleatorio tiene más gracia", tal y como se pidió).
//
// Rango [min, max] de cada tropa de guarnición, AMBOS INCLUSIVE, por tipo de
// estructura. La guarnición usa las MISMAS constantes de bonus de combate que
// las tropas del jugador (AI_TROOP_COMBAT_BONUS/ARCHER_*/CAVALRY_* en
// rules/shared.js) — aquí solo se decide CUÁNTAS tropas de cada tipo le
// tocan a cada estructura, no su fuerza (esa la calcula rules/structures.js).
const STRUCTURE_GARRISON_RANGES = {
  castle: { aiTroops: [5, 10], archerTroops: [0, 2], cavalryTroops: [0, 2] },
  village: { aiTroops: [3, 15], archerTroops: [0, 0], cavalryTroops: [0, 0] },
  port: { aiTroops: [6, 12], archerTroops: [0, 5], cavalryTroops: [0, 0] },
};

// Guarnición de un dungeon (orcos/goblins, ver !dungeon sección 27) — un
// tipo de unidad totalmente aparte de aiTroops/archerTroops/cavalryTroops
// (ORC_COMBAT_BONUS/GOBLIN_COMBAT_BONUS en rules/shared.js). El número que
// PASEA alrededor del dungeon es siempre fijo (2 orcos + 4 goblins, ver
// desiredSiteSpecs() en mapRenderer.js) pero la fuerza de combate real
// varía un poco por partida, centrada en esos mismos números.
const DUNGEON_GARRISON_RANGE = { orcCount: [2, 3], goblinCount: [3, 5] };

function randomInRange([min, max]) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * A partir de las decoraciones ya colocadas, arma la lista de estructuras
 * conquistables (solo castillo/aldea/puerto — árboles, barcos, etc. quedan
 * fuera, son decoración pura). `cellTileIds` es la MISMA rejilla que ya
 * decidió a qué territorio pertenece cada celda (ver rasterizeLand()), así
 * que reutilizarla aquí garantiza que "la estructura está en la casilla X"
 * coincide exactamente con lo que el jugador ve pintado en el mapa.
 */
function buildStructures(decorations, cellTileIds) {
  const structures = [];
  for (const d of decorations) {
    const isDungeon = d.type === 'dungeon';
    const ranges = isDungeon ? DUNGEON_GARRISON_RANGE : STRUCTURE_GARRISON_RANGES[d.type];
    if (!ranges) continue; // no es castillo/aldea/puerto/dungeon (arbol, barco...): no es conquistable

    const tileId = cellTileIds[d.y * currentSource.cols + d.x];
    if (tileId === OCEAN) continue; // defensivo: no debería pasar (solo salen en tierra)

    structures.push({
      tileId,
      // Posicion EXACTA de este edificio (celdas de rejilla, igual que
      // `centroids` — el cliente las multiplica por BLOCK_PX), no solo el
      // tileId: varias estructuras pueden caer en la MISMA casilla (ver
      // PROBABILISTIC_KINDS, sección 22 de docs/ACCIONES.md), así que el
      // marcador de guarnición y sus tropas paseando tienen que anclarse a
      // SU propio edificio, no al centroide medio de la casilla entera.
      x: d.x,
      y: d.y,
      type: d.type,
      // Castillo/aldea/puerto usan aiTroops/archerTroops/cavalryTroops;
      // dungeon usa orcCount/goblinCount (tipo de unidad totalmente
      // aparte, ver rules/shared.js ORC_COMBAT_BONUS/GOBLIN_COMBAT_BONUS)
      // — cada estructura lleva SIEMPRE los 5 campos (a 0 los que no le
      // tocan) para que rules/structures.js pueda sumar la fuerza de
      // cualquier tipo con la misma fórmula, sin ramificar por tipo.
      aiTroops: isDungeon ? 0 : randomInRange(ranges.aiTroops),
      archerTroops: isDungeon ? 0 : randomInRange(ranges.archerTroops),
      cavalryTroops: isDungeon ? 0 : randomInRange(ranges.cavalryTroops),
      orcCount: isDungeon ? randomInRange(ranges.orcCount) : 0,
      goblinCount: isDungeon ? randomInRange(ranges.goblinCount) : 0,
    });
  }
  return structures;
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
  const landCellsX = currentSource.landCellsX, landCellsY = currentSource.landCellsY;
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
  const landMask = currentSource.landMask;
  const landCellsX = currentSource.landCellsX, landCellsY = currentSource.landCellsY;
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

/**
 * Alcance de la "vecindad de mar" (ver addSeaAdjacency() mas abajo): dos
 * costas a menos de esta distancia real se tratan como fronterizas para
 * atacar/expandirse, igual que si tocaran pixel a pixel. Sin esto, una
 * faccion que sale en una masa de tierra aislada (Australia es el caso real
 * que lo hizo evidente: sin vecinos de verdad, `factionsAreAdjacent()` y
 * `pickExpandableNeutralTile()` — ambas basadas solo en `tile.neighborIds`,
 * ver rules/territory.js — nunca encuentran nada, asi que esa facción no
 * puede atacar, ser atacada NI expandirse, JAMAS, en toda la partida) se
 * queda completamente fuera del juego. 400km cubre estrechos reales tipo
 * Australia-Nueva Guinea (~150km por el estrecho de Torres) o Sicilia-Tunez
 * (~140km) sin llegar a "teletransportar" continentes que de verdad estan a
 * miles de km (Australia-Sudafrica, por ejemplo, se queda sin conectar).
 */
const SEA_ADJACENCY_REACH_KM = 400;

/** Dos tiles son vecinos si en algun punto del raster quedan pegados (misma fila/columna, id distinto, ninguno oceano). */
function computeNeighbors(cellTileIds, cols, rows, tileCount, kmPerCell) {
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

  addSeaAdjacency(sets, cellTileIds, cols, rows, kmPerCell);

  return sets;
}

/**
 * Añade, a las vecindades de tierra ya calculadas, la "vecindad de mar":
 * casillas costeras (con al menos una celda de oceano al lado) de dos tiles
 * DISTINTOS que caigan a SEA_ADJACENCY_REACH_KM o menos entre si. Con una
 * rejilla espacial de cubos (mismo cubo = mismo radio de busqueda) en vez de
 * comparar cada celda costera contra todas las demas: a la resolucion de
 * territorio (cientos de miles de celdas como mucho) la costa real son unos
 * pocos miles de celdas, así que esto sale barato incluso en el mapa mundial.
 */
function addSeaAdjacency(sets, cellTileIds, cols, rows, kmPerCell) {
  const reachCells = Math.max(1, Math.round(SEA_ADJACENCY_REACH_KM / kmPerCell));
  const bucketSize = reachCells;

  // 1) casillas costeras: tierra con al menos un vecino de oceano.
  const coastal = []; // { x, y, id }
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const idx = ry * cols + rx;
      const id = cellTileIds[idx];
      if (id === OCEAN) continue;
      const touchesOcean =
        (rx > 0 && cellTileIds[idx - 1] === OCEAN) ||
        (rx + 1 < cols && cellTileIds[idx + 1] === OCEAN) ||
        (ry > 0 && cellTileIds[idx - cols] === OCEAN) ||
        (ry + 1 < rows && cellTileIds[idx + cols] === OCEAN);
      if (touchesOcean) coastal.push({ x: rx, y: ry, id });
    }
  }
  if (!coastal.length) return;

  // 2) rejilla espacial de cubos de lado `bucketSize` — un punto solo puede
  // caer dentro de SEA_ADJACENCY_REACH_KM de otro si sus cubos son iguales o
  // vecinos (3x3 alrededor), así que nunca hace falta mirar mas alla de eso.
  const grid = new Map();
  const bucketKey = (bx, by) => `${bx},${by}`;
  for (const c of coastal) {
    const bx = Math.floor(c.x / bucketSize), by = Math.floor(c.y / bucketSize);
    const key = bucketKey(bx, by);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(c);
  }

  const reachSq = reachCells * reachCells;
  for (const a of coastal) {
    const bx = Math.floor(a.x / bucketSize), by = Math.floor(a.y / bucketSize);
    for (let dby = -1; dby <= 1; dby++) {
      for (let dbx = -1; dbx <= 1; dbx++) {
        const bucket = grid.get(bucketKey(bx + dbx, by + dby));
        if (!bucket) continue;
        for (const b of bucket) {
          if (b.id === a.id) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          if (dx * dx + dy * dy <= reachSq) {
            sets[a.id].add(b.id);
            sets[b.id].add(a.id);
          }
        }
      }
    }
  }
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

// Lista de mapas jugables para el panel de admin (clave + nombre a mostrar),
// ver admin/index.html. Se deriva de MAP_SOURCE_DEFS para que añadir un mapa
// nuevo ahi (con su build()/terrainFile) baste para que aparezca aqui solo.
const AVAILABLE_MAPS = Object.keys(MAP_SOURCE_DEFS).map((key) => ({ key, label: MAP_SOURCE_DEFS[key].label }));

module.exports = { generateMap, OCEAN, AVAILABLE_MAPS, DEFAULT_MAP_KEY };
