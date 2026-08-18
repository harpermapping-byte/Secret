'use strict';

const { ACTION_EXPAND } = require('../commands');
const { transferTile, pickExpandableNeutralTile } = require('./territory');

/**
 * Resuelve !expansion: si el % de votantes activos de una faccion supera el
 * umbral configurado, conquista automaticamente una casilla neutral
 * fronteriza al azar. Sin efecto si el mapa es de reparto total (no hay
 * neutral).
 */
function resolveExpansion(match, context) {
  if (match.config.map.mode === 'total') return;

  const thresholdPercent = match.config.thresholds.expandPercent;

  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_EXPAND];
    const activeCount = context.activePlayerCountByFaction.get(faction.number) || 0;
    const percent = activeCount > 0 ? (votes.length / activeCount) * 100 : 0;
    if (percent < thresholdPercent) continue;

    const tile = pickExpandableNeutralTile(match, faction.number);
    if (tile) {
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

module.exports = { resolveExpansion };
