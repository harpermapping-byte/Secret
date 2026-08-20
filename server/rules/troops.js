'use strict';

// Tropas de IA: cada casilla que controla una facción genera 1 tropa por
// ronda, que se reparte entre sus jugadores vivos — no vota nadie, es
// automático, igual que las mejoras de industria (ver rules/industry.js).
// Cada tropa sigue siempre al jugador que la lleva (su "general") en el
// mapa (ver public/mapRenderer.js) y le suma fuerza de combate cuando ese
// jugador ataca o defiende — ver AI_TROOP_COMBAT_BONUS en rules/shared.js,
// que es quien aplica de verdad ese bonus (aquí solo se reparten y cuentan).

/**
 * Reparte `count` tropas nuevas del tipo `fieldName` (nombre del campo en el
 * jugador: 'aiTroops' | 'archerTroops' | 'cavalryTroops') entre los
 * jugadores vivos de la facción, de una en una, dándole siempre la
 * siguiente a quien tenga MENOS tropas de ese tipo ahora mismo (empate se
 * rompe al azar) — así, con 5 jugadores y 2 territorios, las 2 tropas van a
 * los 2 que menos tengan (normalmente ninguna todavía, como se pidió: "iria
 * primero el soldadito a al que no tuviera"), y con el tiempo la cosa se va
 * igualando sola en vez de amontonarse siempre en los mismos. Genérica en el
 * tipo de tropa a propósito: la usan tanto la generación pasiva por
 * territorio (resolveAiTroops, solo soldados) como los edificios de
 * !levas/!arqueros/!caballeros (ver rules/troopBuildings.js, los 3 tipos).
 */
function totalTroops(p) {
  return (p.aiTroops || 0) + (p.archerTroops || 0) + (p.cavalryTroops || 0);
}

/**
 * `match.config.troopLimitPerPlayer` (panel de admin, 1-200, por defecto 50):
 * un jugador que ya lleva ese total de tropas (sumando los 3 tipos) deja de
 * poder recibir más — no importa el tipo que le tocara repartir, se le trata
 * como si no existiera para el reparto. Si TODA la facción viva está al
 * límite, esa producción se pierde sin más (no se acumula para después): es
 * justo lo que se pidió — "si no hay más usuario en esa facción no se
 * generarán tropas".
 */
function distributeTroops(match, faction, count, fieldName) {
  if (count <= 0) return;
  const limit = match.config.troopLimitPerPlayer;
  const living = [...match.players.values()].filter(
    (p) => p.alive && p.factionNumber === faction.number && totalTroops(p) < limit
  );
  if (!living.length) return;

  for (let i = 0; i < count; i++) {
    const eligibleNow = living.filter((p) => totalTroops(p) < limit);
    if (!eligibleNow.length) break; // toda la facción llegó al límite a mitad de reparto: se pierde el resto
    const minTroops = Math.min(...eligibleNow.map((p) => p[fieldName] || 0));
    const eligible = eligibleNow.filter((p) => (p[fieldName] || 0) === minTroops);
    const chosen = eligible[Math.floor(Math.random() * eligible.length)];
    chosen[fieldName] = (chosen[fieldName] || 0) + 1;
  }
}

/** 1 tropa (soldado) nueva por cada casilla que controle la facción esta ronda, para cada facción viva. */
function resolveAiTroops(match) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    distributeTroops(match, faction, faction.territoryIds.length, 'aiTroops');
  }
}

module.exports = { resolveAiTroops, distributeTroops };
