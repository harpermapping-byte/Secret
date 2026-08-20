'use strict';

const { ACTION_INDUSTRY, ACTION_ATTACK } = require('../commands');
const { shuffle } = require('./shared');
const { wonderIndustryBonus } = require('./wonders');
const { museumIndustryBonus } = require('./bosses');

// Cada casilla controlada rinde esto por ronda por el mero hecho de tenerla.
const PASSIVE_INDUSTRY_PER_TERRITORY = 0.1;
// Cada EDIFICIO de industria (uno por cada `!industria` votado, ver
// buildIndustries()) suma esto por ronda, ademas del rendimiento pasivo de su
// casilla. Como el edificio vive en la casilla (tile.industryCount, ver
// mapTemplates.js), conquistar una casilla con 1 industria le pasa al nuevo
// dueño los 0.1 + 0.5 = 0.6 completos.
const INDUSTRY_PER_BUILDING = 0.5;
// Nivel 2: cuantos edificios de industria se levantan solos al desbloquear
// (como si otros tantos usuarios hubieran votado !industria esa ronda).
const TIER2_AUTO_INDUSTRIES = 3;
// Nivel 1: cuantos soldados pasan a caballero de golpe.
const TIER1_KNIGHT_COUNT = 1;
// Nivel 4 (castillo especial, ver rules/towers.js para el mismo patron de
// "edificio + tope + produccion pasiva" con las torres): cuantas tropas
// especiales trae el castillo AL CONSTRUIRSE, cuantas mas produce cada ronda
// despues (mientras no se llegue al tope), el tope por faccion, y el bonus
// de ataque/defensa FIJO que aporta cada una (simetrico, como un dungeon).
const SPECIAL_CASTLE_INITIAL_TROOPS = 2;
const SPECIAL_CASTLE_TROOPS_PER_ROUND = 1;
const SPECIAL_TROOP_CAP = 10;
const SPECIAL_TROOP_COMBAT_BONUS = 0.4;

/**
 * Las 4 mejoras, en orden fijo. `perPlayer` = industria acumulada necesaria
 * POR CADA JUGADOR de la faccion, no un numero absoluto.
 *
 * Por que por jugador y no fijo: la industria de una faccion crece con su
 * numero de miembros (cada `!industria` levanta un edificio que renta para
 * siempre), asi que con un umbral fijo la partida cambia por completo segun
 * cuanta gente haya en el chat. Medido con el modelo real: con umbrales fijos
 * de 10/20/30/40, una faccion de 3 personas desbloquea las 4 mejoras en las
 * rondas 4-6-7-9, pero una de 60 las tiene TODAS en la ronda 2. No existe un
 * numero fijo que funcione en los dos casos.
 *
 * Escalando el umbral con el tamaño de la faccion, la progresion sale igual
 * tenga 3 o 60 miembros (rondas ~4-7-10-13 con un 60% de participacion), y lo
 * que de verdad decide el ritmo pasa a ser cuanta gente colabora: con un 20%
 * de la faccion haciendo industria son las rondas 8-13-19-24; con el 100%,
 * 3-6-8-10.
 *
 * Son tambien las 4 marcas de la probeta del panel de facciones (ver
 * public/factionCards.js): el ultimo umbral es el que la llena del todo, asi
 * que cambiar estos numeros mueve las marcas solo. Y como el umbral depende
 * del tamaño de cada faccion, la probeta es comparable entre facciones
 * distintas: mide "como de bien coopera mi gente", no "cuanta gente tengo".
 *
 * Que hace cada nivel, TODO automatico (nadie vota nada para esto, se
 * dispara solo al cruzar el umbral). El nivel 3 ('caballeros_x3', 3 soldados
 * mas a caballero) se ha RETIRADO segun lo pedido — el nivel 4 de siempre
 * ('tregua') baja a ocupar su hueco (mismo umbral perPlayer=15 que tenia
 * antes 'caballeros_x3', el numero de la POSICION no cambia), y el nuevo
 * nivel 4 es 'castillo_especial':
 *   1 'caballero'         -> 1 soldado al azar de la faccion pasa a caballero
 *   2 'industria_extra'   -> se levantan 3 edificios de industria de golpe
 *   3 'tregua'            -> nadie puede atacar a esta faccion la RONDA
 *                            SIGUIENTE (igual que una alianza automatica con
 *                            todo el mundo, ver resolveIndustryImmunity)
 *   4 'castillo_especial' -> aparece un castillo cerca de la capital de la
 *                            faccion (placeholder decorativo, ver
 *                            public/mapRenderer.js), que trae 2 tropas
 *                            especiales al construirse y produce 1 mas cada
 *                            ronda despues, hasta un tope de 10 por faccion
 *                            — cada una aporta 0.4 de ataque Y defensa fijos
 *                            (ver SPECIAL_TROOP_COMBAT_BONUS, integrado en
 *                            rules/combat.js). Sin aldeanos alrededor, a
 *                            diferencia de la capital.
 */
