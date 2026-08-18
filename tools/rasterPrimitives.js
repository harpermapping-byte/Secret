'use strict';

/**
 * Primitivas de rasterizado hechas a mano, lo minimo necesario para estampar
 * los objetos de decoracion (arboles, rocas, arbustos, conchas, palmeras...)
 * directamente sobre un buffer RGB plano — Node puro no trae nada tipo
 * Canvas/PIL, asi que esto es el equivalente casero de `ImageDraw` que usaba
 * el prototipo en Python, pero solo con lo que de verdad hace falta: los
 * objetos son de pocos pixeles cada uno, no hace falta que sea generico.
 */

function setPx(rgb, W, H, x, y, r, g, b) {
  x |= 0; y |= 0;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
}

function fillEllipse(rgb, W, H, cx, cy, rx, ry, color) {
  if (rx <= 0 || ry <= 0) return;
  const [r, g, b] = color;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const ny = (y - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const nx = (x - cx) / rx;
      if (nx * nx + ny * ny <= 1) setPx(rgb, W, H, x, y, r, g, b);
    }
  }
}

// Linea con grosor, hecha caminando por pasos e imprimiendo una elipse
// pequeña en cada uno cuando el grosor pide mas de un pixel — no es
// Bresenham "de libro" pero para trazos de pocos pixeles (troncos, ramas)
// se ve identico y es mucho mas simple.
function drawLine(rgb, W, H, x0, y0, x1, y1, color, width) {
  const [r, g, b] = color;
  const w = Math.max(1, width || 1);
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + dx * t, py = y0 + dy * t;
    if (w <= 1.5) setPx(rgb, W, H, Math.round(px), Math.round(py), r, g, b);
    else fillEllipse(rgb, W, H, px, py, w / 2, w / 2, color);
  }
}

// Relleno de poligono por scanline (par-impar) — solo hace falta para las
// copas triangulares de los pinos.
function fillPolygon(rgb, W, H, points, color) {
  const [r, g, b] = color;
  let minY = Infinity, maxY = -Infinity;
  for (const [, py] of points) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  const n = points.length;
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % n];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
        const t = (yc - y1) / (y2 - y1);
        xs.push(x1 + t * (x2 - x1));
      }
    }
    xs.sort((a, b2) => a - b2);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(W - 1, Math.round(xs[i + 1]));
      for (let x = xa; x <= xb; x++) setPx(rgb, W, H, x, y, r, g, b);
    }
  }
}

// Puntos a lo largo de un arco (para conchas) — no rellena, solo traza el
// borde, como el `draw.arc(...)` de PIL pero calculado a mano con seno/coseno.
function drawArcPoints(rgb, W, H, cx, cy, r, startDeg, endDeg, color) {
  const [rr, gg, bb] = color;
  const steps = Math.max(4, Math.round(r * 2));
  for (let s = 0; s <= steps; s++) {
    const deg = startDeg + (endDeg - startDeg) * (s / steps);
    const rad = (deg * Math.PI) / 180;
    const x = cx + Math.cos(rad) * r;
    const y = cy + Math.sin(rad) * r;
    setPx(rgb, W, H, Math.round(x), Math.round(y), rr, gg, bb);
  }
}

module.exports = { setPx, fillEllipse, drawLine, fillPolygon, drawArcPoints };
