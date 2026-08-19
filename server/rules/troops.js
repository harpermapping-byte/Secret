'use strict';

// Tropas de IA: cada casilla que controla una facción genera 1 tropa por
// ronda, que se reparte entre sus jugadores vivos — no vota nadie, es
// automático, igual que las mejoras de industria (ver rules/industry.js).
// Cada tropa sigue siempre al jugador que la lleva (su "general") en el
// mapa (ver public/mapRenderer.js) y le suma fuerza de combate cuando ese
// jugador ataca o defiende — ver AI_TROOP_COMBAT_BONUS en rules/shared.js,
// que es quien aplica de verdad ese bonus (aquí solo se reparten y cuentan).

/**
 * Reparte `count` tropas nuevas entre los jugadores vivos de la facción, de
 * una en una, dándole siempre la siguiente a quien tenga MENOS tropas ahora
 * mismo (empate se rompe al azar) — así, con 5 jugadores y 2 territorios,
 * las 2 tropas van a los 2 que menos tengan (normalmente ninguna todavía,
 * como se pidió: "iria primero el soldadito a al que no tuviera"), y con el
 * tiempo la cosa se va igualando sola en vez de amontonarse siempre en los
 * mismos.
 */
function distributeAiTroops(match, faction, count) {
  if (count <= 0) return;
  const living = [...match.players.values()].filter((p) => p.alive && p.factionNumber === faction.number);
  if (!living.length) return;

  for (let i = 0; i < count; i++) {
    const minTroops = Math.min(...living.map((p) => p.aiTroops || 0));
    const eligible = living.filter((p) => (p.aiTroops || 0) === minTroops);
    const chosen = eligible[Math.floor(Math.random() * eligible.length)];
    chosen.aiTroops = (chosen.aiTroops || 0) + 1;
  }
}

/** 1 tropa nueva por cada casilla que controle la facción esta ronda, para cada facción viva. */
function resolveAiTroops(match) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    distributeAiTroops(match, faction, faction.territoryIds.length);
  }
}

module.exports = { resolveAiTroops };