const INDUSTRY_TIERS = [
  { key: 'caballero', perPlayer: 3 },
  { key: 'industria_extra', perPlayer: 8 },
  { key: 'tregua', perPlayer: 15 },
  { key: 'castillo_especial', perPlayer: 24 },
];

// Suelo de jugadores al calcular los umbrales. Sin el, una faccion a la que
// no se une nadie (o que se queda sin miembros) tendria umbral 0 y
// desbloquearia las 4 mejoras de golpe en la primera ronda.
const MIN_PLAYERS_FOR_THRESHOLDS = 3;

/**
 * Los 4 umbrales absolutos de una faccion, ya multiplicados por su tamaño.
 * Se usa el roster fijado al cerrar el reclutamiento (`rosterSize`), no los
 * vivos de ahora mismo: si bajara con cada baja, las marcas de la probeta se
 * moverian solas a mitad de partida y una faccion diezmada desbloquearia
 * mejoras "gratis" justo por ir perdiendo.
 */
function industryThresholdsFor(faction) {
  const players = Math.max(MIN_PLAYERS_FOR_THRESHOLDS, faction.rosterSize || 0);
  return INDUSTRY_TIERS.map((tier) => tier.perPlayer * players);
}

/**
 * Levanta los edificios de industria votados esta ronda, suma la produccion
 * de cada faccion y desbloquea, en orden, las mejoras cuyo umbral se alcance.
 * Cada mejora se aplica una unica vez (ver docs/GDD seccion 6 "Industria y
 * las 4 mejoras").
 *
 * Produccion de una faccion = (casillas x PASSIVE_INDUSTRY_PER_TERRITORY) +
 * (edificios de industria en sus casillas x INDUSTRY_PER_BUILDING). Los
 * edificios construidos esta misma ronda ya cuentan para esta ronda.
 */
function resolveIndustry(match, context) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;

    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_INDUSTRY].length;
    buildIndustries(match, context, faction, votes);

    // Produccion pasiva del castillo especial (nivel 4, ver INDUSTRY_TIERS):
    // se comprueba con el flag de ANTES de esta ronda, asi que la ronda en la
    // que se construye (mas abajo, en el bucle de niveles) solo da las 2
    // tropas iniciales — el +1/ronda empieza la ronda SIGUIENTE.
    if (faction.specialCastleBuilt && faction.specialTroopCount < SPECIAL_TROOP_CAP) {
      faction.specialTroopCount = Math.min(SPECIAL_TROOP_CAP, faction.specialTroopCount + SPECIAL_CASTLE_TROOPS_PER_ROUND);
    }

    const passive = faction.territoryIds.length * PASSIVE_INDUSTRY_PER_TERRITORY;
    const fromBuildings = countFactionIndustries(match, faction) * INDUSTRY_PER_BUILDING;
    // Maravillas de tipo 'industry' (Guggenheim/La Moncloa/SpaceX, ver
    // rules/wonders.js sección 30): +4/ronda cada una MIENTRAS la facción
    // posea la casilla en la que salió — se suma en vivo, sin ningún estado
    // propio que guardar.
    const fromWonders = wonderIndustryBonus(match, faction);
    // Museos (trofeo de boss, ver rules/bosses.js sección 31): +1/ronda cada
    // uno, acumulable sin tope ("si matas más de un boss se crea otro
    // museo").
    const fromMuseums = museumIndustryBonus(faction);
    const gained = faction.industryPenaltyActive ? 0 : passive + fromBuildings + fromWonders + fromMuseums;
    faction.industryPenaltyActive = false;

    faction.industry += gained;
    faction.industryGainedLastRound = gained;

    const thresholds = industryThresholdsFor(faction);
    while (
      faction.industryTierIndex < INDUSTRY_TIERS.length &&
      faction.industry >= thresholds[faction.industryTierIndex]
    ) {
      applyIndustryTier(match, context, faction, INDUSTRY_TIERS[faction.industryTierIndex].key);
      faction.industryTierIndex++;
    }
  }
}

/**
 * Levanta un edificio de industria por cada `!industria` votado, cada uno en
 * una casilla AL AZAR de las que la faccion controla ahora mismo (varios
 * votos pueden caer en la misma casilla, igual que se pueden amontonar varias
 * fabricas en una misma region). Se llama con el reparto de territorio ya
 * resuelto de esta ronda, asi que nunca construye en una casilla que la
 * faccion acaba de perder.
 */
