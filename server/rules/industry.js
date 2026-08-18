'use strict';

const { ACTION_INDUSTRY } = require('../commands');
const { applyCasualties, shuffle } = require('./shared');
const { factionsAreAdjacent, factionByNumber } = require('./territory');

// Valores de ejemplo, pendientes de afinar (ver docs/GDD seccion 11).
const PASSIVE_INDUSTRY_PER_TERRITORY = 0.2;
const BOMBARDEO_DAMAGE = 3;
const OPESPECIAL_DAMAGE = 3;

// Las 4 mejoras, en orden fijo. threshold = industria acumulada necesaria.
const INDUSTRY_TIERS = [
  { key: 'tanque', threshold: 100 },
  { key: 'bombardeo', threshold: 250 },
  { key: 'tanque_x2', threshold: 500 },
  { key: 'operacion_especial', threshold: 800 },
];

/**
 * Suma la industria de la ronda por faccion y desbloquea, en orden, las
 * mejoras cuyo umbral se alcance. Cada mejora se aplica una unica vez
 * (ver docs/GDD seccion 6 "Industria y las 4 mejoras").
 */
function resolveIndustry(match, context) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;

    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_INDUSTRY].length;
    const passive = faction.territoryIds.length * PASSIVE_INDUSTRY_PER_TERRITORY;
    const gained = faction.industryPenaltyNextRound ? 0 : votes + passive;
    faction.industryPenaltyNextRound = false;

    faction.industry += gained;
    faction.industryGainedLastRound = gained;

    while (
      faction.industryTierIndex < INDUSTRY_TIERS.length &&
      faction.industry >= INDUSTRY_TIERS[faction.industryTierIndex].threshold
    ) {
      applyIndustryTier(match, context, faction, INDUSTRY_TIERS[faction.industryTierIndex].key);
      faction.industryTierIndex++;
    }
  }
}

function applyIndustryTier(match, context, faction, tierKey) {
  context.roundEvents.industryUnlocks.push({ factionNumber: faction.number, tierKey });
  switch (tierKey) {
    case 'tanque':
      return upgradeRandomSoldiers(match, faction, 1, { prioritizeParticipation: false });
    case 'bombardeo':
      return applyBombardeo(match, context, faction);
    case 'tanque_x2':
      return upgradeRandomSoldiers(match, faction, 2, { prioritizeParticipation: true });
    case 'operacion_especial':
      return applyOperacionEspecial(match, context, faction);
    default:
      return;
  }
}

function upgradeRandomSoldiers(match, faction, count, { prioritizeParticipation }) {
  const soldiers = [...match.players.values()].filter(
    (p) => p.alive && p.factionNumber === faction.number && p.unitType === 'soldier'
  );
  const ordered = prioritizeParticipation
    ? soldiers.filter((p) => p.participation > 0).sort((a, b) => b.participation - a.participation)
    : shuffle(soldiers);

  const chosen = ordered.length >= count ? ordered.slice(0, count) : shuffle(soldiers).slice(0, count);
  chosen.forEach((player) => {
    player.unitType = 'tank';
  });
}

function applyBombardeo(match, context, faction) {
  // Simplificacion v1: usa la prioridad de bajas normal de esta ronda (inactivos primero)
  // en vez de la actividad de la ronda anterior. Pendiente de afinar si hace falta mas precision.
  const targetNumber = match.lastAttackerOf[faction.number];
  if (!targetNumber) return;
  const targetFaction = factionByNumber(match, targetNumber);
  if (!targetFaction || targetFaction.territoryIds.length === 0) return;
  applyCasualties(match, context, targetNumber, BOMBARDEO_DAMAGE, faction.number);
}

function applyOperacionEspecial(match, context, faction) {
  const adjacentEnemies = match.factions.filter(
    (f) => f.number !== faction.number && f.territoryIds.length > 0 && factionsAreAdjacent(match, faction.number, f.number)
  );
  const target = shuffle(adjacentEnemies)[0];
  if (!target) return;
  applyCasualties(match, context, target.number, OPESPECIAL_DAMAGE, faction.number);
}

module.exports = { resolveIndustry, INDUSTRY_TIERS };
