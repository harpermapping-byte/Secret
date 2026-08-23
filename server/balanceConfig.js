'use strict';

/**
 * NÚMEROS DE BALANCE — el único sitio que hace falta tocar para ajustar
 * cuánta guarnición sale en castillos/aldeas/puertos, cuántos orcos/goblins
 * lleva un dungeon, y cuánto pegan/aguantan los bosses.
 *
 * Cómo editar: cambia el número, guarda, reinicia el servidor (a diferencia
 * de spriteSizes.js, esto SÍ hace falta: son valores del motor de juego, se
 * leen una vez al generar el mapa de cada partida nueva, no en cada
 * petición). No hace falta tocar ningún otro archivo — server/mapTemplates.js
 * lee estos mismos objetos.
 *
 * Todos los rangos son [mínimo, máximo], AMBOS INCLUSIVE — se sortea un
 * entero al azar dentro de ese rango cada vez que se genera una partida
 * nueva (ver randomInRange() en mapTemplates.js).
 */

module.exports = {
  /**
   * Guarnición neutral de cada castillo/aldea/puerto sin conquistar
   * (rules/structures.js, `!conquista`) — cuántas tropas de cada tipo trae
   * de fábrica. La FUERZA de cada tropa la deciden las constantes de
   * rules/shared.js (AI_TROOP_COMBAT_BONUS, ARCHER_x, CAVALRY_x), aquí solo
   * se decide CUÁNTAS le tocan a cada estructura.
   */
  STRUCTURE_GARRISON_RANGES: {
    castle: { aiTroops: [5, 10], archerTroops: [0, 2], cavalryTroops: [0, 2] },
    village: { aiTroops: [3, 15], archerTroops: [0, 0], cavalryTroops: [0, 0] },
    port: { aiTroops: [6, 12], archerTroops: [0, 5], cavalryTroops: [0, 0] },
  },

  /**
   * Guarnición de un dungeon (`!dungeon`) — orcos y goblins, un tipo de
   * unidad aparte con su propia fuerza (ORC_COMBAT_BONUS/GOBLIN_COMBAT_BONUS
   * en rules/shared.js).
   */
  DUNGEON_GARRISON_RANGE: { orcCount: [2, 3], goblinCount: [3, 5] },

  /**
   * Ataque y defensa de un boss (`!boss`) — un único número fijo por
   * instancia (a diferencia de una guarnición, un boss no tiene "tropas").
   */
  BOSS_POWER_RANGE: [5, 10],
};
