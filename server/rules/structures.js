'use strict';

const { ACTION_CONQUISTA, ACTION_DUNGEON } = require('../commands');
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
  ORC_COMBAT_BONUS,
  GOBLIN_COMBAT_BONUS,
} = require('./shared');
const { checkFactionElimination } = require('./territory');

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

    // Los dungeon NO entran en este reparto al azar — tienen su propio
    // comando (!dungeon, ver resolveDungeon() más abajo) porque su
    // recompensa es distinta (estatua junto a tu capital, no producción
    // para la casilla).
    const target = pickEligibleStructure(match, faction.number, (s) => s.type !== 'dungeon');
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
      const deaths = applyStructureCasualties(match, attackerUserIds, remaining);
      if (deaths > 0) {
        // Si alguien muere en el asalto, la guarnición no queda intacta
        // para el siguiente intento: se lleva puesto el daño que sí le
        // hicieron (attackPower de este asalto), igual que un boss (ver
        // rules/bosses.js) — si ya fue conquistada esta misma ronda (arriba)
        // no hace nada, su guarnición ya está a 0.
        applyGarrisonCascadeDamage(target, attackPower);
        checkFactionElimination(match, context, faction.number, null);
      }
    }
  }
}

/**
 * `!dungeon` (ver docs/ACCIONES.md sección 27): mismo combate bidireccional
 * que `!conquista` (tu ataque contra su defensa decide si lo derrotas, su
 * ataque contra tu defensa os causa bajas siempre), pero:
 *   - Solo ataca a un dungeon (guarnición de orcos/goblins) dentro de TU
 *     territorio — nunca castillo/aldea/puerto (esos son de `!conquista`).
 *   - La recompensa NO es producción para la casilla: al derrotarlo, la
 *     guarnición se vacía para siempre (igual que conquerStructure) y la
 *     FACCIÓN gana un trofeo — una estatua nueva junto a su capital, con
 *     sus propios aldeanos alrededor (ver `faction.dungeonTrophies` y
 *     desiredSiteSpecs() en public/mapRenderer.js).
 */
