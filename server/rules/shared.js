'use strict';

const { ACTION_INDUSTRY, ACTION_ATTACK, ACTION_DEFEND } = require('../commands');
const { factionByNumber } = require('./territory');

// Rango de azar por unidad al calcular fuerza de combate: CADA usuario que
// ataca (o que defiende) aporta una tirada suelta dentro de este rango, asi
// que un combate de 3 contra 3 no siempre sale igual. Mismo rango para ataque
// y para defensa — ver docs/GDD seccion 6 "Combate". Los caballeros (mejora
// de industria nivel 1/3, ver rules/industry.js) tiran en un rango mas alto:
// son soldados mejores, no solo mas rapidos sobre el mapa.
const COMBAT_RANDOM_MIN = 0.7;
const COMBAT_RANDOM_MAX = 1.3;
const KNIGHT_RANDOM_MIN = 0.9;
const KNIGHT_RANDOM_MAX = 1.4;

/** Una tirada suelta, en el rango que le toque segun el tipo de unidad de quien vota. */
function rollUnitPower(unitType) {
  const [min, max] = unitType === 'knight' ? [KNIGHT_RANDOM_MIN, KNIGHT_RANDOM_MAX] : [COMBAT_RANDOM_MIN, COMBAT_RANDOM_MAX];
  return min + Math.random() * (max - min);
}

/**
 * Suma una tirada por cada userId de `userIds`, cada una en el rango que le
 * toque segun `player.unitType` (soldado o caballero) — por eso hace falta
 * `match` aqui y no solo un recuento de votos como antes: la fuerza ya no
 * depende solo de CUANTOS votan, sino de QUIENES.
 */
function sumRandomPower(match, userIds) {
  let total = 0;
  for (const userId of userIds) {
    const player = match.players.get(userId);
    total += rollUnitPower(player ? player.unitType : 'soldier');
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
