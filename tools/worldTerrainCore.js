'use strict';

/**
 * Nucleo de computo del terreno, compartido por los dos scripts offline que
 * lo consumen:
 *   - `tools/bakeWorldTerrain.js` (pinta el PNG de fondo: colores de bioma,
 *     costa, sombreado de relieve, rios, oleaje, textura fina de suelo)
 *   - `tools/generateWorldObjects.js` (calcula POSICIONES de objetos
 *     discretos — arboles, rocas, arbustos, conchas, palmeras... — como
 *     DATOS en vez de pixeles, para que el cliente los dibuje el mismo por
 *     viewport/zoom, ver docs/ACCIONES.md seccion 8 y `public/mapRenderer.js`)
 *
 * Antes este calculo (fases 1-6: land mask, distancia a costa, elevacion,
 * bioma, rios, colores base+sombreado) vivia solo dentro de
 * bakeWorldTerrain.js. Se separo aqui para que AMBOS scripts trabajen sobre
 * exactamente los mismos biomas/bandas/mascaras — si cada uno recalculara su
 * propia copia (aunque fuera "igual"), cualquier retoque futuro de una
 * constante (p.ej. COASTAL_NO_FOREST_WIDTH) se podria olvidar actualizar en
 * el otro sitio y los arboles empezarian a aparecer en pixeles de bioma
 * distinto al que se ve en el mapa.
 *
 * Este modulo es PURO COMPUTO (sin fs, sin escribir nada) — los dos scripts
 * que lo usan deciden que hacer con los datos (pintar PNG, o serializar a
 * binario).
 */

const { decodeLandMask, COLS, ROWS } = require('../server/worldLandMask');
const { fractalNoise, normalize, mulberry32 } = require('./terrainNoise');

const W = COLS;
const H = ROWS;

function log(msg) {
  const t = (process.hrtime()[0] + process.hrtime()[1] / 1e9).toFixed(1);
  console.log(`[worldTerrainCore +${t}s] ${msg}`);
}

// Factor de escala frente al boceto de Python (1600x1000, aprobado
// visualmente por el usuario) para el TAMAÑO en pixeles de cada objeto
// (arbol, roca, arbusto...). A PROPOSITO ya NO depende de W (antes era
// `W/1600`, asi que doblar la resolucion del planeta doblaba tambien el
// tamaño de cada arbol) — con un valor fijo, cada vez que el mundo tenga mas
// detalle nativo, los objetos ocupan una fraccion MENOR del mapa (mas
// pequeños en relacion, que es justo el efecto de zoom buscado) sin tener
// que retocar esta constante otra vez.
const LINEAR_SCALE = 1.65;
function scaleR(n) { return Math.max(1, Math.round(n * LINEAR_SCALE)); }

// Cuando un objeto se dibuja con LINEAR_SCALE veces mas radio en cada eje,
// su huella en pixeles crece LINEAR_SCALE² (area), no LINEAR_SCALE — asi que
// preservar "objetos por pixel de bioma" (densityK) Y ademas agrandar cada
// objeto por LINEAR_SCALE a la vez multiplica la cobertura visual de mas.
// Para que la fraccion de suelo cubierta sea la MISMA que en el boceto
// aprobado, hay que dividir la cuenta densidad-preservada entre
// LINEAR_SCALE² para cualquier objeto "de bulto" (elipses/poligonos
// rellenos) cuyo radio se escalo con scaleR.
const SIZE_AREA_CORRECTION = LINEAR_SCALE * LINEAR_SCALE;

// Cuentas de pixeles del boceto de Python (gen_v2.py, 1600x1000), medidas
// corriendolo — la densidad de objetos por pixel de bioma se preserva desde
// aqui, NO por proporcion de area de lienzo (ver densityK).
const PY_PIXELS = {
  forestFlat: 217311, plainsFlat: 124952, desertFlat: 42384, tundraFlat: 12448,
  hillAny: 45938, hillForestEdge: 29225, mountain: 2931, beach: 30514,
};
function densityK(nPython, pyPixelCount, actualPixelCount) {
  if (!pyPixelCount) return 0;
  return Math.max(0, Math.round((nPython / pyPixelCount) * actualPixelCount));
}

function elapsed(t0) { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }

// ===========================================================================
// 1. Land mask real
// ===========================================================================
function loadLandMask(t0) {
  log(`cargando land mask real (${W}x${H} = ${(W * H / 1e6).toFixed(1)}M celdas)...`);
  return decodeLandMask(); // Uint8Array, 1 = tierra, 0 = oceano
}

