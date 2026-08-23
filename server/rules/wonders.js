'use strict';

/**
 * Maravillas (ver docs/ACCIONES.md sección 30, `mapTemplates.js` WONDER_TYPES
 * para la lista de las 6 y su bono): a diferencia de dungeons/estructuras, NO
 * se "conquistan" con un comando ni tienen combate propio — su dueño es,
 * SIEMPRE, quien controle su `tileId` ahora mismo (normal `!ataque`/
 * `!expansion`, nada especial), tal y como se pidió ("para conquistarlas hay
 * que poseer el terreno en el que aparezcas"). Por eso no hace falta ningún
 * `resolveWonders()` que actualice nada ronda a ronda: estas dos funciones
 * simplemente SUMAN, en el momento en que se llaman, el bono de las
 * maravillas que la facción posee en ESE instante.
 */

/** Maravillas de tipo 'industry' que posee `faction` ahora mismo, sumadas. */
function wonderIndustryBonus(match, faction) {
  let total = 0;
  for (const w of match.wonders) {
    if (w.bonusType === 'industry' && match.tiles[w.tileId].ownerFactionNumber === faction.number) total += w.bonusAmount;
  }
  return total;
}

/**
 * Maravillas de tipo 'defense' que posee `faction` ahora mismo, sumadas —
 * bono PASIVO igual que las torres (rules/towers.js) y las tropas especiales
 * (rules/industry.js): se suma siempre en resolveCombat(), aunque nadie vote
 * `!defender` esa ronda.
 */
function wonderDefenseBonus(match, faction) {
  let total = 0;
  for (const w of match.wonders) {
    if (w.bonusType === 'defense' && match.tiles[w.tileId].ownerFactionNumber === faction.number) total += w.bonusAmount;
  }
  return total;
}

module.exports = { wonderIndustryBonus, wonderDefenseBonus };
