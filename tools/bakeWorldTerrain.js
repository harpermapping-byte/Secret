'use strict';

/**
 * Horneado de terreno del planeta — script de DESARROLLO, se ejecuta a mano
 * UNA vez (`node tools/bakeWorldTerrain.js`) y el resultado (un .png) se
 * guarda en `public/terrain/` como asset estatico normal. No corre nunca en
 * el servidor de produccion ni se repite por partida — ver docs/ACCIONES.md
 * seccion 6 "Horneado de terreno" para el porque de este diseño (el
 * contorno tierra/agua es el planeta real, no cambia entre partidas, asi
 * que el terreno tampoco — solo el reparto en territorios cambia, y eso
 * sigue viviendo aparte en `server/mapTemplates.js`, sin tocar).
 *
 * Fases (cada una una seccion de este archivo, en orden):
 *   1-6. Delegadas en `tools/worldTerrainCore.js` (land mask real, distancia
 *        a costa, elevacion, bioma, rios, colores base+sombreado+textura de
 *        roca/nieve) — MISMO calculo que usa `tools/generateWorldObjects.js`
 *        para que arboles/rocas/etc. caigan sobre el bioma que de verdad se
 *        ve pintado aqui, ver ese modulo para el porque de compartirlo.
 *   7. Oleaje en el agua
 *   8. Textura FINA de suelo (moteado de color, no formas): grano de
 *      hierba/arena/roca/escarcha y flores sueltas — esto SIGUE horneado en
 *      el PNG (es textura de 1px, no un "objeto" que tenga sentido hacer
 *      zoom hasta verlo con su propia forma). Los objetos discretos con
 *      forma propia (arboles, rocas, arbustos, ramas, conchas, palmeras) ya
 *      NO se pintan aqui — se generan como DATOS en
 *      `tools/generateWorldObjects.js` -> `public/terrain/objects.bin`, y
 *      los dibuja el cliente por viewport/zoom (`public/mapRenderer.js`).
 *      Motivo: a resolucion real habia demasiados arboles solapandose por
 *      mm² horneados en pixeles fijos, y el usuario pidio poder hacer mucho
 *      zoom (estilo videojuego, ver el peron de aqui hasta "aldeanos") sin
 *      que el PNG del mundo tuviera que pesar mas — mover los objetos
 *      discretos a datos (~50K objetos, unos pocos cientos de KB) en vez de
 *      pixeles (que no escalan con el zoom) es lo que lo permite.
 *   9. Envejecido (manchas, viñeta, grano) + exportar PNG
 *
 * El marco ornamentado y la rosa de los vientos NO estan aqui — son
 * decoracion de INTERFAZ fija (no se mueven con el zoom/pan del mapa, no
 * dependen de que territorio es de quien), asi que viven en su propio
 * asset/capa aparte, no horneados junto al terreno del mundo.
 */

const fs = require('fs');
const path = require('path');
const core = require('./worldTerrainCore');
const { fractalNoise, normalize, mulberry32 } = require('./terrainNoise');
const { encodePNG } = require('./pngEncoder');
const { fillEllipse } = require('./rasterPrimitives');

const W = core.W;
const H = core.H;

function log(msg) {
  const t = (process.hrtime()[0] + process.hrtime()[1] / 1e9).toFixed(1);
  console.log(`[bakeWorldTerrain +${t}s] ${msg}`);
}

// ===========================================================================
// 1-6. Nucleo compartido con generateWorldObjects.js — ver worldTerrainCore.js
// ===========================================================================
function debugDump(stage, data) {
  if (String(process.env.DEBUG_STAGE) !== String(stage)) return;
  let rgb;
  if (stage === 1) {
    rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      let r, g, b;
      if (!data.landMask[i]) { r = 40; g = 70; b = 90; }
      else if (data.band[i] === core.MOUNTAIN) { r = 150; g = 140; b = 130; }
      else if (data.band[i] === core.HILL) { r = 160; g = 140; b = 100; }
      else { r = 190; g = 180; b = 130; }
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    }
  } else if (stage === 2) {
    const BIOME_COLOR = {
      [core.PLAINS]: [221, 201, 156], [core.FOREST]: [120, 140, 84], [core.DESERT]: [215, 184, 128],
      [core.TUNDRA]: [199, 204, 188], [core.SNOWCAP]: [230, 227, 219],
    };
    rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      let col = [40, 70, 90];
      if (data.landMask[i]) col = BIOME_COLOR[data.biome[i]];
      if (data.riverMask[i]) col = [84, 124, 128];
      rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
    }
  } else if (stage === 3) {
    rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H * 3; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(data.colorF[i])));
  }
  fs.mkdirSync('/tmp/mappreview', { recursive: true });
  fs.writeFileSync(`/tmp/mappreview/debug_stage${stage}.png`, encodePNG(W, H, rgb));
  log(`debug_stage${stage}.png escrito`);
}