// ===========================================================================
// 2. Distancia a costa por BFS (multi-fuente)
// ===========================================================================
function bfsDistance(sourceIsTrue, width, height, maxDist) {
  const dist = new Float32Array(width * height).fill(-1);
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  let qHead = 0, qTail = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (sourceIsTrue[i]) {
        dist[i] = 0;
        queueX[qTail] = x; queueY[qTail] = y; qTail++;
      }
    }
  }
  const cap = maxDist == null ? Infinity : maxDist;
  while (qHead < qTail) {
    const x = queueX[qHead], y = queueY[qHead]; qHead++;
    const d = dist[y * width + x];
    if (d >= cap) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const ni = ny * width + nx;
        if (dist[ni] === -1) {
          dist[ni] = d + 1;
          queueX[qTail] = nx; queueY[qTail] = ny; qTail++;
        }
      }
    }
  }
  return dist;
}

const PLAINS = 0, FOREST = 1, DESERT = 2, TUNDRA = 3, SNOWCAP = 4;
const LOWLAND = 1, HILL = 2, MOUNTAIN = 3;

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Corre las fases 1-6 (land mask, distancia a costa, elevacion, bioma, rios,
 * colores base+sombreado+textura de roca/nieve) y devuelve todo lo que hace
 * falta para pintar el PNG (bakeWorldTerrain.js) o generar objetos
 * (generateWorldObjects.js). `onDebugStage(n, {landMask,...})` opcional, se
 * llama tras las fases 1-3 y 4-6 para que el llamador pueda volcar capturas
 * DEBUG_STAGE si quiere, sin que este modulo toque el filesystem.
 */
