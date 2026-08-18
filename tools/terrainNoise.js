'use strict';

/**
 * Ruido de valor multi-octava hecho a mano (sin librerias de "noise"),
 * mismo algoritmo que se prototipo y aprobo visualmente en Python antes de
 * portarlo aqui (ver conversacion de diseño, docs/ACCIONES.md seccion 6
 * "Horneado de terreno"). Un PRNG determinista con semilla (mulberry32, el
 * mismo generador que ya se uso en el prototipo de terreno anterior de este
 * proyecto) rellena una rejilla gruesa de valores aleatorios, y se
 * interpola suavemente (smoothstep) para conseguir una rejilla fina — sumar
 * varias "octavas" de eso a distintas frecuencias da el aspecto organico
 * tipico de un mapa de altura.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Una capa de ruido de valor a una escala de celda fija, devuelta como
 * Float32Array width*height con valores en [0,1].
 */
function valueNoiseLayer(width, height, cell, seed) {
  const gw = Math.floor(width / cell) + 2;
  const gh = Math.floor(height / cell) + 2;
  const rand = mulberry32(seed);
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = y / cell;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < width; x++) {
      const fx = x / cell;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);

      const g00 = grid[y0 * gw + x0];
      const g10 = grid[y0 * gw + x0 + 1];
      const g01 = grid[(y0 + 1) * gw + x0];
      const g11 = grid[(y0 + 1) * gw + x0 + 1];

      const top = g00 * (1 - sx) + g10 * sx;
      const bot = g01 * (1 - sx) + g11 * sx;
      out[y * width + x] = top * (1 - sy) + bot * sy;
    }
  }
  return out;
}

/** Suma `octaves` capas de valueNoiseLayer a frecuencia creciente / amplitud decreciente, normalizado a media ponderada. */
function fractalNoise(width, height, baseCell, octaves, seed) {
  const out = new Float32Array(width * height);
  let amp = 1;
  let ampSum = 0;
  let cell = baseCell;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoiseLayer(width, height, Math.max(2, Math.round(cell)), seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    ampSum += amp;
    amp *= 0.5;
    cell = Math.max(2, cell / 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= ampSum;
  return out;
}

/** Min/max de un Float32Array, para normalize(). */
function minMax(arr) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

function normalize(arr) {
  const [min, max] = minMax(arr);
  const range = max - min || 1e-9;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - min) / range;
  return out;
}

module.exports = { mulberry32, valueNoiseLayer, fractalNoise, normalize, minMax };
