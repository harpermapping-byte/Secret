'use strict';

const { museumLevaBonus } = require('./bosses');
const { effectiveTroopLimit } = require('./shared');

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
  return (p.aiTroops || 0) + (p.archerTroops || 0) + (p.cavalryTroops || 0) + (p.specialTroops || 0);
}

// Sugerencia 3 del informe de balance de late game (v0.4.6, ver
// docs/ACCIONES.md): la facción que combatió de VERDAD esta ronda (PvP, ver
// faction.atWarThisRound en gameEngine.resolveRound()) produce tropas
// pasivas a MITAD de ritmo esa misma ronda — objetivo: que el desgaste del
// combate pueda algún día superar a la producción en partidas largas, en
// vez de que un asedio sea matemáticamente imposible en cuanto ambos
// bandos superan cierto tamaño (las 10 simulaciones mostraron 6/10
// partidas totalmente bloqueadas en el late game por esto). Solo afecta a
// la producción PASIVA repartida por distributeTroops() (leva por
// territorio, edificios de tropa ya en pie, museos, Mercado) — el bono
// directo de construir un edificio esta ronda (BUILDING_INITIAL_BONUS en
// troopBuildings.js) NO se recorta, porque es una acción activa del
// jugador, no producción automática.
const WAR_PRODUCTION_FACTOR = 0.5;

/**
 * `effectiveTroopLimit()` (panel de admin, 1-200, por defecto 50, +50 si la
 * facción ya tiene iglesia — ver rules/shared.js): un jugador que ya lleva
 * ese total de tropas (sumando los 4 tipos) deja de poder recibir más — no
 * importa el tipo que le tocara repartir, se le trata como si no existiera
 * para el reparto. Si TODA la facción viva está al límite, esa producción
 * se pierde sin más (no se acumula para después): es justo lo que se pidió
 * — "si no hay más usuario en esa facción no se generarán tropas".
 */
function distributeTroops(match, faction, count, fieldName) {
  if (faction.atWarThisRound) count = Math.floor(count * WAR_PRODUCTION_FACTOR);
  if (count <= 0) return;
  const limit = effectiveTroopLimit(match, faction);
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

// Nivel 5 de industria "Mercado" (ver rules/industry.js sección 39): +1
// tropa de IA/ronda PERMANENTE para toda la facción en cuanto se activa —
// se lee `faction.mercadoBuilt` directamente en vez de importar una función
// de rules/industry.js, porque industry.js ya requiere ESTE archivo (para
// distributeTroops), así que un require en sentido contrario crearía un
// ciclo (mismo motivo que documenta industry.js junto a este flag).
const MERCADO_LEVA_BONUS = 1;

/**
 * 1 tropa (soldado) nueva por cada casilla que controle la facción esta
 * ronda, para cada facción viva — MÁS 1 por cada museo que tenga (trofeo de
 * boss, ver rules/bosses.js sección 31), acumulable sin tope, MÁS 1 si ya
 * tiene el Mercado (nivel 5 de industria, ver MERCADO_LEVA_BONUS arriba).
 */
function resolveAiTroops(match) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    const mercado = faction.mercadoBuilt ? MERCADO_LEVA_BONUS : 0;
    distributeTroops(match, faction, faction.territoryIds.length + museumLevaBonus(faction) + mercado, 'aiTroops');
  }
}

module.exports = { resolveAiTroops, distributeTroops, totalTroops, WAR_PRODUCTION_FACTOR };
