'use strict';

// Fases de una partida. Ver docs/ACCIONES.md seccion 1.
// Solo gameEngine.js cambia la fase actual.

const PHASE_CONFIG = 'config';
const PHASE_RECRUITMENT = 'recruitment';
const PHASE_ACTION = 'action';
const PHASE_RESOLUTION = 'resolution';
const PHASE_SUMMARY = 'summary';
// Paron decorativo entre fases (el esqueleto con el cartel, ver
// docs/ACCIONES.md seccion 13): ninguna accion de chat tiene esta fase como
// requerida, asi que VALID_PHASE_BY_ACTION en commands.js ya rechaza sola
// cualquier comando mientras dura, sin necesitar ningun caso especial.
const PHASE_TRANSITION = 'transition';
const PHASE_END = 'end';

module.exports = {
  PHASE_CONFIG,
  PHASE_RECRUITMENT,
  PHASE_ACTION,
  PHASE_RESOLUTION,
  PHASE_SUMMARY,
  PHASE_TRANSITION,
  PHASE_END,
};
