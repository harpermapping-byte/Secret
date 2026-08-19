'use strict';

/**
 * Genera los PNG *placeholder* de los elementos decorativos del mapa
 * (castillos, puertos, aldeas, arboles, barcos, ballenas, kraken) y del
 * cursor del raton. Script de DESARROLLO: se ejecuta a mano una vez
 * (`node tools/bakeSpritePlaceholders.js`) y deja los archivos en
 * `public/sprites/`.
 *
 * SON PLACEHOLDERS A PROPOSITO: formas planas de color con borde oscuro, tal
 * y como se pidieron (cuadrado para castillo, cuadrado gris para aldea,
 * rectangulo vertical para arbol, rectangulo azul para ballena...). La gracia
 * es que el juego los carga como IMAGENES, no como formas dibujadas en
 * codigo: para poner el arte definitivo basta con **sobrescribir el .png
 * correspondiente en `public/sprites/` con el tuyo y recargar**, sin tocar
 * una linea de codigo ni volver a ejecutar este script.
 *
 * Si el arte nuevo tiene otra proporcion, lo unico que puede hacer falta
 * ajustar es el tamaño con el que se dibuja en el mapa: `DECOR_SPRITES` en
 * `public/mapRenderer.js` (una linea por tipo, con su ancho en pixeles de
 * mundo). La altura sale sola del aspecto real del PNG.
 *
 * Los sprites se dibujan anclados por su BASE (abajo-centro), como en
 * cualquier juego 2.5D: asi un castillo alto "se apoya" en el suelo en vez de
 * quedar centrado sobre su punto.
 */

const fs = require('fs');
const path = require('path');
const { encodePNGRGBA } = require('./pngEncoder');

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/** Lienzo RGBA vacio (todo transparente) con helpers de dibujo minimos. */
function createCanvas(w, h) {
  const px = new Uint8Array(w * h * 4);

  function set(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    px[i] = clamp255(r); px[i + 1] = clamp255(g); px[i + 2] = clamp255(b); px[i + 3] = clamp255(a);
  }

  /** Rectangulo relleno con borde oscuro de `border` px y un leve sombreado vertical. */
  function rect(x0, y0, rw, rh, color, border = 2, borderColor = [24, 18, 12]) {
    for (let y = y0; y < y0 + rh; y++) {
      for (let x = x0; x < x0 + rw; x++) {
        const onBorder = x < x0 + border || x >= x0 + rw - border || y < y0 + border || y >= y0 + rh - border;
        if (onBorder) { set(x, y, borderColor); continue; }
        // Sombreado: mas claro arriba, mas oscuro abajo — da algo de volumen
        // sin dejar de ser una forma plana de placeholder.
        const t = (y - y0) / Math.max(1, rh - 1);
        const shade = 1.12 - t * 0.3;
        set(x, y, [color[0] * shade, color[1] * shade, color[2] * shade]);
      }
    }
  }

  /** Triangulo relleno por sus 3 vertices (usado para el cursor y las velas). */
  function triangle(ax, ay, bx, by, cx, cy, color, borderColor) {
    const minX = Math.floor(Math.min(ax, bx, cx)), maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy)), maxY = Math.ceil(Math.max(ay, by, cy));
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area === 0) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area;
        const w1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        // Cerca de cualquier arista -> color de borde
        const edge = Math.min(w0, w1, 1 - w0 - w1);
        set(x, y, borderColor && edge < 0.06 ? borderColor : color);
      }
    }
  }

  return { px, w, h, set, rect, triangle, toPNG: () => encodePNGRGBA(w, h, px) };
}

// ---------------------------------------------------------------------------
// Definicion de cada placeholder. Cambiar aqui solo afecta al PNG generado;
// el juego se limita a cargar el archivo que haya en public/sprites/.
// ---------------------------------------------------------------------------
const SPRITES = {
  // TIERRA
  castle: (c) => {          // cuadrado rojizo con dos torres, 48x48
    c.rect(6, 14, 36, 34, [138, 59, 59]);
    c.rect(2, 4, 12, 20, [116, 48, 48]);
    c.rect(34, 4, 12, 20, [116, 48, 48]);
  },
  port: (c) => {            // cuadrado ambar con un pantalan, 40x40
    c.rect(4, 12, 32, 26, [201, 138, 58]);
    c.rect(14, 2, 4, 14, [90, 66, 30], 1);
    c.rect(10, 2, 16, 4, [120, 88, 40], 1);
  },
  village: (c) => {         // cuadrado gris (como se pidio), 32x32
    c.rect(3, 8, 26, 22, [154, 154, 154]);
    c.rect(11, 2, 10, 8, [124, 124, 124]);
  },
  tree: (c) => {            // rectangulo vertical verde, 22x40
    c.rect(8, 26, 6, 14, [74, 52, 32], 1); // tronco
    c.rect(2, 0, 18, 28, [47, 107, 52]);   // copa
  },

  // AGUA
  'ship-small': (c) => {    // casco claro + vela, 30x22
    c.rect(2, 12, 26, 9, [216, 210, 196]);
    c.rect(14, 2, 3, 11, [90, 74, 52], 1);
    c.triangle(16, 3, 26, 12, 16, 12, [238, 234, 224], [60, 50, 38]);
  },
  'ship-big': (c) => {      // casco mayor + dos velas, 46x28
    c.rect(2, 16, 42, 11, [184, 174, 152]);
    c.rect(12, 2, 3, 15, [80, 64, 44], 1);
    c.rect(30, 5, 3, 12, [80, 64, 44], 1);
    c.triangle(14, 3, 26, 16, 14, 16, [236, 230, 216], [60, 50, 38]);
    c.triangle(32, 6, 42, 16, 32, 16, [236, 230, 216], [60, 50, 38]);
  },
  whale: (c) => {           // rectangulo azul (como se pidio) + cola, 48x18
    c.rect(0, 4, 38, 13, [47, 95, 168]);
    c.triangle(37, 2, 47, 9, 37, 16, [40, 80, 142], [20, 34, 60]);
  },
  kraken: (c) => {          // masa mayor con tentaculos, 96x96
    c.rect(30, 20, 36, 40, [106, 63, 143]);
    for (let i = 0; i < 4; i++) {
      c.rect(8 + i * 22, 58, 10, 30 - i * 4, [88, 50, 122], 2);
    }
  },

  // CURSOR DEL RATON (fuera del mapa: lo usa el CSS, ver public/shared.css)
  cursor: (c) => {          // triangulo blanco con borde oscuro, 32x32
    c.triangle(1, 1, 1, 27, 20, 20, [245, 245, 245], [26, 22, 18]);
  },
};

const SIZES = {
  castle: [48, 48], port: [40, 40], village: [32, 32], tree: [22, 40],
  'ship-small': [30, 22], 'ship-big': [46, 28], whale: [48, 18], kraken: [96, 96],
  cursor: [32, 32],
};

if (require.main === module) {
  const outDir = path.join(__dirname, '..', 'public', 'sprites');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, draw] of Object.entries(SPRITES)) {
    const [w, h] = SIZES[name];
    const canvas = createCanvas(w, h);
    draw(canvas);
    fs.writeFileSync(path.join(outDir, `${name}.png`), canvas.toPNG());
  }
  console.log(`placeholders escritos en ${outDir}: ${Object.keys(SPRITES).join(', ')}`);
}

module.exports = { SPRITES, SIZES };
