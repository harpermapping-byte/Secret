'use strict';

const { ACTION_INDUSTRY, ACTION_ATTACK, ACTION_DEFEND } = require('../commands');
const { factionByNumber } = require('./territory');

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
 * `causedByFactionNumber` (opcional) es la faccion responsable de estas bajas: si se indica, se le
 * suma a su contador `killsCaused` (ver docs/ACCIONES.md seccion 6), usado en la clasificacion.
 */
function applyCasualties(match, context, factionNumber, count, causedByFactionNumber = null) {
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

  // OJO: `pools` puede incluir userIds que un `applyCasualties()` anterior
  // dentro de la MISMA ronda ya haya matado (p.ej. una faccion que pierde dos
  // combates distintos a la vez: ambos combates parten de los mismos votos de
  // esa faccion). `remaining` solo debe bajar cuando de verdad se mata a
  // alguien vivo — si no, una baja ya contabilizada por otro combate "se
  // come" el hueco y la faccion termina con menos bajas totales de las que
  // tocaban.
  let remaining = count;
  let killed = 0;
  for (const pool of pools) {
    while (remaining > 0 && pool.length > 0) {
      const userId = pool.pop();
      if (killPlayer(match, userId)) {
        killed++;
        remaining--;
      }
    }
  }

  if (killed > 0 && causedByFactionNumber != null) {
    const causer = factionByNumber(match, causedByFactionNumber);
    if (causer) causer.killsCaused += killed;
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
