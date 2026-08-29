'use strict';

/**
 * TAMAÑOS DE CADA SPRITE EN EL MAPA — el único sitio que hace falta tocar
 * para agrandar/encoger un edificio, una tropa, un trofeo, etc.
 *
 * Cada número es el ANCHO con el que se dibuja ese sprite en el mapa, en
 * "píxeles de mundo" (la unidad que usa `public/mapRenderer.js` para todo lo
 * que escala con el zoom — no son píxeles de pantalla, así que un mismo
 * valor se ve igual de grande a cualquier nivel de zoom). La ALTURA no se
 * configura aquí: sale sola del aspecto real del PNG en `public/sprites/`
 * (un sprite el doble de alto que de ancho se dibuja el doble de alto que
 * de ancho, conserve el tamaño que conserve aquí) — así que si sustituyes
 * un placeholder por arte definitivo con otras proporciones, solo hace
 * falta ajustar el ancho de aquí si el nuevo tamaño no te convence, nunca
 * la altura.
 *
 * Excepción: `soldier`/`knight` sí llevan ancho Y alto fijos los dos (en
 * vez de que la altura salga del aspecto del PNG) porque su sprite
 * necesita un "pie" fijo en el suelo para que el brinquito al andar y el
 * giro izquierda/derecha queden bien anclados — cambiar solo su ancho aquí
 * deformaría la figura en vez de agrandarla, así que cambia los dos juntos
 * si quieres agrandarlos.
 *
 * Cómo editar: cambia el número, guarda, recarga la página (F5) — no hace
 * falta reiniciar el servidor ni tocar ningún otro archivo. Si un sprite
 * nuevo (edificio o tropa futura) no aparece aquí, `mapRenderer.js` usará
 * el tamaño que tenga puesto por código en su lugar; para poder editarlo
 * desde aquí también, añade su clave a la sección que corresponda avisando
 * a quien mantenga `mapRenderer.js`.
 *
 * Esto NO afecta a la resolución con la que se HORNEA un placeholder (eso
 * lo decide `tools/bakeSpritePlaceholders.js`, un paso aparte que solo hace
 * falta re-ejecutar si cambias las FORMAS dibujadas a mano de un
 * placeholder) — aquí solo se decide con qué tamaño se PINTA en el mapa el
 * PNG que sea, placeholder o arte final.
 *
 * Rendimiento: cambiar estos números es gratis. Cada sprite ya se dibuja
 * con un único `ctx.drawImage()` por frame (el coste real de esa llamada es
 * el mismo dibuje el sprite a 10px o a 500px), y estos valores se leen una
 * sola vez al cargar la página, no en cada frame — así que no hay ninguna
 * pérdida de fluidez por tocar este archivo, subas o bajes los números que
 * subas o bajes.
 */
window.SPRITE_SIZES = {
  // ------------------------------------------------------------------
  // Decoración de mapa (edificios neutrales + paisaje) — public/sprites/
  // ------------------------------------------------------------------
  castle: 150,
  port: 115,
  village: 90,
  dungeon: 90,
  tree: 55,
  'ship-small': 95,
  'ship-big': 140,
  whale: 130,
  kraken: 320,

  // ------------------------------------------------------------------
  // Industria y edificios de tropa (!industria/!levas/!arqueros/
  // !caballeros/!torre) — se dispersan varios por casilla, ver
  // paintBuildingMarkers()/paintIndustryMarkers() en mapRenderer.js.
  // ------------------------------------------------------------------
  industry: 67.5,
  barraca: 80,
  'campo-arqueria': 80,
  caballeriza: 80,
  torre: 80,
  'torre-obras': 80,

  // ------------------------------------------------------------------
  // Jugadores (caminantes) — llevan ancho Y alto fijos, ver nota arriba.
  // ------------------------------------------------------------------
  soldier: { width: 22, height: 36 },
  knight: { width: 26, height: 42 },

  // ------------------------------------------------------------------
  // Tropas de IA que siguen a un jugador (!levas/!arqueros/!caballeros,
  // más la generación pasiva de soldados) y su equivalente bárbaro
  // (guarnición neutral de castillo/aldea/puerto sin conquistar).
  // ------------------------------------------------------------------
  troop: 12,
  'troop-cavalry': 14,
  barbaro: 12,
  'barbaro-arquero': 12,
  'barbaro-caballero': 14,

  // ------------------------------------------------------------------
  // Dungeon (!dungeon): guarnición de orcos/goblins.
  // ------------------------------------------------------------------
  orco: 18,
  goblin: 11,

  // ------------------------------------------------------------------
  // Aldeanos — pasean junto a estructuras conquistadas y junto a la
  // capital/estatuas/museo de cada facción.
  // ------------------------------------------------------------------
  aldeano: 13,

  // ------------------------------------------------------------------
  // Capital de facción y sus trofeos (banner de color, estatua de dungeon,
  // museo de boss, iglesia del nivel 3 de industria, casas de !casas,
  // castillo especial del nivel 4 + sus tropas especiales).
  // ------------------------------------------------------------------
  capital: 120,
  banner: 26,
  estatua: 34,
  museo: 40,
  iglesia: 44,
  casa: 40,
  'castillo-especial': 70,
  'tropa-especial': 14,

  // ------------------------------------------------------------------
  // Maravillas (una entrada por cada una de las 6 fijas, ver
  // mapTemplates.js WONDER_TYPES) — se pueden agrandar/encoger por
  // separado si alguna queda desproporcionada con su arte definitivo.
  // ------------------------------------------------------------------
  'wonder-guggenheim': 60,
  'wonder-numancia': 60,
  'wonder-moncloa': 60,
  'wonder-spacex': 60,
  'wonder-kebab': 60,
  'wonder-contrato': 60,

  // ------------------------------------------------------------------
  // Bosses (!boss) — una entrada por cada uno de los 3 fijos.
  // ------------------------------------------------------------------
  ogro: 62,
  troll: 54,
  behemot: 70,

  // ------------------------------------------------------------------
  // Vaca (easter egg decorativo, sin efecto de juego).
  // ------------------------------------------------------------------
  cow: 34,
  'cow-follower': 15,

  // ------------------------------------------------------------------
  // Otros dos easter eggs decorativos (uno de cada, siempre en tierra,
  // sin efecto de juego) — ver mapTemplates.js EASTER_EGG_TYPES.
  // ------------------------------------------------------------------
  'easteregg-ovni': 50,
  'easteregg-yeti': 40,

  // ------------------------------------------------------------------
  // Fase de Resolución (ver docs/ACCIONES.md): polvareda de combate
  // (dos sprites intercalados) y carromato de conquista/expansión.
  // ------------------------------------------------------------------
  'dust-1': 92,
  'dust-2': 92,
  wagon: 56,
};
