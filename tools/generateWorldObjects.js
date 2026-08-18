'use strict';

/**
 * Genera los objetos DISCRETOS de decoracion del mundo (arboles, rocas,
 * arbustos, ramas/madera de deriva, conchas, palmeras) como DATOS — posicion
 * + tipo + tamaño — en vez de pixeles horneados en el PNG del terreno.
 *
 * Por que: a resolucion real (8800x4604) horneando estos objetos como
 * pixeles (que es lo que hacia antes `tools/bakeWorldTerrain.js`) el PNG
 * queda fijo a esa resolucion — hacer zoom de verdad (estilo videojuego,
 * pedido por el usuario: "que parezca muchisimo mas grande... hasta ver a
 * los aldeanos") significaria tener que hornear a una resolucion aun mayor,
 * lo que dispara el peso del PNG sin limite. Generando estos objetos como
 * datos (posicion+tipo+tamaño, ~6 bytes cada uno) y dejando que el CLIENTE
 * los dibuje el mismo con canvas (ver `public/mapRenderer.js`, seccion
 * "capa de objetos") el coste de dibujar SOLO depende de cuantos objetos
 * caen en el viewport actual, no de la resolucion nativa del mundo — la
 * misma arquitectura que investigamos que usa streamer-wars.com. El fichero
 * de datos entero (~50-60K objetos para todo el planeta) pesa unos pocos
 * cientos de KB, se descarga UNA vez al cargar el mapa (como `world.png` o
 * `cellTileIds`), nada de peticiones por tile/zoom.
 *
 * Usa `tools/worldTerrainCore.js` (MISMO calculo de bioma/banda/mascaras que
 * `tools/bakeWorldTerrain.js`, ver ese modulo) para que cada arbol/roca caiga
 * sobre el pixel de bioma que de verdad se ve pintado en el mapa.
 *
 * Salida: `public/terrain/objects.bin` — formato binario compacto (ver
 * ENCODING mas abajo). `public/mapRenderer.js` `loadObjectLayer()` tiene que
 * decodificar EXACTAMENTE igual, cualquier cambio aqui hay que reflejarlo
 * alli tambien (y en docs/ACCIONES.md).
 *
 * ENCODING (little-endian):
 *   byte 0       : version (1)
 *   bytes 1-4    : uint32 recordCount
 *   luego recordCount registros de 6 bytes cada uno:
 *     byte 0     : type (ver OBJECT_TYPES)
 *     bytes 1-2  : uint16 BE x (pixel de mundo, mismo espacio que world.png
 *                  y que RASTER_COLS/ROWS de server/mapTemplates.js)
 *     bytes 3-4  : uint16 BE y
 *     byte 5     : r (radio/tamaño en pixeles, ya escalado con scaleR — el
 *                  cliente lo usa tal cual, no recalcula escala)
 *   El resto de "sabor" visual (angulo de rama/palmera caida, tono de color
 *   de roca...) NO se guarda — el cliente lo deriva de un hash determinista
 *   de (x,y) para que cada objeto se vea igual de un frame a otro sin gastar
 *   bytes extra por objeto en algo puramente cosmetico.
 */

const fs = require('fs');
const path = require('path');
const core = require('./worldTerrainCore');

const W = core.W;
const H = core.H;

function log(msg) {
  const t = (process.hrtime()[0] + process.hrtime()[1] / 1e9).toFixed(1);
  console.log(`[generateWorldObjects +${t}s] ${msg}`);
}

// Mismo orden que `docs/ACCIONES.md` seccion "Objetos del mundo (datos)" —
// cualquier cambio de orden/valor hay que reflejarlo en
// `public/mapRenderer.js` (OBJECT_TYPES ahi, MISMOS numeros).
const OBJECT_TYPES = {
  TREE_ROUND: 0,
  TREE_PINE_HILL: 1,
  TREE_PINE_TUNDRA: 2,
  TREE_PINE_SNOW: 3,
  ROCK: 4,
  BUSH: 5,
  BRANCH_FOREST: 6,
  BRANCH_DESERT: 7,
  DRIFTWOOD: 8,
  SHELL: 9,
  PALM: 10,
};

const core_ = core.computeTerrainCore();
const { landMask, masks } = core_;
const {
  forestFlatMask, plainsFlatMask, desertFlatMask, tundraFlatMask,
  hillForestEdgeMask, snowcapTreelineMask, beachIdxMask, hillAnyMask, mountainMask,
} = masks;

const records = []; // {type, x, y, r}
function push(type, idx, r) {
  const [x, y] = core.xyOf(idx);
  records.push({ type, x, y, r });
}

