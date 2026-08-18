'use strict';

/**
 * Generador de tablero placeholder para la demo v1.
 * Las plantillas de mapa "de verdad" (arte + disenio a mano) son trabajo futuro
 * (ver docs/GDD, seccion 11). Por ahora el tablero es un anillo de casillas
 * numeradas con adyacencia circular, suficiente para probar todas las reglas
 * sin depender de arte final.
 *
 * Forma de una Tile: { id, neighborIds: [id, id], ownerFactionNumber: number|null, neutral: bool, garrison: number }
 */

const NEUTRAL_GARRISON = 3;

function buildRingAdjacency(tileCount) {
  const neighborIds = [];
  for (let i = 0; i < tileCount; i++) {
    const prev = (i - 1 + tileCount) % tileCount;
    const next = (i + 1) % tileCount;
    neighborIds.push([prev, next]);
  }
  return neighborIds;
}

/**
 * modo: 'total' (todo el mapa repartido, sin neutral) o 'neutral' (zonas pequenas + territorio neutral)
 */
function generateMap({ tileCount, factionCount, mode }) {
  if (factionCount < 2) throw new Error('generateMap: se necesitan al menos 2 facciones');
  if (tileCount < factionCount * 2) throw new Error('generateMap: tileCount demasiado pequenio para factionCount');

  const neighborIds = buildRingAdjacency(tileCount);
  const ownerByTile = new Array(tileCount).fill(null);

  if (mode === 'total') {
    // Reparto total: el anillo se divide en factionCount arcos contiguos.
    const zoneSize = Math.floor(tileCount / factionCount);
    for (let f = 0; f < factionCount; f++) {
      const start = f * zoneSize;
      const end = f === factionCount - 1 ? tileCount : start + zoneSize;
      for (let i = start; i < end; i++) ownerByTile[i] = f + 1; // numero de faccion, 1-indexado
    }
  } else {
    // Zonas pequenias + neutral: cada faccion recibe 2 casillas, repartidas de forma equidistante.
    const zoneSizePerFaction = 2;
    const spacing = Math.floor(tileCount / factionCount);
    for (let f = 0; f < factionCount; f++) {
      const start = f * spacing;
      for (let i = 0; i < zoneSizePerFaction; i++) {
        ownerByTile[(start + i) % tileCount] = f + 1;
      }
    }
  }

  const tiles = [];
  for (let i = 0; i < tileCount; i++) {
    const owner = ownerByTile[i];
    tiles.push({
      id: i,
      neighborIds: neighborIds[i],
      ownerFactionNumber: owner,
      neutral: owner === null,
      garrison: owner === null ? NEUTRAL_GARRISON : 0,
    });
  }

  return { tiles, mode };
}

module.exports = { generateMap, NEUTRAL_GARRISON };
