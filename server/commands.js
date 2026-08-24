'use strict';

const { PHASE_RECRUITMENT, PHASE_ACTION } = require('./phases');

// Tipos de accion. Ver docs/ACCIONES.md seccion 2.
// Unico modulo que interpreta texto de chat -> comando del juego.

const ACTION_JOIN_FACTION = 'JOIN_FACTION';
const ACTION_INDUSTRY = 'INDUSTRY';
const ACTION_ATTACK = 'ATTACK';
const ACTION_DEFEND = 'DEFEND';
const ACTION_EXPAND = 'EXPAND';
const ACTION_SPECIAL = 'SPECIAL';
const ACTION_ALLIANCE = 'ALLIANCE';
// Los 3 tipos de tropa de IA que se pueden construir con edificio propio
// (ver rules/troopBuildings.js) — misma mecanica que !industria: un voto,
// un edificio, sin objetivo. Ver docs/ACCIONES.md seccion 19.
const ACTION_LEVAS = 'LEVAS';
const ACTION_ARQUEROS = 'ARQUEROS';
const ACTION_CABALLEROS = 'CABALLEROS';
// Ataca a una estructura neutral (castillo/aldea/puerto) al azar dentro de TU
// territorio, ver rules/structures.js y docs/ACCIONES.md seccion 20.
const ACTION_CONQUISTA = 'CONQUISTA';
// Ataca a un dungeon (orcos/goblins) dentro de TU territorio — comando
// APARTE de !conquista a propósito (solo aparecen si el admin los activó, y
// la recompensa es distinta: una estatua junto a tu capital, no producción
// para la casilla). Ver rules/structures.js y docs/ACCIONES.md sección 27.
const ACTION_DUNGEON = 'DUNGEON';
// Construye una torre (2 rondas: esta ronda queda "en obras", la siguiente
// se termina sola, sin volver a votar) — +0.5 de defensa pasiva por torre
// terminada, máximo 10 por facción. Ver rules/towers.js y
// docs/ACCIONES.md sección 28.
const ACTION_TOWER = 'TORRE';
// Ataca a un boss (placeholder grande, ataque/defensa 5-10) que esté
// vagando por TU territorio — solo aparecen si el admin los activó (1 a 3
// por mapa). Al derrotarlo, la facción gana un museo junto a su capital
// (+1 leva/ronda, +1 industria/ronda, +2 defensa base, cada uno acumulable).
// Ver rules/bosses.js y docs/ACCIONES.md sección 31.
const ACTION_BOSS = 'BOSS';
// Construye una vivienda junto a tu capital (anillo anti-solape, igual que
// estatua/museo/iglesia) — no da tropas, sube el LIMITE de tropas de CADA
// jugador de la facción +5 por vivienda, máximo 10 por facción (+50 en
// total). Ver rules/housing.js y docs/ACCIONES.md.
const ACTION_CASAS = 'CASAS';
// Manda tu jugador (con tus propias tropas) a apoyar la defensa de la
// capital de OTRO jugador de OTRA facción — no cambia de facción ni forma
// una alianza permanente, solo suma tu defensa a la suya si esa facción
// recibe algún ataque ESTA ronda (igual que un !defender normal, pero para
// una facción que no es la tuya). Ver rules/gameEngine.js handleChatCommand
// (resuelve el nombre a una facción) y docs/ACCIONES.md.
const ACTION_APOYAR = 'APOYAR';

// En que fase es valido cada tipo de accion.
const VALID_PHASE_BY_ACTION = {
  [ACTION_JOIN_FACTION]: PHASE_RECRUITMENT,
  [ACTION_INDUSTRY]: PHASE_ACTION,
  [ACTION_ATTACK]: PHASE_ACTION,
  [ACTION_DEFEND]: PHASE_ACTION,
  [ACTION_EXPAND]: PHASE_ACTION,
  [ACTION_SPECIAL]: PHASE_ACTION,
  [ACTION_ALLIANCE]: PHASE_ACTION,
  [ACTION_LEVAS]: PHASE_ACTION,
  [ACTION_ARQUEROS]: PHASE_ACTION,
  [ACTION_CABALLEROS]: PHASE_ACTION,
  [ACTION_CONQUISTA]: PHASE_ACTION,
  [ACTION_DUNGEON]: PHASE_ACTION,
  [ACTION_TOWER]: PHASE_ACTION,
  [ACTION_BOSS]: PHASE_ACTION,
  [ACTION_CASAS]: PHASE_ACTION,
  [ACTION_APOYAR]: PHASE_ACTION,
};

