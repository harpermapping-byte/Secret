'use strict';

const { ACTION_ATTACK, ACTION_ALLIANCE } = require('../commands');

/**
 * Resuelve intentos de alianza de la ronda y anula los ataques que quedan
 * bloqueados por una alianza activa. Ver docs/ACCIONES.md seccion 3.
 *
 * Muta: match.activeAlliancePairsThisRound (Set de "A-B" con A<B),
 *       context.forceInactive (usuarios cuyo voto queda anulado esta ronda).
 */
function resolveAlliances(match, context) {
  match.activeAlliancePairsThisRound = new Set();
  if (!match.config.alliancesEnabled) return;

  const thresholdPercent = match.config.thresholds.alliancePercent;

  for (const faction of match.factions) {
    const allianceVotes = context.votesByFactionAndType.get(faction.number)[ACTION_ALLIANCE];
    for (const [targetNumber, userIds] of allianceVotes) {
      const activeCount = context.activePlayerCountByFaction.get(faction.number) || 0;
      const percent = activeCount > 0 ? (userIds.length / activeCount) * 100 : 0;
      if (percent >= thresholdPercent) {
        match.activeAlliancePairsThisRound.add(pairKey(faction.number, targetNumber));
      } else {
        userIds.forEach((userId) => context.forceInactive.add(userId));
      }
    }
  }

  for (const faction of match.factions) {
    const attackVotes = context.votesByFactionAndType.get(faction.number)[ACTION_ATTACK];
    for (const [targetNumber, userIds] of [...attackVotes.entries()]) {
      if (match.activeAlliancePairsThisRound.has(pairKey(faction.number, targetNumber))) {
        userIds.forEach((userId) => context.forceInactive.add(userId));
        attackVotes.delete(targetNumber);
      }
    }
  }
}

function pairKey(a, b) {
  return [a, b].sort((x, y) => x - y).join('-');
}

module.exports = { resolveAlliances };
