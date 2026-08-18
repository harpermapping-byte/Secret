'use strict';

/**
 * Empaqueta `cellTileIds` (un id de tile por celda del raster, o OCEAN=-1)
 * en un formato binario compacto en vez de mandarlo como array JSON plano —
 * a la resolución actual del mapa (4400x2302 = 10.128.800 celdas) el array
 * JSON pesa ~27,5MB por mensaje, mandado a cada cliente conectado. Empaquetar
 * a 1-2 bytes/celda y codificar en base64 (mismo técnica que
 * `server/worldLandMask.js`) reduce el peso a la mitad aprox., y sobre todo
 * cambia CÓMO lo parsea el navegador: en vez de que `JSON.parse` procese 10
 * millones de números sueltos (lo caro de verdad, más que el peso en bytes),
 * pasa a parsear un único string largo. Contrapartida de "opción B" (parche
 * de transporte) frente a "opción A" (mandar una imagen ya renderizada,
 * discutida en docs/ACCIONES.md pero no implementada todavía) — sigue
 * habiendo un pintado en canvas por cliente, esto solo abarata la transmisión
 * y el parseo del layout.
 *
 * Formato (documentado también en docs/ACCIONES.md sección 6 — cualquier
 * cambio aquí hay que reflejarlo en `public/mapRenderer.js` `decodeCellTileIds()`,
 * que tiene que decodificar exactamente igual):
 *   OCEAN (-1) se codifica como 0; un tile id N se codifica como N+1.
 *   Si (tileCount+1) cabe en un byte (tileCount <= 255) -> 1 byte/celda.
 *   Si no -> 2 bytes/celda, big-endian (hasta 65534 territorios).
 */

const MAX_SUPPORTED_TILE_COUNT = 65534;

function encodeCellTileIds(cellTileIds, tileCount) {
  if (tileCount > MAX_SUPPORTED_TILE_COUNT) {
    throw new Error(`encodeCellTileIds: demasiados territorios (${tileCount}) para el formato compacto (máximo ${MAX_SUPPORTED_TILE_COUNT})`);
  }
  const bytesPerCell = tileCount + 1 <= 256 ? 1 : 2;
  const buf = Buffer.alloc(cellTileIds.length * bytesPerCell);

  if (bytesPerCell === 1) {
    for (let i = 0; i < cellTileIds.length; i++) {
      buf[i] = cellTileIds[i] + 1; // OCEAN(-1) -> 0, tile N -> N+1
    }
  } else {
    for (let i = 0; i < cellTileIds.length; i++) {
      buf.writeUInt16BE(cellTileIds[i] + 1, i * 2);
    }
  }

  return { bytesPerCell, base64: buf.toString('base64') };
}

module.exports = { encodeCellTileIds, MAX_SUPPORTED_TILE_COUNT };