// ===========================================================================
// Rocas pequeñas
// ===========================================================================
log('rocas...');
const rockRand = core.mulberry32(77); // mismo seed que groundRand en el bake original, no critico que coincida pero mantiene la tradicion de seeds por capa
function scatterSmallRocks(maskFn, n, pyPixelCount) {
  const idxs = core.collectIndices(maskFn);
  const k = Math.round(core.densityK(n, pyPixelCount, idxs.length) / core.SIZE_AREA_CORRECTION);
  const picked = core.pickRandom(idxs, k, rockRand);
  for (const idx of picked) {
    const r = core.scaleR(1 + Math.floor(rockRand() * 2)); // 1-2 -> escalado
    push(OBJECT_TYPES.ROCK, idx, r);
  }
}
scatterSmallRocks(forestFlatMask, 260, core.PY_PIXELS.forestFlat);
scatterSmallRocks(hillAnyMask, 380, core.PY_PIXELS.hillAny);
scatterSmallRocks(mountainMask, 220, core.PY_PIXELS.mountain);

// ===========================================================================
// Conchas (playa)
// ===========================================================================
log('conchas...');
{
  const shellRand = core.mulberry32(77);
  const beachIdxs = core.collectIndices(beachIdxMask);
  const k = Math.round(core.densityK(140, core.PY_PIXELS.beach, beachIdxs.length) / core.SIZE_AREA_CORRECTION / core_.BEACH_WIDTH_RATIO);
  const picked = core.pickRandom(beachIdxs, k, shellRand);
  for (const idx of picked) {
    const r = core.scaleR(2 + Math.floor(shellRand() * 2)); // 2-3 -> escalado
    push(OBJECT_TYPES.SHELL, idx, r);
  }
}

// ===========================================================================
// Vegetacion baja: arbustos, ramas, madera de deriva
// ===========================================================================
log('vegetacion baja...');
const vegRand = core.mulberry32(88);
function scatterBushes(maskFn, n, pyPixelCount, sizeMin, sizeMax) {
  const idxs = core.collectIndices(maskFn);
  const k = Math.round(core.densityK(n, pyPixelCount, idxs.length) / core.SIZE_AREA_CORRECTION);
  const picked = core.pickRandom(idxs, k, vegRand);
  for (const idx of picked) {
    const r = core.scaleR(sizeMin + Math.floor(vegRand() * (sizeMax - sizeMin)));
    push(OBJECT_TYPES.BUSH, idx, r);
  }
}
function scatterBranches(maskFn, n, pyPixelCount, type) {
  const idxs = core.collectIndices(maskFn);
  const k = Math.round(core.densityK(n, pyPixelCount, idxs.length) / core.LINEAR_SCALE);
  const picked = core.pickRandom(idxs, k, vegRand);
  for (const idx of picked) {
    const length = core.scaleR(3 + Math.floor(vegRand() * 4));
    push(type, idx, length);
  }
}
scatterBushes(forestFlatMask, 900, core.PY_PIXELS.forestFlat, 3, 6);
scatterBushes(plainsFlatMask, 500, core.PY_PIXELS.plainsFlat, 2, 4);
scatterBranches(forestFlatMask, 700, core.PY_PIXELS.forestFlat, OBJECT_TYPES.BRANCH_FOREST);
scatterBranches(desertFlatMask, 90, core.PY_PIXELS.desertFlat, OBJECT_TYPES.BRANCH_DESERT);
{
  const beachIdxs = core.collectIndices(beachIdxMask);
  const k = Math.round(core.densityK(160, core.PY_PIXELS.beach, beachIdxs.length) / core.SIZE_AREA_CORRECTION / core_.BEACH_WIDTH_RATIO);
  const picked = core.pickRandom(beachIdxs, k, vegRand);
  for (const idx of picked) {
    const length = core.scaleR(4 + Math.floor(vegRand() * 5));
    push(OBJECT_TYPES.DRIFTWOOD, idx, length);
  }
}

// ===========================================================================
// Arboles: forma segun bioma, 2-3 tamaños con pesos (mas pequeños que
// grandes). Mismos multiplicadores de densidad que el bake original para que
// la cobertura de copas se vea igual de "curada" (no solapada) que la
// aprobada.
// ===========================================================================
log('arboles...');
const treeRand = core.mulberry32(99);
const SIZE_SMALL = 0, SIZE_MED = 1, SIZE_LARGE = 2;
function weightedSize(sizesByClass) {
  const roll = treeRand();
  const cls = roll < 0.5 ? SIZE_SMALL : roll < 0.85 ? SIZE_MED : SIZE_LARGE;
  return sizesByClass[cls];
}
function scaledSizes(arr) { return arr.map(core.scaleR); }

