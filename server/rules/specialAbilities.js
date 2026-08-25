'use strict';

const { ACTION_SPECIAL, ACTION_ATTACK } = require('../commands');
const { factionsAreAdjacent } = require('./territory');
const { shuffle } = require('./shared');

// Valores de ejemplo, pendientes de afinar (ver docs/GDD seccion 11).
const REFUERZO_REVIVE_COUNT = 3;
const ESCUDO_DEFENSE_BONUS_PERCENT = 30;
const FRENESI_ATTACK_BONUS_PERCENT = 30;

/**
 * Catálogo nuevo (ver docs/ACCIONES.md sección 35): 6 habilidades, una se le
 * asigna AL AZAR a cada facción al crear la partida (con repetición — con
 * más de 6 facciones, varias comparten la misma), en vez de que el admin
 * elija una por facción como antes. Todavía sin efecto definido a propósito
 * ("hab1".."hab6" son marcador, se deciden los efectos más adelante) —
 * `applyAbility()` de abajo las deja caer en el `default: return;` sin
 * romper nada mientras tanto, así que activar `!especial` en una facción con
 * una de estas asignadas simplemente no hace nada todavía (gasta igualmente
 * el único uso de la partida, `specialUsed`, como cualquier otra).
 */
const ABILITY_POOL = ['hab1', 'hab2', 'hab3', 'hab4', 'hab5', 'hab6'];

function pickRandomAbility() {
  return ABILITY_POOL[Math.floor(Math.random() * ABILITY_POOL.length)];
}

/**
 * Comprueba, para cada faccion con habilidad especial habilitada y no usada
 * todavia, si llega al % de !especial de esta ronda. Si llega, aplica el
 * efecto y marca specialUsed = true (una unica vez por partida). Si no llega,
 * esos votantes cuentan como inactivos esta ronda (igual que alianza fallida).
 */
function resolveSpecialAbilities(match, context) {
  match.combatModifiers = {}; // se reinicia cada ronda; solo dura la ronda en que se activa

  const thresholdPercent = match.config.thresholds.specialPercent;

  for (const faction of match.factions) {
    if (!faction.specialEnabled || faction.specialUsed) continue;

    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_SPECIAL];
    if (votes.length === 0) continue;

    const activeCount = context.activePlayerCountByFaction.get(faction.number) || 0;
    const percent = activeCount > 0 ? (votes.length / activeCount) * 100 : 0;

    if (percent < thresholdPercent) {
      votes.forEach((userId) => context.forceInactive.add(userId));
      continue;
    }

    applyAbility(match, context, faction);
    faction.specialUsed = true;
  }
}

function applyAbility(match, context, faction) {
  switch (faction.specialAbility) {
    case 'refuerzo':
      return applyRefuerzo(match, faction);
    case 'escudo':
      match.combatModifiers[faction.number] = {
        ...match.combatModifiers[faction.number],
        defenseBonusPercent: ESCUDO_DEFENSE_BONUS_PERCENT,
      };
      return;
    case 'frenesi':
      match.combatModifiers[faction.number] = {
        ...match.combatModifiers[faction.number],
        attackBonusPercent: FRENESI_ATTACK_BONUS_PERCENT,
      };
      return;
    case 'sabotaje':
      return applySabotaje(match, context, faction);
    default:
      return; // habilidad no configurada: no hace nada
  }
}

function applyRefuerzo(match, faction) {
  const fallen = [...match.players.values()]
    .filter((p) => !p.alive && p.factionNumber === faction.number)
    .sort((a, b) => (b.diedOnRound || 0) - (a.diedOnRound || 0));

  fallen.slice(0, REFUERZO_REVIVE_COUNT).forEach((player) => {
    player.alive = true;
  });
}

function applySabotaje(match, context, faction) {
  const attackVotes = context.votesByFactionAndType.get(faction.number)[ACTION_ATTACK];
  let targetNumber = [...attackVotes.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];

  if (!targetNumber) {
    const adjacentEnemies = match.factions.filter(
      (f) => f.number !== faction.number && f.territoryIds.length > 0 && factionsAreAdjacent(match, faction.number, f.number)
    );
    targetNumber = shuffle(adjacentEnemies)[0]?.number;
  }

  const targetFaction = match.factions.find((f) => f.number === targetNumber);
  if (targetFaction) targetFaction.industryPenaltyNextRound = true;
}

module.exports = { resolveSpecialAbilities, ABILITY_POOL, pickRandomAbility };