function computeTerrainCore({ onDebugStage } = {}) {
  const t0 = Date.now();
  const landMask = loadLandMask(t0);

  log('BFS distancia a costa (lado tierra, sin tope)...');
  const oceanSeed = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) oceanSeed[i] = landMask[i] ? 0 : 1;
  const distToCoastLand = bfsDistance(oceanSeed, W, H, null);

  log('BFS distancia a costa (lado oceano, tope 130 celdas)...');
  const distToCoastOcean = bfsDistance(landMask, W, H, 130);

  // -------------------------------------------------------------------------
  // 3. Elevacion: ruido fractal + domain warp, recortado a 4 bandas
  // -------------------------------------------------------------------------
  log('ruido de elevacion (fractal + domain warp)...');
  const warpX = fractalNoise(W, H, 260, 3, 7001);
  const warpY = fractalNoise(W, H, 260, 3, 7002);
  const elevationNoiseRaw = fractalNoise(W, H, 140, 6, 9001);
  const elevation = new Float32Array(W * H);
  {
    const warpAmount = 60;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!landMask[i]) continue;
        const wx = Math.min(W - 1, Math.max(0, x + (warpX[i] - 0.5) * warpAmount));
        const wy = Math.min(H - 1, Math.max(0, y + (warpY[i] - 0.5) * warpAmount));
        const wi = (wy | 0) * W + (wx | 0);
        elevation[i] = elevationNoiseRaw[wi];
      }
    }
  }
  {
    let maxD = 1;
    for (let i = 0; i < W * H; i++) if (landMask[i] && distToCoastLand[i] > maxD) maxD = distToCoastLand[i];
    for (let i = 0; i < W * H; i++) {
      if (!landMask[i]) continue;
      const inland = Math.min(1, distToCoastLand[i] / (maxD * 0.35));
      elevation[i] = elevation[i] * (0.35 + 0.65 * inland);
    }
  }
  const elevationNorm = normalize(elevation);

  const band = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!landMask[i]) continue;
    const e = elevationNorm[i];
    band[i] = e > 0.72 ? MOUNTAIN : e > 0.45 ? HILL : LOWLAND;
  }

  log(`elevacion lista (${elapsed(t0)})`);
  if (onDebugStage) onDebugStage(1, { landMask, band });

  // -------------------------------------------------------------------------
  // 4. Bioma: bosque / desierto / pradera / tundra / nieve alta
  // -------------------------------------------------------------------------
  const ROWS_FULL_PLANET = Math.round(H * 180 / 148);
  function latOfRow(y) { return 90 - (y / ROWS_FULL_PLANET) * 180; }

  log('bioma (ruido + latitud real + humedad)...');
  const moistureNoise = fractalNoise(W, H, 70, 6, 30001);
  const fineJitter = fractalNoise(W, H, 12, 2, 30002);
  const blendWidthField = fractalNoise(W, H, 220, 3, 30003);

  const biome = new Uint8Array(W * H); // PLAINS por defecto
  const COASTAL_NO_FOREST_WIDTH = 10; // ~45km reales, ver bakeWorldTerrain.js historico
  const CONTINENTALITY_SATURATION = 180;

  for (let y = 0; y < H; y++) {
    const lat = latOfRow(y);
    const latNorm = 1 - Math.abs(lat) / 90;
    const absLat = Math.abs(lat);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!landMask[i]) continue;

      const continentality = Math.min(1, distToCoastLand[i] / CONTINENTALITY_SATURATION);
      const moisture = Math.max(0, Math.min(1,
        0.62 - continentality * 0.34 + (moistureNoise[i] - 0.5) * 0.9));

      const jitterWidth = 0.02 + blendWidthField[i] * 0.5;
      const jitter = (fineJitter[i] - 0.5) * jitterWidth;

      const inDesertLatBand = absLat > 12 && absLat < 38;

      let b = PLAINS;
      if (moisture + jitter > 0.42 && elevationNorm[i] < 0.62) b = FOREST;
      if (b === FOREST && distToCoastLand[i] < COASTAL_NO_FOREST_WIDTH) b = PLAINS;
      if (inDesertLatBand && (-moisture + jitter) > -0.32) b = DESERT;
      if (latNorm < 0.14 - jitter) b = TUNDRA;
      if (band[i] === MOUNTAIN && (latNorm < 0.32 - jitter || elevationNorm[i] > 0.82)) b = SNOWCAP;

      biome[i] = b;
    }
  }

  // nieve en la falda: expandir SNOWCAP desde MOUNTAIN hacia HILL adyacente
  // (BFS de 14 pasadas) — sin esto la mascara "falda nevada" (HILL+SNOWCAP)
  // nunca tenia celdas, bug heredado del boceto de Python.
  {
    let frontier = [];
    for (let i = 0; i < W * H; i++) if (band[i] === MOUNTAIN && biome[i] === SNOWCAP) frontier.push(i);
    for (let pass = 0; pass < 14 && frontier.length; pass++) {
      const next = [];
      for (const i of frontier) {
        const x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; if (nx < 0 || nx >= W) continue;
            const ni = ny * W + nx;
            if (landMask[ni] && band[ni] === HILL && biome[ni] !== SNOWCAP) {
              biome[ni] = SNOWCAP;
              next.push(ni);
            }
          }
        }
      }
      frontier = next;
    }
  }
  log(`bioma listo (${elapsed(t0)})`);

  // -------------------------------------------------------------------------
  // 5. Rios: caminata cuesta abajo desde picos de montaña hasta la costa
  // -------------------------------------------------------------------------
  log('rios...');
  const riverMask = new Uint8Array(W * H);
  {
    const mountainCells = [];
    for (let i = 0; i < W * H; i++) if (landMask[i] && band[i] === MOUNTAIN) mountainCells.push(i);
    const rand = mulberry32(55555);
    const N_RIVERS = Math.max(40, Math.round((W * H) / 90000));
    for (let r = 0; r < N_RIVERS && mountainCells.length; r++) {
      let idx = mountainCells[Math.floor(rand() * mountainCells.length)];
      let x = idx % W, y = (idx / W) | 0;
      for (let step = 0; step < 4000; step++) {
        riverMask[y * W + x] = 1;
        if (!landMask[y * W + x] || distToCoastLand[y * W + x] < 2) break;
        let bestX = -1, bestY = -1, bestH = elevationNorm[y * W + x];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nh = elevationNorm[ny * W + nx];
            if (nh <= bestH) { bestH = nh; bestX = nx; bestY = ny; }
          }
        }
        if (bestX === -1) break;
        x = bestX; y = bestY;
      }
    }
    const dilated = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!riverMask[y * W + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= W) continue;
            if (landMask[ny * W + nx]) dilated[ny * W + nx] = 1;
          }
        }
      }
    }
    riverMask.set(dilated);
  }
  log(`rios listos (${elapsed(t0)})`);
  if (onDebugStage) onDebugStage(2, { landMask, biome, riverMask });

  // -------------------------------------------------------------------------
  // 6. Colores base + sombreado de relieve + textura de roca/nieve
  // -------------------------------------------------------------------------
  log('coloreado base...');

  const COL_OCEAN_DEEP    = [46, 82, 94];
  const COL_OCEAN_MID     = [70, 112, 118];
  const COL_OCEAN_SHALLOW = [112, 156, 148];
  const COL_COAST_BAND    = [172, 202, 182];
  const COL_LOWLAND       = [172, 189, 118]; // pradera verde de verdad
  const COL_FOREST        = [120, 140, 84];
  const COL_DESERT        = [215, 184, 128];
  const COL_TUNDRA        = [199, 204, 188];
  const COL_HILL_TINT     = [142, 116, 82];
  const COL_MOUNTAIN_ROCK = [143, 132, 122];
  const COL_MOUNTAIN_PEAK = [230, 227, 219];
  const COL_RIVER         = [84, 124, 128];
  const COL_BEACH         = [230, 216, 178];
  const COL_SNOWCAP_ROCK  = [120, 128, 138];
  const COL_SNOWCAP_SNOW  = [238, 241, 244];

  const BIOME_COLOR = { [PLAINS]: COL_LOWLAND, [FOREST]: COL_FOREST, [DESERT]: COL_DESERT, [TUNDRA]: COL_TUNDRA, [SNOWCAP]: COL_SNOWCAP_ROCK };

  const BEACH_WIDTH = 5; // ~23km reales
  const BEACH_WIDTH_RATIO = BEACH_WIDTH / 5.5;
  const beachMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (landMask[i] && band[i] === LOWLAND && distToCoastLand[i] < BEACH_WIDTH) beachMask[i] = 1;
  }

  const rockNoise = fractalNoise(W, H, 24, 3, 40001);
  const snowNoise = fractalNoise(W, H, 15, 2, 40002);

  const colorF = new Float32Array(W * H * 3);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let col;
      if (!landMask[i]) {
        const od = distToCoastOcean[i] < 0 ? 130 : distToCoastOcean[i];
        const t = Math.min(1, od / 35);
        const deepT = Math.max(0, Math.min(1, (t - 0.5) * 2));
        const mid = lerp3(COL_OCEAN_SHALLOW, COL_OCEAN_MID, t);
        col = lerp3(mid, COL_OCEAN_DEEP, deepT);
        if (od < 2.2) col = lerp3(COL_COAST_BAND, COL_OCEAN_SHALLOW, 0.15);
      } else if (beachMask[i]) {
        col = COL_BEACH;
      } else if (band[i] === MOUNTAIN && biome[i] !== SNOWCAP) {
        const base = BIOME_COLOR[biome[i]];
        col = lerp3(base, COL_MOUNTAIN_ROCK, 0.82);
        if (elevationNorm[i] > 0.88) col = COL_MOUNTAIN_PEAK;
      } else if (biome[i] === SNOWCAP) {
        const snowAmount = Math.max(0, Math.min(1, (elevationNorm[i] - 0.55) / 0.35));
        col = lerp3(COL_SNOWCAP_ROCK, COL_SNOWCAP_SNOW, snowAmount);
      } else if (band[i] === HILL) {
        const base = BIOME_COLOR[biome[i]];
        col = lerp3(base, COL_HILL_TINT, 0.55);
      } else {
        col = BIOME_COLOR[biome[i]];
      }
      if (riverMask[i] && landMask[i]) col = COL_RIVER;

      colorF[i * 3] = col[0]; colorF[i * 3 + 1] = col[1]; colorF[i * 3 + 2] = col[2];
    }
  }

  for (let y = 1; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const i = y * W + x;
      if (!landMask[i]) continue;
      const e = elevationNorm[i], eLeft = elevationNorm[i - 1], eUp = elevationNorm[i - W];
      let shade = (e * 2 - eLeft - eUp) * 0.5 * 260;
      shade = Math.max(-40, Math.min(40, shade));
      colorF[i * 3] += shade; colorF[i * 3 + 1] += shade; colorF[i * 3 + 2] += shade;
    }
  }

  for (let i = 0; i < W * H; i++) {
    if (!landMask[i] || band[i] !== MOUNTAIN) continue;
    const speckle = (rockNoise[i] - 0.5) * 34;
    if (biome[i] === SNOWCAP) {
      const snowAmount = Math.max(0, Math.min(1, (elevationNorm[i] - 0.55) / 0.35));
      const rockPortion = speckle * (1 - snowAmount) * 0.7;
      const snowPortion = (snowNoise[i] - 0.5) * 20 * snowAmount * 0.5;
      colorF[i * 3] += rockPortion + snowPortion; colorF[i * 3 + 1] += rockPortion + snowPortion; colorF[i * 3 + 2] += rockPortion + snowPortion;
    } else {
      colorF[i * 3] += speckle; colorF[i * 3 + 1] += speckle; colorF[i * 3 + 2] += speckle;
      if (elevationNorm[i] > 0.88) {
        const sp = (snowNoise[i] - 0.5) * 20 * 0.6;
        colorF[i * 3] += sp; colorF[i * 3 + 1] += sp; colorF[i * 3 + 2] += sp;
      }
    }
  }

  log(`coloreado listo (${elapsed(t0)})`);
  if (onDebugStage) onDebugStage(3, { colorF });

  // -------------------------------------------------------------------------
  // Mascaras de objetos: reutilizadas TAL CUAL por bakeWorldTerrain.js
  // (textura fina de suelo) y generateWorldObjects.js (objetos discretos) —
  // una unica definicion evita que un retoque futuro de bioma/banda deje a
  // los dos scripts viendo biomas distintos.
  // -------------------------------------------------------------------------
  const masks = {
    forestFlatMask: i => landMask[i] && biome[i] === FOREST && band[i] === LOWLAND && !riverMask[i],
    plainsFlatMask: i => landMask[i] && biome[i] === PLAINS && band[i] === LOWLAND && !riverMask[i],
    desertFlatMask: i => landMask[i] && biome[i] === DESERT && band[i] === LOWLAND,
    tundraFlatMask: i => landMask[i] && biome[i] === TUNDRA && band[i] === LOWLAND,
    hillNonSnowMask: i => landMask[i] && band[i] === HILL && biome[i] !== SNOWCAP,
    hillForestEdgeMask: i => landMask[i] && band[i] === HILL && biome[i] !== DESERT && biome[i] !== SNOWCAP,
    snowcapTreelineMask: i => landMask[i] && band[i] === HILL && biome[i] === SNOWCAP,
    beachIdxMask: i => beachMask[i] === 1,
    hillAnyMask: i => landMask[i] && band[i] === HILL,
    mountainMask: i => landMask[i] && band[i] === MOUNTAIN,
  };

  return {
    W, H, landMask, distToCoastLand, distToCoastOcean, elevationNorm,
    band, biome, riverMask, beachMask, colorF, masks,
    COASTAL_NO_FOREST_WIDTH, BEACH_WIDTH, BEACH_WIDTH_RATIO,
    t0, elapsed: () => elapsed(t0),
  };
}

