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
  VALID_PHASE_BY_ACTION,
  parseCommand,
};
