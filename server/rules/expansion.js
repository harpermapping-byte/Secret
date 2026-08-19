'use strict';

const { ACTION_EXPAND } = require('../commands');
const { transferTile, pickExpandableNeutralTile } = require('./territory');

// Cuantos usuarios hacen falta por cada casilla neutral nueva: con 1 o 2
// votos se gana 1 casilla, con 4 se ganan 2, con 6 tres... (ver
// tilesWonByVotes). Un unico votante ya consigue casilla — el minimo de 2 es
// el "precio" de CADA casilla a partir de la primera, no un requisito para
// empezar a expandirse.
const VOTES_PER_NEW_TILE = 2;

/**
 * Resuelve !expansion: cada faccion se queda con tantas casillas neutrales
 * fronterizas (elegidas al azar entre las que tocan su territorio) como le
 * permitan sus votos de `!expansion` esta ronda. No hay umbral de porcentaje:
 * lo que manda es el numero de votantes, ver tilesWonByVotes(). Sin efecto si
 * el mapa es de reparto total (no hay territorio neutral que tomar).
 */
function resolveExpansion(match, context) {
  if (match.config.map.mode === 'total') return;

  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;

    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_EXPAND];
    const tilesToWin = tilesWonByVotes(votes.length);

    // Una casilla por vuelta, no todas de golpe: al conquistar una casilla la
    // frontera de la faccion cambia, asi que la siguiente se sortea ya sobre
    // la frontera nueva (permite avanzar en cadena hacia dentro del territorio
    // neutral en vez de repartirse solo por el borde inicial).
    for (let i = 0; i < tilesToWin; i++) {
      const tile = pickExpandableNeutralTile(match, faction.number);
      if (!tile) break; // sin casillas neutrales fronterizas: no hay adonde crecer
      transferTile(match, tile.id, faction.number);
      context.roundEvents.conquests.push({
        tileId: tile.id,
        fromFactionNumber: null,
        toFactionNumber: faction.number,
        kind: 'expansion',
      });
    }
  }
}

/**
 * Casillas nuevas que dan `voteCount` votos de `!expansion`:
 * 0 votos -> 0 casillas; 1 o 2 -> 1; 3 -> 1; 4 o 5 -> 2; 6 -> 3...
 * (funcion pura, sin estado de partida: facil de comprobar de un vistazo).
 */
function tilesWonByVotes(voteCount) {
  if (voteCount <= 0) return 0;
  return Math.max(1, Math.floor(voteCount / VOTES_PER_NEW_TILE));
}

module.exports = { resolveExpansion, tilesWonByVotes, VOTES_PER_NEW_TILE };
