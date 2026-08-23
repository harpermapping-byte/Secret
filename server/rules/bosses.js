'use strict';

const { ACTION_BOSS } = require('../commands');
const { sumRandomPower, applyTroopCascadeDamage, killPlayer, shuffle } = require('./shared');
const { checkFactionElimination } = require('./territory');

// Bono pasivo por cada museo (trofeo de boss, ver resolveBoss() más abajo) —
// TERCER tipo de bono acumulable por facción, junto a torres (rules/towers.js)
// y maravillas (rules/wonders.js): +1 leva/ronda (se suma al reparto de
// resolveAiTroops(), ver server/rules/troops.js), +1 industria/ronda, +2 de
// defensa base — los tres "si matas más de un boss se crea otro museo", tal
// y como se pidió, así que no hay tope: cada museo suma su bono entero.
const MUSEUM_LEVA_BONUS = 1;
const MUSEUM_INDUSTRY_BONUS = 1;
const MUSEUM_DEFENSE_BONUS = 2;

/**
 * `!boss` (ver docs/ACCIONES.md sección 31): ataca a UN boss al azar entre
 * los que estén vivos dentro de TU territorio — mismo patrón que
 * `resolveDungeon()` en rules/structures.js (combate bidireccional: tu
 * ataque contra su defensa decide si lo derrotas, su ataque contra tu
 * defensa os causa bajas SIEMPRE, ganéis o no), pero MÁS SIMPLE: un boss no
 * tiene guarnición de tropas que sumar, su ataque/defensa ya es un número
 * fijo por instancia (`match.bosses[i].attackPower/defensePower`, sorteado
 * una vez al generar el mapa, ver mapTemplates.js).
 */
function resolveBoss(match, context) {
  for (const faction of match.factions) {
    const attackerUserIds = context.votesByFactionAndType.get(faction.number)[ACTION_BOSS];
    if (!attackerUserIds || attackerUserIds.length === 0) continue;

    const target = pickEligibleBoss(match, faction.number);
    if (!target) continue; // ningun boss vivo en su territorio ahora mismo: voto desperdiciado

    const attackPower = sumRandomPower(match, attackerUserIds, 'attack');
    const ourDefense = sumRandomPower(match, attackerUserIds, 'defense');

    if (attackPower > target.defensePower) {
      target.defeated = true;
      target.defeatedByFactionNumber = faction.number;
      faction.bossTrophies += 1;
      context.roundEvents.bossKills.push({ tileId: target.tileId, bossKey: target.key, factionNumber: faction.number });
    }

    const counterDamage = Math.round(target.attackPower - ourDefense);
    if (counterDamage > 0) {
      const remaining = applyTroopCascadeDamage(match, attackerUserIds, counterDamage);
      const deaths = applyBossCasualties(match, attackerUserIds, remaining);
      if (deaths > 0) {
        // Si alguien muere en el intento, el boss NO se queda intacto para
        // el siguiente ataque: se lleva puesto el daño que sí consiguieron
        // hacerle (attackPower de este asalto), en ataque y defensa por
        // igual — "se queda con la vida y defensa restante de esa
        // batalla", tal y como se pidió. Puede llegar a 0 (entonces
        // cualquier ataque futuro lo derrota/no contraataca), pero no se
        // marca defeated=true aquí: eso sigue siendo solo cuando de verdad
        // se le gana la comparación de poder, arriba.
        target.defensePower = Math.max(0, target.defensePower - attackPower);
        target.attackPower = Math.max(0, target.attackPower - attackPower);
        checkFactionElimination(match, context, faction.number, null);
      }
    }
  }
}

/** Un boss vivo al azar dentro del territorio de `factionNumber`, o `null` si no hay ninguno. */
function pickEligibleBoss(match, factionNumber) {
  const eligible = match.bosses.filter((b) => !b.defeated && match.tiles[b.tileId].ownerFactionNumber === factionNumber);
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

/** Baja `count` de los votantes al azar entre ellos mismos — mismo criterio que applyStructureCasualties() en rules/structures.js (sección 23). Devuelve cuántos murieron de verdad. */
function applyBossCasualties(match, userIds, count) {
  const pool = shuffle([...userIds]);
  let remaining = count;
  let deaths = 0;
  while (remaining > 0 && pool.length > 0) {
    if (killPlayer(match, pool.pop())) { remaining--; deaths++; }
  }
  return deaths;
}

/** Cuántos museos (trofeos de boss) tiene `faction` ahora mismo — ver bossTrophies en gameEngine.js. */
function museumCountFor(faction) {
  return faction.bossTrophies || 0;
}

/** +1 leva/ronda por museo — se suma al recuento normal de resolveAiTroops() en rules/troops.js. */
function museumLevaBonus(faction) {
  return museumCountFor(faction) * MUSEUM_LEVA_BONUS;
}

/** +1 industria/ronda por museo — se suma dentro de resolveIndustry() en rules/industry.js. */
function museumIndustryBonus(faction) {
  return museumCountFor(faction) * MUSEUM_INDUSTRY_BONUS;
}

/** +2 de defensa pasiva por museo — cuarta excepción a "el territorio no se defiende solo", ver rules/combat.js. */
function museumDefenseBonus(faction) {
  return museumCountFor(faction) * MUSEUM_DEFENSE_BONUS;
}

module.exports = {
  resolveBoss,
  museumLevaBonus,
  museumIndustryBonus,
  museumDefenseBonus,
  MUSEUM_LEVA_BONUS,
  MUSEUM_INDUSTRY_BONUS,
  MUSEUM_DEFENSE_BONUS,
};