const core_ = core.computeTerrainCore({ onDebugStage: debugDump });
const { landMask, distToCoastOcean, colorF, masks } = core_;
const {
  forestFlatMask, plainsFlatMask, desertFlatMask, tundraFlatMask,
  hillNonSnowMask, beachIdxMask,
} = masks;

if (process.env.DEBUG_STAGE === '4') {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(colorF[i])));
  fs.mkdirSync('/tmp/mappreview', { recursive: true });
  fs.writeFileSync('/tmp/mappreview/debug_stage4.png', encodePNG(W, H, rgb));
  log('debug_stage4.png escrito');
}

// ===========================================================================
// 7. Oleaje: en vez de dibujar arcos a mano (no hay Canvas aqui), se explota
//    que distToCoastOcean YA seria un BFS que sigue el contorno real de la
//    costa — una onda seno en funcion de esa distancia da bandas concentricas
//    que abrazan la costa de verdad sin necesitar geometria. Ruido fino
//    encima rompe la periodicidad perfecta para que no se vea "de compas".
// ===========================================================================
log('oleaje...');
{
  const waveJitter = fractalNoise(W, H, 18, 2, 50001);
  const waveFine = fractalNoise(W, H, 5, 1, 50002);
  const WAVE_REACH = 26; // celdas mar adentro donde se apagan del todo
  for (let i = 0; i < W * H; i++) {
    if (landMask[i]) continue;
    const od = distToCoastOcean[i];
    if (od < 0 || od > WAVE_REACH) continue;
    const jitter = (waveJitter[i] - 0.5) * 10;
    const phase = (od + jitter) * 0.55;
    let wave = Math.sin(phase) * 0.5 + 0.5;
    wave = Math.pow(wave, 3);
    const fade = 1 - od / WAVE_REACH;
    const amount = wave * fade * 22 * (0.6 + waveFine[i] * 0.8);
    colorF[i * 3] += amount;
    colorF[i * 3 + 1] += amount;
    colorF[i * 3 + 2] += amount * 0.9;
  }
}
log(`oleaje listo (${core_.elapsed()})`);

// Buffer RGB final de bytes a partir de aqui.
const rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H * 3; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(colorF[i])));

// ===========================================================================
// 8. Textura FINA de suelo: moteado de color (grano) + flores sueltas — NO
//    los objetos discretos con forma (eso vive en generateWorldObjects.js
//    ahora, ver cabecera del archivo).
// ===========================================================================
log('objetos: textura de suelo...');

const groundRand = mulberry32(77);

function scatterFlecks(maskFn, n, colorA, colorB, pyPixelCount) {
  const idxs = core.collectIndices(maskFn);
  const k = core.densityK(n, pyPixelCount, idxs.length);
  const picked = core.pickRandom(idxs, k, groundRand);
  for (const idx of picked) {
    const [x, y] = core.xyOf(idx);
    const col = groundRand() > 0.5 ? colorA : colorB;
    setPxDirect(x, y, col);
  }
}
function setPxDirect(x, y, col) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  rgb[i] = col[0]; rgb[i + 1] = col[1]; rgb[i + 2] = col[2];
}

const GRASS_A = [150, 168, 104], GRASS_B = [98, 118, 70];
const SAND_A = [232, 210, 160], SAND_B = [196, 170, 118];
const ROCK_A = [168, 158, 148], ROCK_B = [118, 110, 102];
const FROST_A = [220, 224, 214], FROST_B = [176, 182, 172];
const SHELL_A = [241, 228, 206], SHELL_B = [214, 188, 176];

scatterFlecks(forestFlatMask, 26000, GRASS_A, GRASS_B, core.PY_PIXELS.forestFlat);
scatterFlecks(plainsFlatMask, 20000, GRASS_A, GRASS_B, core.PY_PIXELS.plainsFlat);
scatterFlecks(desertFlatMask, 24000, SAND_A, SAND_B, core.PY_PIXELS.desertFlat);
scatterFlecks(tundraFlatMask, 16000, FROST_A, FROST_B, core.PY_PIXELS.tundraFlat);
scatterFlecks(hillNonSnowMask, 14000, ROCK_A, ROCK_B, core.PY_PIXELS.hillAny);
scatterFlecks(beachIdxMask, 9000, SHELL_A, SHELL_B, core.PY_PIXELS.beach);