function buildIndustries(match, context, faction, count) {
  if (count <= 0) return;
  for (let i = 0; i < count; i++) {
    const tileId = faction.territoryIds[Math.floor(Math.random() * faction.territoryIds.length)];
    match.tiles[tileId].industryCount += 1;
  }
}

/** Edificios de industria en pie sobre las casillas que la faccion controla ahora mismo. */
function countFactionIndustries(match, faction) {
  let total = 0;
  for (const tileId of faction.territoryIds) total += match.tiles[tileId].industryCount;
  return total;
}

function applyIndustryTier(match, context, faction, tierKey) {
  context.roundEvents.industryUnlocks.push({ factionNumber: faction.number, tierKey });
  switch (tierKey) {
    case 'caballero':
      return upgradeRandomSoldiers(match, faction, TIER1_KNIGHT_COUNT);
    case 'industria_extra':
      return buildIndustries(match, context, faction, TIER2_AUTO_INDUSTRIES);
    case 'castillo_especial':
      faction.specialCastleBuilt = true;
      faction.specialTroopCount = Math.min(SPECIAL_TROOP_CAP, faction.specialTroopCount + SPECIAL_CASTLE_INITIAL_TROOPS);
      return;
    case 'tregua':
      // Se activa la RONDA SIGUIENTE, no esta — mismo patron que el Sabotaje
      // (industryPenaltyNextRound): se arma aqui y gameEngine.js lo "activa"
      // al principio de resolveRound() de la proxima ronda. Ver
      // resolveIndustryImmunity() mas abajo, que es quien de verdad anula los
      // ataques mientras dure.
      faction.attackImmuneNextRound = true;
      return;
    default:
      return;
  }
}

/**
 * Sube a caballero `count` soldados al azar de la faccion — nunca a alguien
 * que YA sea caballero (el filtro `unitType === 'soldier'` ya lo garantiza
 * solo, asi que el nivel 3 nunca repite a quien ascendio el nivel 1). Si hay
 * menos soldados vivos que `count` (faccion muy pequeña o diezmada), sube a
 * todos los que haya.
 */
function upgradeRandomSoldiers(match, faction, count) {
  const soldiers = [...match.players.values()].filter(
    (p) => p.alive && p.factionNumber === faction.number && p.unitType === 'soldier'
  );
  shuffle(soldiers)
    .slice(0, count)
    .forEach((player) => {
      player.unitType = 'knight';
    });
}

/**
 * Anula los ataques que reciba una faccion con la tregua del nivel 4 activa
 * ESTA ronda (ver 'tregua' en applyIndustryTier) — igual que hace
 * resolveAlliances() con un par aliado, pero sin depender de
 * `match.config.alliancesEnabled`: es una recompensa automatica de
 * industria, no la mecanica de alianzas votadas, asi que funciona aunque el
 * admin las tenga desactivadas en esta partida. Se llama desde
 * gameEngine.js justo despues de resolveAlliances(), con el mismo `context`
 * (los usuarios anulados aqui tambien cuentan como inactivos esta ronda).
 */
function resolveIndustryImmunity(match, context) {
  for (const faction of match.factions) {
    if (!faction.attackImmuneActive) continue;
    for (const attackerFaction of match.factions) {
      const attackVotes = context.votesByFactionAndType.get(attackerFaction.number)[ACTION_ATTACK];
      const userIds = attackVotes.get(faction.number);
      if (userIds && userIds.length) {
        userIds.forEach((userId) => context.forceInactive.add(userId));
        attackVotes.delete(faction.number);
      }
    }
  }
}

/**
 * Bonus de ataque/defensa FIJO (0.4 cada uno, simetrico) que aportan las
 * tropas especiales del castillo del nivel 4 de industria — se suma tal cual
 * en rules/combat.js, igual que towerDefenseBonus() de rules/towers.js pero
 * afectando a los DOS lados del combate (ataque Y defensa), tal y como se
 * pidio ("0.4 de defensa y ataque").
 */
function specialTroopCombatBonus(faction) {
  return (faction.specialTroopCount || 0) * SPECIAL_TROOP_COMBAT_BONUS;
}

module.exports = {
  resolveIndustry,
  resolveIndustryImmunity,
  specialTroopCombatBonus,
  INDUSTRY_TIERS,
  industryThresholdsFor,
  MIN_PLAYERS_FOR_THRESHOLDS,
  PASSIVE_INDUSTRY_PER_TERRITORY,
  INDUSTRY_PER_BUILDING,
  SPECIAL_TROOP_CAP,
  SPECIAL_TROOP_COMBAT_BONUS,
  SPECIAL_CASTLE_INITIAL_TROOPS,
  SPECIAL_CASTLE_TROOPS_PER_ROUND,
};