const TREE_DENSITY_MULTIPLIER = 0.55;
const PINE_DENSITY_MULTIPLIER = 0.3;

function scatterTreesRound(maskFn, n, sizesByClass, type, pyPixelCount) {
  const idxs = core.collectIndices(maskFn);
  const k = Math.round(core.densityK(n, pyPixelCount, idxs.length) / core.SIZE_AREA_CORRECTION * TREE_DENSITY_MULTIPLIER);
  const picked = core.pickRandom(idxs, k, treeRand);
  for (const idx of picked) push(type, idx, weightedSize(sizesByClass));
}
function scatterTreesPine(maskFn, n, sizesByClass, type, pyPixelCount, directDensity) {
  const idxs = core.collectIndices(maskFn);
  const rawK = pyPixelCount ? core.densityK(n, pyPixelCount, idxs.length) : (directDensity || 0) * idxs.length;
  const k = Math.round(rawK / core.SIZE_AREA_CORRECTION * PINE_DENSITY_MULTIPLIER);
  const picked = core.pickRandom(idxs, k, treeRand);
  for (const idx of picked) push(type, idx, weightedSize(sizesByClass));
}

scatterTreesRound(forestFlatMask, 1400, scaledSizes([2, 4, 7]), OBJECT_TYPES.TREE_ROUND, core.PY_PIXELS.forestFlat);
scatterTreesPine(hillForestEdgeMask, 500, scaledSizes([3, 5, 7]), OBJECT_TYPES.TREE_PINE_HILL, core.PY_PIXELS.hillForestEdge);
scatterTreesPine(tundraFlatMask, 150, scaledSizes([2, 3, 5]), OBJECT_TYPES.TREE_PINE_TUNDRA, core.PY_PIXELS.tundraFlat);
scatterTreesPine(snowcapTreelineMask, 0, scaledSizes([3, 5, 7]), OBJECT_TYPES.TREE_PINE_SNOW, 0, 0.012);
log(`arboles: ${records.length} objetos hasta ahora (${core_.elapsed()})`);

// ===========================================================================
// Oasis: SOLO el anillo de palmeras es objeto-dato — el charco de agua sigue
// horneado en el PNG (es una mancha de color de terreno, no una "cosa" que
// tenga sentido dibujar aparte). Los centros de oasis se recalculan aqui con
// el MISMO codigo/seed que en bakeWorldTerrain.js para que el anillo de
// palmeras generado aqui caiga alrededor del mismo charco pintado alli — ver
// comentario en bakeWorldTerrain.js.
// ===========================================================================
log('oasis (palmeras)...');
{
  const oasisRand = core.mulberry32(707);
  const desertIdxs = core.collectIndices(desertFlatMask);
  const oasisCenters = [];
  const N_OASIS = Math.max(3, core.densityK(3, core.PY_PIXELS.desertFlat, desertIdxs.length));
  if (desertIdxs.length) {
    for (let k = 0; k < N_OASIS; k++) {
      const idx = desertIdxs[Math.floor(oasisRand() * desertIdxs.length)];
      oasisCenters.push(core.xyOf(idx));
    }
  }
  const ringRand = core.mulberry32(909);
  const palmSizes = scaledSizes([3, 4, 5]);
  for (const [ox, oy] of oasisCenters) {
    for (let k = 0; k < 10; k++) {
      const ang = ringRand() * 2 * Math.PI;
      const rad = core.scaleR(7 + ringRand() * 6);
      const px = Math.round(ox + Math.cos(ang) * rad), py = Math.round(oy + Math.sin(ang) * rad);
      if (px >= 0 && px < W && py >= 0 && py < H && landMask[py * W + px]) {
        records.push({ type: OBJECT_TYPES.PALM, x: px, y: py, r: weightedSize(palmSizes) });
      }
    }
  }
}
log(`oasis listos (${core_.elapsed()})`);

// ===========================================================================
// Serializar a binario
// ===========================================================================
log(`serializando ${records.length} objetos...`);
const buf = Buffer.alloc(5 + records.length * 6);
buf.writeUInt8(1, 0); // version
buf.writeUInt32LE(records.length, 1);
let off = 5;
for (const r of records) {
  buf.writeUInt8(r.type, off);
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(r.x))), off + 1);
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(r.y))), off + 3);
  buf.writeUInt8(Math.max(0, Math.min(255, Math.round(r.r))), off + 5);
  off += 6;
}

const outDir = path.join(__dirname, '..', 'public', 'terrain');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'objects.bin');
fs.writeFileSync(outPath, buf);
log(`objetos escritos en ${outPath} (${(buf.length / 1024).toFixed(0)}KB, ${records.length} objetos) (${core_.elapsed()})`);

module.exports = { OBJECT_TYPES };
