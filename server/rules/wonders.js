'use strict';

const { ACTION_WONDER } = require('../commands');
const { sumRandomPower, applyTroopCascadeDamageAndWipeouts } = require('./shared');
const { checkFactionElimination } = require('./territory');
const { sunnyPveBonus } = require('./weather');

/**
 * `!maravilla` (ver docs/ACCIONES.md sección 39): ataca a la guarnición de
 * UNA maravilla al azar entre las que estén dentro de TU territorio y
 * SIGAN sin conquistar (`!!wonders` tiene que estar activado). Mismo patrón
 * de combate bidireccional que `!boss` (rules/bosses.js): tu ataque contra
 * su defensa decide si te la quedas, y POR SEPARADO su ataque contra tu
 * defensa os causa bajas SIEMPRE, ganes o no — un boss no tiene guarnición
 * desglosada por tipo, tampoco una maravilla: su ataque/defensa es un único
 * número fijo por instancia (`WONDER_POWER_RANGE`, sorteado al generar el
 * mapa, ver mapTemplates.js buildWonders()).
 *
 * A diferencia de un boss (cuya recompensa es un trofeo aparte, el museo),
 * conquistar una maravilla le da a la facción su bono de siempre
 * (`bonusType`/`bonusAmount`) — pero PARA SIEMPRE desde que se conquista,
 * ya no depende de quién controle la casilla después (ver
 * wonderIndustryBonus()/wonderDefenseBonus() más abajo, que ahora miran
 * `w.defeated && w.conqueredByFactionNumber`, no `tile.ownerFactionNumber`).
 */
function resolveWonder(match, context) {
  for (const faction of match.factions) {
    const attackerUserIds = context.votesByFactionAndType.get(faction.number)[ACTION_WONDER];
    if (!attackerUserIds || attackerUserIds.length === 0) continue;

    const target = pickEligibleWonder(match, faction.number);
    if (!target) continue; // ninguna maravilla sin conquistar en su territorio ahora mismo: voto desperdiciado

    // Clima: día soleado da +1 ataque Y +1 defensa a CADA jugador en combate
    // PvE esta ronda (ver rules/weather.js).
    const weatherBonus = sunnyPveBonus(match) * attackerUserIds.length;
    const attackPower = sumRandomPower(match, attackerUserIds, 'attack') + weatherBonus;
    const ourDefense = sumRandomPower(match, attackerUserIds, 'defense') + weatherBonus;
    const wonderDefenseAtStart = target.defensePower; // antes de la posible erosión de más abajo, para el popup
    const conquered = attackPower > target.defensePower;

    if (conquered) {
      target.defeated = true;
      target.conqueredByFactionNumber = faction.number;
      context.roundEvents.structureConquests.push({ tileId: target.tileId, structureType: `wonder:${target.key}`, factionNumber: faction.number });
    }

    let troopsLost = 0;
    let diedCount = 0;
    const counterDamage = Math.round(target.attackPower - ourDefense);
    if (counterDamage > 0) {
      // Sistema de vidas (rules/shared.js, match.config.startingLives):
      // quien se queda sin ninguna tropa pierde una vida y reaparece con 0
      // tropas — solo si era la última es la muerte real de siempre.
      const { wipedOutUserIds, diedUserIds, troopsBefore, troopsAfter } = applyTroopCascadeDamageAndWipeouts(match, attackerUserIds, counterDamage);
      troopsLost = troopsBefore - troopsAfter;
      diedCount = diedUserIds.length;
      if (wipedOutUserIds.length > 0) {
        // Si alguien se quedó sin tropas en el intento, la maravilla NO se
        // queda intacta para el siguiente ataque: se lleva puesto el daño
        // que sí le hicieron, en ataque y defensa por igual — mismo
        // mecanismo que un boss (ver rules/bosses.js).
        target.defensePower = Math.max(0, target.defensePower - attackPower);
        target.attackPower = Math.max(0, target.attackPower - attackPower);
      }
      if (diedUserIds.length > 0) checkFactionElimination(match, context, faction.number, null);
    }

    context.roundEvents.pveFights.push({
      pveKind: 'maravilla', factionNumber: faction.number, tileId: target.tileId, label: target.key,
      attackPower: Math.round(attackPower * 10) / 10, defensePower: Math.round(wonderDefenseAtStart * 10) / 10,
      defeated: conquered, troopsLost, diedCount,
    });
  }
}

/** Una maravilla sin conquistar al azar dentro del territorio de `factionNumber`, o `null` si no hay ninguna. */
function pickEligibleWonder(match, factionNumber) {
  const eligible = match.wonders.filter((w) => !w.defeated && match.tiles[w.tileId].ownerFactionNumber === factionNumber);
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

/** Maravillas de tipo 'industry' que `faction` tiene CONQUISTADAS ahora mismo, sumadas. */
function wonderIndustryBonus(match, faction) {
  let total = 0;
  for (const w of match.wonders) {
    if (w.bonusType === 'industry' && w.defeated && w.conqueredByFactionNumber === faction.number) total += w.bonusAmount;
  }
  return total;
}

/**
 * Maravillas de tipo 'defense' que `faction` tiene CONQUISTADAS ahora mismo,
 * sumadas — bono PASIVO igual que las torres (rules/towers.js) y las tropas
 * especiales (rules/industry.js): se suma siempre en resolveCombat(),
 * aunque nadie vote `!defender` esa ronda.
 */
function wonderDefenseBonus(match, faction) {
  let total = 0;
  for (const w of match.wonders) {
    if (w.bonusType === 'defense' && w.defeated && w.conqueredByFactionNumber === faction.number) total += w.bonusAmount;
  }
  return total;
}

module.exports = { resolveWonder, wonderIndustryBonus, wonderDefenseBonus };
