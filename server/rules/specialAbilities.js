'use strict';

const { ACTION_SPECIAL, ACTION_ATTACK } = require('../commands');
const { factionsAreAdjacent } = require('./territory');
const { shuffle } = require('./shared');

// Valores de ejemplo, pendientes de afinar (ver docs/GDD seccion 11).
const REFUERZO_REVIVE_COUNT = 3;
const ESCUDO_DEFENSE_BONUS_PERCENT = 30;
const FRENESI_ATTACK_BONUS_PERCENT = 30;
// hab5 "Fervor" (ver docs/ACCIONES.md sección 39): empujón de industria de
// golpe, una única vez, al activarse.
const FERVOR_INDUSTRY_BOOST_PERCENT = 30;
// hab6 "Muralla" (ver docs/ACCIONES.md sección 39): +1 de defensa pasiva
// PERMANENTE (a diferencia de Escudo, que es +30% y solo dura la ronda en
// que se activa) — quinta excepción a "el territorio no se defiende solo"
// en rules/combat.js, mismo patrón que torres/maravillas/museos.
const MURALLA_DEFENSE_BONUS = 1;

/**
 * Catálogo de las 6 habilidades (ver docs/ACCIONES.md sección 35/39): una se
 * le asigna AL AZAR a cada facción al crear la partida (con repetición — con
 * más de 6 facciones, varias comparten la misma). Activable una única vez
 * por partida (`specialUsed`) cuando `!especial` llega al % de votantes
 * configurado — ver `resolveSpecialAbilities()` más abajo.
 *   hab1 'Refuerzo' -> revive a los 3 últimos jugadores caídos de la facción
 *   hab2 'Escudo'   -> +30% de defensa esta ronda
 *   hab3 'Frenesí'  -> +30% de ataque esta ronda
 *   hab4 'Sabotaje' -> -toda la industria de la ronda siguiente al objetivo
 *   hab5 'Fervor'   -> +30% de industria de golpe, una vez
 *   hab6 'Muralla'  -> +1 de defensa pasiva PERMANENTE el resto de la partida
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
    case 'hab1': // Refuerzo
      return applyRefuerzo(match, faction);
    case 'hab2': // Escudo
      match.combatModifiers[faction.number] = {
        ...match.combatModifiers[faction.number],
        defenseBonusPercent: ESCUDO_DEFENSE_BONUS_PERCENT,
      };
      return;
    case 'hab3': // Frenesí
      match.combatModifiers[faction.number] = {
        ...match.combatModifiers[faction.number],
        attackBonusPercent: FRENESI_ATTACK_BONUS_PERCENT,
      };
      return;
    case 'hab4': // Sabotaje
      return applySabotaje(match, context, faction);
    case 'hab5': // Fervor: empujón de industria de golpe, una única vez.
      faction.industry += faction.industry * (FERVOR_INDUSTRY_BOOST_PERCENT / 100);
      return;
    case 'hab6': // Muralla: +1 de defensa pasiva permanente (ver muralla flag + specialAbilityDefenseBonus()).
      faction.muralla = true;
      return;
    default:
      return; // defensivo: no debería pasar, ABILITY_POOL solo tiene hab1-hab6
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

/** +1 de defensa pasiva PERMANENTE si la facción activó hab6 "Muralla" — ver rules/combat.js. */
function specialAbilityDefenseBonus(faction) {
  return faction.muralla ? MURALLA_DEFENSE_BONUS : 0;
}

module.exports = { resolveSpecialAbilities, specialAbilityDefenseBonus, ABILITY_POOL, pickRandomAbility };
