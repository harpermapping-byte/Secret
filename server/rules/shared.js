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

// Cada tropa de IA que lleva un jugador (ver rules/troops.js) le suma esto
// de fuerza FIJA cuando ese jugador ataca o defiende — no es una tirada, es
// un bonus llano por unidad, igual de grande gane o pierda el dado ese turno.
// Los soldados (aiTroops) valen igual en ataque y defensa; los arqueros y
// caballeros (rules/troopBuildings.js) son especialistas: el arquero solo
// suma atacando, el caballero solo defendiendo, tal y como se pidió.
const AI_TROOP_COMBAT_BONUS = 0.1;
const ARCHER_ATTACK_BONUS = 0.2;
const ARCHER_DEFENSE_BONUS = 0;
const CAVALRY_ATTACK_BONUS = 0;
const CAVALRY_DEFENSE_BONUS = 0.2;

// Guarnición de dungeon (ver rules/structures.js sección 27, !dungeon): no
// son tropas de IA de un jugador, sino la guarnición fija de un dungeon —
// mismo mecanismo que AI_TROOP_COMBAT_BONUS (bonus llano, simétrico
// ataque/defensa, sin tirada), pero más fuertes: el orco es grande y pega
// fuerte, el goblin es débil de uno en uno pero suelen ir varios.
const ORC_COMBAT_BONUS = 0.3;
const GOBLIN_COMBAT_BONUS = 0.15;

/**
 * Suma una tirada por cada userId de `userIds`, cada una en el rango que le
 * toque segun `player.unitType` (soldado o caballero) — por eso hace falta
 * `match` aqui y no solo un recuento de votos como antes: la fuerza ya no
 * depende solo de CUANTOS votan, sino de QUIENES. Encima de la tirada, se
 * suma el bonus fijo de las tropas de IA que lleve cada uno, distinto segun
 * `kind` ('attack' | 'defense') porque arqueros y caballeros son
 * especialistas de un solo lado del combate.
 */
function sumRandomPower(match, userIds, kind) {
  let total = 0;
  for (const userId of userIds) {
    const player = match.players.get(userId);
    total += rollUnitPower(player ? player.unitType : 'soldier');
    total += AI_TROOP_COMBAT_BONUS * (player?.aiTroops || 0);
    total += (kind === 'attack' ? ARCHER_ATTACK_BONUS : ARCHER_DEFENSE_BONUS) * (player?.archerTroops || 0);
    total += (kind === 'attack' ? CAVALRY_ATTACK_BONUS : CAVALRY_DEFENSE_BONUS) * (player?.cavalryTroops || 0);
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

// Orden de absorcion del nuevo modelo de daño en cascada (ver
// docs/ACCIONES.md): antes de que el daño sobrante llegue a matar
// JUGADORES via applyCasualties()/applyStructureCasualties(), primero se
// reparte entre sus tropas de IA, en este orden fijo — caballero, arquero,
// luego leva — "las de mas rango primero", tal y como se pidio.
const TROOP_CASCADE_PRIORITY = [
  { field: 'cavalryTroops', defense: CAVALRY_DEFENSE_BONUS },
  { field: 'archerTroops', defense: ARCHER_DEFENSE_BONUS },
  { field: 'aiTroops', defense: AI_TROOP_COMBAT_BONUS },
];

/**
 * Consume `damage` matando tropas de `userIds` en el orden de
 * TROOP_CASCADE_PRIORITY antes de que llegue a los jugadores. Cada unidad
 * absorbe su propio bonus de defensa (rules/shared.js) al morir — salvo un
 * tipo con defensa 0 (los arqueros defendiendo, ver ARCHER_DEFENSE_BONUS):
 * esos mueren TODOS gratis sin gastar nada de `damage`, porque una unidad
 * sin ninguna defensa no "aguanta" nada del golpe, tal y como se pidio
 * explicitamente ("si tengo arqueros que tienen 0 defensa mueren todos...
 * y seguiria matando levas porque no consumimos esos 0.5 de daño"). Quien
 * muere dentro de cada tipo se sortea al azar entre `userIds` que lo
 * lleven. Devuelve el `damage` sobrante (redondeado, misma escala que
 * `count` en applyCasualties/applyStructureCasualties) para que el
 * llamador se lo pase a la baja de JUGADORES de siempre — "cuando me
 * quedo sin tropas el daño es a mi, por tanto podria morir".
 */
function applyTroopCascadeDamage(match, userIds, damage) {
  let remaining = damage;
  for (const { field, defense } of TROOP_CASCADE_PRIORITY) {
    if (remaining <= 0) break;

    const pool = [];
    for (const userId of userIds) {
      const player = match.players.get(userId);
      if (!player) continue;
      for (let i = 0; i < (player[field] || 0); i++) pool.push(player);
    }
    if (pool.length === 0) continue;

    if (defense <= 0) {
      for (const userId of userIds) {
        const player = match.players.get(userId);
        if (player) player[field] = 0;
      }
      continue;
    }

    const killable = Math.min(pool.length, Math.floor(remaining / defense));
    if (killable <= 0) continue;
    shuffle(pool);
    for (let i = 0; i < killable; i++) pool[i][field] = Math.max(0, pool[i][field] - 1);
    remaining -= killable * defense;
  }
  return Math.max(0, Math.round(remaining));
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

module.exports = {
  sumRandomPower,
  applyCasualties,
  applyTroopCascadeDamage,
  killPlayer,
  shuffle,
  AI_TROOP_COMBAT_BONUS,
  ARCHER_ATTACK_BONUS,
  ARCHER_DEFENSE_BONUS,
  CAVALRY_ATTACK_BONUS,
  CAVALRY_DEFENSE_BONUS,
  ORC_COMBAT_BONUS,
  GOBLIN_COMBAT_BONUS,
};