const JOIN_RE = /^!faccion(\d+)$/i;
const INDUSTRY_RE = /^!industria$/i;
const ATTACK_RE = /^!ataque\s+(\d+)$/i;
const DEFEND_RE = /^!defender$/i;
const EXPAND_RE = /^!expansion$/i;
const SPECIAL_RE = /^!especial$/i;
const ALLIANCE_RE = /^!alianza\s+(\d+)$/i;
const LEVAS_RE = /^!levas$/i;
const ARQUEROS_RE = /^!arqueros$/i;
const CABALLEROS_RE = /^!caballeros$/i;
const CONQUISTA_RE = /^!conquista$/i;
const DUNGEON_RE = /^!dungeon$/i;
const TOWER_RE = /^!torre$/i;
const BOSS_RE = /^!boss$/i;
const CASAS_RE = /^!casas$/i;
const APOYAR_RE = /^!apoyar\s+(\S+)$/i;

/**
 * Convierte un mensaje de chat en { type, targetFactionNumber } o null si no es un comando reconocido.
 * No valida fase ni estado del jugador: eso lo hace gameEngine.handleChatCommand.
 */
function parseCommand(rawText) {
  const text = (rawText || '').trim();

  let match = text.match(JOIN_RE);
  if (match) return { type: ACTION_JOIN_FACTION, targetFactionNumber: Number(match[1]) };

  if (INDUSTRY_RE.test(text)) return { type: ACTION_INDUSTRY, targetFactionNumber: null };

  match = text.match(ATTACK_RE);
  if (match) return { type: ACTION_ATTACK, targetFactionNumber: Number(match[1]) };

  if (DEFEND_RE.test(text)) return { type: ACTION_DEFEND, targetFactionNumber: null };

  if (EXPAND_RE.test(text)) return { type: ACTION_EXPAND, targetFactionNumber: null };

  if (SPECIAL_RE.test(text)) return { type: ACTION_SPECIAL, targetFactionNumber: null };

  match = text.match(ALLIANCE_RE);
  if (match) return { type: ACTION_ALLIANCE, targetFactionNumber: Number(match[1]) };

  if (LEVAS_RE.test(text)) return { type: ACTION_LEVAS, targetFactionNumber: null };

  if (ARQUEROS_RE.test(text)) return { type: ACTION_ARQUEROS, targetFactionNumber: null };

  if (CABALLEROS_RE.test(text)) return { type: ACTION_CABALLEROS, targetFactionNumber: null };

  if (CONQUISTA_RE.test(text)) return { type: ACTION_CONQUISTA, targetFactionNumber: null };

  if (DUNGEON_RE.test(text)) return { type: ACTION_DUNGEON, targetFactionNumber: null };

  if (TOWER_RE.test(text)) return { type: ACTION_TOWER, targetFactionNumber: null };

  if (BOSS_RE.test(text)) return { type: ACTION_BOSS, targetFactionNumber: null };

  if (CASAS_RE.test(text)) return { type: ACTION_CASAS, targetFactionNumber: null };

  match = text.match(APOYAR_RE);
  if (match) return { type: ACTION_APOYAR, targetFactionNumber: null, targetUsername: match[1] };

  return null;
}

module.exports = {
  ACTION_JOIN_FACTION,
  ACTION_INDUSTRY,
  ACTION_ATTACK,
  ACTION_DEFEND,
  ACTION_EXPAND,
  ACTION_SPECIAL,
  ACTION_ALLIANCE,
  ACTION_LEVAS,
  ACTION_ARQUEROS,
  ACTION_CABALLEROS,
  ACTION_CONQUISTA,
  ACTION_DUNGEON,
  ACTION_TOWER,
  ACTION_BOSS,
  ACTION_CASAS,
  ACTION_APOYAR,
  VALID_PHASE_BY_ACTION,
  parseCommand,
};