// ===========================================================================
// Utilidades de muestreo compartidas: recolectar indices de pixel que cumplen
// una condicion, y elegir N al azar sin repetir (Set-based, barato porque N
// siempre es << que el total de candidatos).
// ===========================================================================
function collectIndices(maskFn, w, h) {
  const buf = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) if (maskFn(i)) buf[n++] = i;
  return buf.subarray(0, n);
}
function pickRandom(indices, k, rand) {
  const n = indices.length;
  if (n === 0 || k <= 0) return [];
  const kk = Math.min(k, n);
  if (kk >= n * 0.5) {
    const copy = Array.from(indices);
    for (let i = 0; i < kk; i++) {
      const j = i + Math.floor(rand() * (copy.length - i));
      const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
    }
    return copy.slice(0, kk);
  }
  const seen = new Set();
  const picked = [];
  let guard = 0;
  while (picked.length < kk && guard < kk * 50) {
    const idx = Math.floor(rand() * n);
    guard++;
    if (seen.has(idx)) continue;
    seen.add(idx);
    picked.push(indices[idx]);
  }
  return picked;
}

module.exports = {
  W, H,
  PLAINS, FOREST, DESERT, TUNDRA, SNOWCAP,
  LOWLAND, HILL, MOUNTAIN,
  LINEAR_SCALE, scaleR, SIZE_AREA_CORRECTION, PY_PIXELS, densityK,
  computeTerrainCore,
  collectIndices: fn => collectIndices(fn, W, H),
  pickRandom,
  xyOf: i => [i % W, (i / W) | 0],
  mulberry32,
  fractalNoise, normalize,
  log,
};