function resolveDungeon(match, context) {
  for (const faction of match.factions) {
    const attackerUserIds = context.votesByFactionAndType.get(faction.number)[ACTION_DUNGEON];
    if (!attackerUserIds || attackerUserIds.length === 0) continue;

    const target = pickEligibleStructure(match, faction.number, (s) => s.type === 'dungeon');
    if (!target) continue; // no hay ningun dungeon con guarnición en su territorio ahora mismo: voto desperdiciado

    const attackPower = sumRandomPower(match, attackerUserIds, 'attack');
    const ourDefense = sumRandomPower(match, attackerUserIds, 'defense');
    const garrisonAttack = structureAttackPower(target);
    const garrisonDefense = structureDefensePower(target);

    if (attackPower > garrisonDefense) {
      target.orcCount = 0;
      target.goblinCount = 0;
      faction.dungeonTrophies += 1;
      context.roundEvents.structureConquests.push({
        tileId: target.tileId,
        structureType: target.type,
        factionNumber: faction.number,
      });
    }

    const counterDamage = Math.round(garrisonAttack - ourDefense);
    if (counterDamage > 0) {
      const remaining = applyTroopCascadeDamage(match, attackerUserIds, counterDamage);
      const deaths = applyStructureCasualties(match, attackerUserIds, remaining);
      if (deaths > 0) {
        applyGarrisonCascadeDamage(target, attackPower);
        checkFactionElimination(match, context, faction.number, null);
      }
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
  let deaths = 0;
  while (remaining > 0 && pool.length > 0) {
    if (killPlayer(match, pool.pop())) { remaining--; deaths++; }
  }
  return deaths;
}

// Mismo orden de prioridad que TROOP_CASCADE_PRIORITY (rules/shared.js)
// pero para los 5 campos de guarnición en vez de tropas de jugador: los que
// más aguantan (más "defense" por unidad) absorben primero, un tipo con
// defense 0 (ARCHER_DEFENSE_BONUS) se lleva por delante gratis igual que ahí.
const GARRISON_CASCADE_PRIORITY = [
  { field: 'cavalryTroops', defense: CAVALRY_DEFENSE_BONUS },
  { field: 'archerTroops', defense: ARCHER_DEFENSE_BONUS },
  { field: 'aiTroops', defense: AI_TROOP_COMBAT_BONUS },
  { field: 'orcCount', defense: ORC_COMBAT_BONUS },
  { field: 'goblinCount', defense: GOBLIN_COMBAT_BONUS },
];

/**
 * Reduce la guarnición de `structure` (castillo/aldea/puerto/dungeon) en
 * `damage` puntos, persistente para el siguiente asalto — "se queda con la
 * vida y defensa restante de esa batalla" cuando algún atacante muere (ver
 * resolveConquista()/resolveDungeon() más arriba). No mata jugadores, ni
 * roza sus tropas: solo la guarnición NEUTRAL de la estructura/dungeon en
 * sí. Nunca la deja exactamente en 0 aquí a propósito: `hasGarrison()` la
 * dejaría de ofrecer como objetivo sin que nadie la haya conquistado de
 * verdad (sin el bono para la casilla / sin trofeo de dungeon) — se deja
 * SIEMPRE al menos 1 unidad, así que un asalto futuro (con su defensa ya
 * mínima) acaba conquistándola por el camino normal de arriba.
 */
function applyGarrisonCascadeDamage(structure, damage) {
  let total = GARRISON_CASCADE_PRIORITY.reduce((sum, { field }) => sum + (structure[field] || 0), 0);
  if (total <= 1) return;

  let remaining = damage;
  for (const { field, defense } of GARRISON_CASCADE_PRIORITY) {
    if (remaining <= 0 || total <= 1) break;
    const count = structure[field] || 0;
    if (count === 0) continue;
    const room = total - 1;

    if (defense <= 0) {
      const killable = Math.min(count, room);
      structure[field] -= killable;
      total -= killable;
      continue;
    }
    const killable = Math.min(count, Math.floor(remaining / defense), room);
    if (killable <= 0) continue;
    structure[field] -= killable;
    remaining -= killable * defense;
    total -= killable;
  }
}

/**
 * Fuerza de defensa de una guarnición: suma de bonus llanos, sin tirada (no
 * hay "jugador" al mando). Castillo/aldea/puerto usan aiTroops/
 * archerTroops/cavalryTroops; dungeon usa orcCount/goblinCount (siempre a 0
 * los que no le tocan al tipo, ver buildStructures() en mapTemplates.js) —
 * sumar los 5 campos de golpe evita ramificar por tipo aquí.
 */
function structureDefensePower(structure) {
  return (
    structure.aiTroops * AI_TROOP_COMBAT_BONUS +
    structure.archerTroops * ARCHER_DEFENSE_BONUS +
    structure.cavalryTroops * CAVALRY_DEFENSE_BONUS +
    (structure.orcCount || 0) * ORC_COMBAT_BONUS +
    (structure.goblinCount || 0) * GOBLIN_COMBAT_BONUS
  );
}

/** Fuerza de ataque de una guarnición — ver structureDefensePower() para por qué suma los 5 campos. */
function structureAttackPower(structure) {
  return (
    structure.aiTroops * AI_TROOP_COMBAT_BONUS +
    structure.archerTroops * ARCHER_ATTACK_BONUS +
    structure.cavalryTroops * CAVALRY_ATTACK_BONUS +
    (structure.orcCount || 0) * ORC_COMBAT_BONUS +
    (structure.goblinCount || 0) * GOBLIN_COMBAT_BONUS
  );
}

/**
 * Todavía tiene guarnición (no conquistada/derrotada) y su casilla es del
 * territorio de esta facción ahora mismo. `extraFilter` opcional para que
 * `!conquista` excluya los dungeon y `!dungeon` excluya todo lo que NO sea
 * dungeon, sin duplicar esta función.
 */
function pickEligibleStructure(match, factionNumber, extraFilter = () => true) {
  const eligible = match.structures.filter(
    (s) => hasGarrison(s) && match.tiles[s.tileId].ownerFactionNumber === factionNumber && extraFilter(s)
  );
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

function hasGarrison(structure) {
  return structure.aiTroops + structure.archerTroops + structure.cavalryTroops + (structure.orcCount || 0) + (structure.goblinCount || 0) > 0;
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
  // `null` en *Rounds marca un edificio PERMANENTE (nunca expira, a
  // diferencia de un barraca/campo-arquería/caballeriza votado — ver
  // PRODUCTION_ROUNDS en rules/troopBuildings.js): conquistar un castillo o
  // una aldea es un premio duradero, no un chute de 3 rondas.
  if (structure.type === 'castle') { tile.cavalryCount += 1; tile.cavalryRounds.push(null); }
  else if (structure.type === 'village') { tile.leviesCount += 2; tile.leviesRounds.push(null, null); }
  else if (structure.type === 'port') tile.industryCount += 2;
}

module.exports = { resolveConquista, resolveDungeon, structureDefensePower, structureAttackPower };
