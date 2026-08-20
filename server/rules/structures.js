'use strict';

const { ACTION_CONQUISTA } = require('../commands');
const {
  sumRandomPower,
  applyTroopCascadeDamage,
  killPlayer,
  shuffle,
  AI_TROOP_COMBAT_BONUS,
  ARCHER_ATTACK_BONUS,
  ARCHER_DEFENSE_BONUS,
  CAVALRY_ATTACK_BONUS,
  CAVALRY_DEFENSE_BONUS,
} = require('./shared');

/**
 * `!conquista` (ver docs/ACCIONES.md sección 20): ataca a UNA estructura
 * neutral (castillo/aldea/puerto, ver `buildStructures()` en
 * `mapTemplates.js`) al azar entre las que estén dentro de TU territorio y
 * todavía tengan guarnición (`match.structures`, generado una vez al crear
 * la partida con conteos al azar por tipo). Misma mecánica de agrupación que
 * `!ataque`: todos los votantes de una facción se suman en UN solo ataque.
 *
 * El asalto es un combate DE VERDAD en las dos direcciones, no una única
 * comparación (ver docs/ACCIONES.md sección 23): tu ataque contra la
 * defensa de la guarnición decide si conquistas, Y POR SEPARADO el ataque
 * (fijo, sin tirada — las tropas de IA no tiran dado) de la guarnición
 * contra tu propia defensa decide cuántas bajas os causa A VOSOTROS —
 * "se enfrenta el ataque contra la defensa del otro, y su ataque contra mi
 * defensa", tal y como se pidió. Esto pasa SIEMPRE, ganes o pierdas el
 * asalto: puedes conquistar el edificio y aun así perder tropas en el
 * mismo turno. Un empate en la conquista nunca la concede (`>` estricto).
 */
function resolveConquista(match, context) {
  for (const faction of match.factions) {
    const attackerUserIds = context.votesByFactionAndType.get(faction.number)[ACTION_CONQUISTA];
    if (!attackerUserIds || attackerUserIds.length === 0) continue;

    const target = pickEligibleStructure(match, faction.number);
    if (!target) continue; // no hay ninguna estructura con guarnición en su territorio ahora mismo: voto desperdiciado

    const attackPower = sumRandomPower(match, attackerUserIds, 'attack');
    const ourDefense = sumRandomPower(match, attackerUserIds, 'defense');
    const garrisonAttack = structureAttackPower(target);
    const garrisonDefense = structureDefensePower(target);

    if (attackPower > garrisonDefense) {
      conquerStructure(match, target);
      context.roundEvents.structureConquests.push({
        tileId: target.tileId,
        structureType: target.type,
        factionNumber: faction.number,
      });
    }

    // Contraataque de la guarnición, se conquiste o no: primero cascada de
    // tropas de IA de los votantes (caballero->arquero->leva, ver
    // applyTroopCascadeDamage en rules/shared.js), solo lo que sobra mata
    // jugadores de verdad.
    const counterDamage = Math.round(garrisonAttack - ourDefense);
    if (counterDamage > 0) {
      const remaining = applyTroopCascadeDamage(match, attackerUserIds, counterDamage);
      applyStructureCasualties(match, attackerUserIds, remaining);
    }
  }
}

/**
 * Baja `count` de los votantes que perdieron el asalto, al azar entre ellos
 * mismos. NO reutiliza `applyCasualties()` de rules/shared.js a propósito:
 * esa reparte bajas entre 4 bolsas con prioridad fija pensadas para el
 * combate normal entre facciones (inactivos/industria/atacantes/defensores
 * DE LA FACCIÓN) — aquí no hay más bolsa posible que "quien votó
 * `!conquista`", así que basta con un `shuffle()` + `killPlayer()` directo
 * sobre esa lista, sin la maquinaria de prioridad que no aplica.
 */
function applyStructureCasualties(match, userIds, count) {
  const pool = shuffle([...userIds]);
  let remaining = count;
  while (remaining > 0 && pool.length > 0) {
    if (killPlayer(match, pool.pop())) remaining--;
  }
}

/** Fuerza de defensa de una guarnición: suma de bonus llanos, sin tirada (no hay "jugador" al mando). */
function structureDefensePower(structure) {
  return (
    structure.aiTroops * AI_TROOP_COMBAT_BONUS +
    structure.archerTroops * ARCHER_DEFENSE_BONUS +
    structure.cavalryTroops * CAVALRY_DEFENSE_BONUS
  );
}

/** Fuerza de ataque "de referencia" de una guarnición — puramente informativa (ver docs/ACCIONES.md sección 20), la estructura nunca ataca a nadie. */
function structureAttackPower(structure) {
  return (
    structure.aiTroops * AI_TROOP_COMBAT_BONUS +
    structure.archerTroops * ARCHER_ATTACK_BONUS +
    structure.cavalryTroops * CAVALRY_ATTACK_BONUS
  );
}

/** Todavía tiene guarnición (no conquistada) y su casilla es del territorio de esta facción ahora mismo. */
function pickEligibleStructure(match, factionNumber) {
  const eligible = match.structures.filter(
    (s) => hasGarrison(s) && match.tiles[s.tileId].ownerFactionNumber === factionNumber
  );
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

function hasGarrison(structure) {
  return structure.aiTroops + structure.archerTroops + structure.cavalryTroops > 0;
}

/**
 * Vacía la guarnición (queda conquistada para siempre: `hasGarrison()` ya no
 * la vuelve a proponer en `pickEligibleStructure()`) y traslada su bonus de
 * producción a la CASILLA donde está, reutilizando los mismos campos que ya
 * usan los edificios de `!levas`/`!arqueros`/`!caballeros`/`!industria` — así
 * la producción y el traspaso de dueño al perder/ganar territorio salen
 * gratis, sin código nuevo (ver resolveTroopBuildings()/resolveIndustry()):
 *   castillo -> +1 caballero de IA por ronda (tile.cavalryCount += 1)
 *   aldea    -> +2 levas por ronda            (tile.leviesCount += 2)
 *   puerto   -> +1 de industria por ronda      (tile.industryCount += 2,
 *               porque cada edificio de industria ya vale 0.5/ronda —
 *               INDUSTRY_PER_BUILDING en rules/industry.js — así que 2 dan
 *               exactamente el +1 pedido, sin inventar una constante nueva)
 */
function conquerStructure(match, structure) {
  structure.aiTroops = 0;
  structure.archerTroops = 0;
  structure.cavalryTroops = 0;

  const tile = match.tiles[structure.tileId];
  if (structure.type === 'castle') tile.cavalryCount += 1;
  else if (structure.type === 'village') tile.leviesCount += 2;
  else if (structure.type === 'port') tile.industryCount += 2;
}

module.exports = { resolveConquista, structureDefensePower, structureAttackPower };
