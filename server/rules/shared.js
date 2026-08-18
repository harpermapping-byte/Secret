'use strict';

const { ACTION_INDUSTRY, ACTION_ATTACK, ACTION_DEFEND } = require('../commands');

// Rango de azar por unidad al calcular fuerza de combate. Valor de ejemplo,
// pendiente de afinar (ver docs/GDD seccion 11 "Pendiente").
const COMBAT_RANDOM_MIN = 0.5;
const COMBAT_RANDOM_MAX = 1.5;

/** Suma `count` tiradas aleatorias en [COMBAT_RANDOM_MIN, COMBAT_RANDOM_MAX]. */
function sumRandomPower(count) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += COMBAT_RANDOM_MIN + Math.random() * (COMBAT_RANDOM_MAX - COMBAT_RANDOM_MIN);
  }
  return total;
}

/**
 * Reparte `count` bajas dentro de una faccion siguiendo la prioridad fija:
 * inactivos -> industria -> atacantes propios -> defensores.
 * `inactiveUserIds` es la union de "no puso comando" + "forceInactive" (alianza/especial fallidos).
 */
function applyCasualties(match, context, factionNumber, count) {
  if (count <= 0) return 0;

  const bucket = context.votesByFactionAndType.get(factionNumber);
  const factionInactive = [...context.allInactiveUserIds].filter(
    (userId) => match.players.get(userId)?.factionNumber === factionNumber
  );

  const pools = [
    shuffle(factionInactive),
    shuffle([...bucket[ACTION_INDUSTRY]]),
    shuffle([...bucket[ACTION_ATTACK].values()].flat()),
    shuffle([...bucket[ACTION_DEFEND]]),
  ];

  let remaining = count;
  let killed = 0;
  for (const pool of pools) {
    while (remaining > 0 && pool.length > 0) {
      const userId = pool.pop();
      if (killPlayer(match, userId)) killed++;
      remaining--;
    }
  }
  return killed;
}

function killPlayer(match, userId) {
  const player = match.players.get(userId);
  if (!player || !player.alive) return false;
  player.alive = false;
  player.diedOnRound = match.round;
  return true;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = { sumRandomPower, applyCasualties, killPlayer, shuffle };
