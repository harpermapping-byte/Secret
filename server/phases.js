'use strict';

// Fases de una partida. Ver docs/ACCIONES.md seccion 1.
// Solo gameEngine.js cambia la fase actual.

const PHASE_CONFIG = 'config';
const PHASE_RECRUITMENT = 'recruitment';
const PHASE_ACTION = 'action';
const PHASE_RESOLUTION = 'resolution';
const PHASE_SUMMARY = 'summary';
const PHASE_END = 'end';

module.exports = {
  PHASE_CONFIG,
  PHASE_RECRUITMENT,
  PHASE_ACTION,
  PHASE_RESOLUTION,
  PHASE_SUMMARY,
  PHASE_END,
};
