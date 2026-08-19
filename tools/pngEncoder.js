'use strict';

/**
 * Codificador de PNG hecho a mano, sin librerias de imagenes — mismo
 * criterio que `server/worldLandMask.js` (que ya empaqueta/desempaqueta un
 * bitmap a mano) y que la "opcion A" apuntada en docs/ACCIONES.md seccion 8.
 * Usa unicamente el modulo nativo `zlib` de Node (ya viene con Node, no es
 * una dependencia externa) para el `deflate` que exige el formato PNG.
 *
 * Soporta un unico caso de uso, el que necesita este proyecto: una imagen
 * RGB de 8 bits por canal, sin transparencia, sin paleta, con cada scanline
 * sin filtro (filtro 0 = "None"). Es la codificacion PNG mas simple posible
 * — para mapas de color con zonas de textura (no fotografia), zlib igualmente
 * comprime muy bien sin necesitar los filtros mas listos (Sub/Up/Paeth).
 *
 * Uso:
 *   const { encodePNG } = require('./pngEncoder');
 *   const rgbBuffer = new Uint8Array(width * height * 3); // RGB por pixel
 *   fs.writeFileSync('salida.png', encodePNG(width, height, rgbBuffer));
 */

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Tabla CRC-32 estandar (la misma que usa PNG/zlib/gzip) — se calcula una
// vez al cargar el modulo, no en cada chunk.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb - width*height*3 bytes, RGB por pixel, fila por fila
 * @returns {Buffer} el archivo .png completo, listo para escribir a disco
 */
function encodePNG(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePNG: se esperaban ${width * height * 3} bytes (RGB), llegaron ${rgb.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // profundidad de bits por canal
  ihdr[9] = 2;   // tipo de color 2 = RGB (sin paleta, sin alfa)
  ihdr[10] = 0;  // metodo de compresion (unico valor valido)
  ihdr[11] = 0;  // metodo de filtro (unico valor valido)
  ihdr[12] = 0;  // interlace = ninguno

  // Cada scanline lleva un byte de filtro delante (0 = "sin filtro", el mas
  // simple) seguido de sus width*3 bytes RGB.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filtro None
    raw.set(rgb.subarray(y * stride, y * stride + stride), rowStart + 1);
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Igual que encodePNG() pero con canal alfa (RGBA, tipo de color 6) — hace
 * falta para texturas de UI que no son un rectangulo solido (madera con
 * borde irregular, chapa de metal con esquinas redondeadas) y necesitan que
 * se vea lo que hay detras (la pagina, la madera) por los huecos
 * transparentes. `encodePNG()` (RGB, sin alfa) se deja tal cual para quien
 * no necesite transparencia (el terreno horneado, world.png, es opaco).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba - width*height*4 bytes, RGBA por pixel, fila por fila
 * @returns {Buffer}
 */
function encodePNGRGBA(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePNGRGBA: se esperaban ${width * height * 4} bytes (RGBA), llegaron ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // profundidad de bits por canal
  ihdr[9] = 6;   // tipo de color 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filtro None
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePNG, encodePNGRGBA };