// flores de colores en la pradera — moteado fino igual que el resto de la
// textura de suelo (1px), no un objeto con forma propia.
log('objetos: flores...');
{
  const flowerDensityField = fractalNoise(W, H, core.scaleR(70), 3, 808);
  const flowerPalette = [[219, 84, 96], [238, 205, 74], [176, 108, 214], [240, 240, 234]];
  const plainsIdxs = core.collectIndices(i =>
    landMask[i] && plainsFlatMask(i) &&
    core_.distToCoastLand[i] > core_.COASTAL_NO_FOREST_WIDTH * 0.6);
  for (const idx of plainsIdxs) {
    const keepProb = Math.max(0, Math.min(1, (flowerDensityField[idx] - 0.62) / 0.2)) * 0.09;
    if (groundRand() >= keepProb) continue;
    const [x, y] = core.xyOf(idx);
    const col = flowerPalette[Math.floor(groundRand() * flowerPalette.length)];
    fillEllipse(rgb, W, H, x, y, 1, 1, col);
  }
}
log(`textura de suelo lista (${core_.elapsed()})`);

// oasis: SOLO el charco (mancha de color de terreno) — el anillo de
// palmeras alrededor es un objeto-dato ahora, ver
// tools/generateWorldObjects.js (usa el MISMO codigo/seed 707 para calcular
// los centros, asi el anillo que genera ese script cae sobre el mismo
// charco pintado aqui).
log('objetos: oasis (charco)...');
{
  const COL_OASIS_WATER = [88, 132, 134];
  const oasisRand = mulberry32(707);
  const desertIdxs = core.collectIndices(desertFlatMask);
  const oasisCenters = [];
  const N_OASIS = Math.max(3, core.densityK(3, core.PY_PIXELS.desertFlat, desertIdxs.length));
  if (desertIdxs.length) {
    for (let k = 0; k < N_OASIS; k++) {
      const idx = desertIdxs[Math.floor(oasisRand() * desertIdxs.length)];
      oasisCenters.push(core.xyOf(idx));
    }
  }
  const pondR = core.scaleR(6);
  for (const [ox, oy] of oasisCenters) {
    fillEllipse(rgb, W, H, ox, oy, pondR, pondR, COL_OASIS_WATER);
  }
}
log(`oasis listos (${core_.elapsed()})`);

if (process.env.DEBUG_STAGE === '5') {
  fs.mkdirSync('/tmp/mappreview', { recursive: true });
  fs.writeFileSync('/tmp/mappreview/debug_stage5.png', encodePNG(W, H, rgb));
  log('debug_stage5.png escrito');
}

// ===========================================================================
// 9. Envejecido: manchas de humedad + viñeta + grano de papel — ultima
//    pasada, sobre el buffer ya con la textura de suelo encima (los objetos
//    discretos ya no se pintan aqui, ver cabecera).
// ===========================================================================
log('envejecido...');
{
  const stainNoiseRaw = fractalNoise(W, H, core.scaleR(260), 3, 606);
  const stainNoise = normalize(stainNoiseRaw);
  const grainRand = mulberry32(20260818);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const sn = stainNoise[i];
      let stainDelta = 0;
      if (sn > 0.62 && sn < 0.78) stainDelta = -((sn - 0.62) / 0.16) * 22;

      const vig = Math.max(0, Math.min(1, 1 - Math.max(Math.abs(x - cx) / (W * 0.62), Math.abs(y - cy) / (H * 0.58))));
      const vigMul = 0.86 + 0.14 * vig;

      const grain = (grainRand() - 0.5) * 12;

      const pi = i * 3;
      for (let c = 0; c < 3; c++) {
        let v = (rgb[pi + c] + stainDelta) * vigMul + grain;
        rgb[pi + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
}
log(`envejecido listo (${core_.elapsed()})`);

if (process.env.DEBUG_STAGE === '6') {
  fs.mkdirSync('/tmp/mappreview', { recursive: true });
  fs.writeFileSync('/tmp/mappreview/debug_stage6_final.png', encodePNG(W, H, rgb));
  log('debug_stage6_final.png escrito');
}

// ===========================================================================
// Salida de produccion: solo se escribe el asset final en public/terrain/
// cuando se corre SIN DEBUG_STAGE.
// ===========================================================================
if (!process.env.DEBUG_STAGE) {
  const outDir = path.join(__dirname, '..', 'public', 'terrain');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'world.png');
  fs.writeFileSync(outPath, encodePNG(W, H, rgb));
  log(`terreno final escrito en ${outPath} (${core_.elapsed()})`);
}
