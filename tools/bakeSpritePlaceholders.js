'use strict';

/**
 * Genera los PNG *placeholder* de los elementos decorativos del mapa
 * (castillos, puertos, aldeas, arboles, barcos, ballenas, kraken) y del
 * cursor del raton. Script de DESARROLLO: se ejecuta a mano una vez
 * (`node tools/bakeSpritePlaceholders.js`) y deja los archivos en
 * `public/sprites/`.
 *
 * SON PLACEHOLDERS A PROPOSITO: formas planas de color con borde oscuro, tal
 * y como se pidieron (cuadrado para castillo, cuadrado gris para aldea,
 * rectangulo vertical para arbol, rectangulo azul para ballena...). La gracia
 * es que el juego los carga como IMAGENES, no como formas dibujadas en
 * codigo: para poner el arte definitivo basta con **sobrescribir el .png
 * correspondiente en `public/sprites/` con el tuyo y recargar**, sin tocar
 * una linea de codigo ni volver a ejecutar este script.
 *
 * Si el arte nuevo tiene otra proporcion, lo unico que puede hacer falta
 * ajustar es el tamaño con el que se dibuja en el mapa: `DECOR_SPRITES` en
 * `public/mapRenderer.js` (una linea por tipo, con su ancho en pixeles de
 * mundo). La altura sale sola del aspecto real del PNG.
 *
 * Los sprites se dibujan anclados por su BASE (abajo-centro), como en
 * cualquier juego 2.5D: asi un castillo alto "se apoya" en el suelo en vez de
 * quedar centrado sobre su punto.
 */

const fs = require('fs');
const path = require('path');
const { encodePNGRGBA } = require('./pngEncoder');

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/** Lienzo RGBA vacio (todo transparente) con helpers de dibujo minimos. */
function createCanvas(w, h) {
  const px = new Uint8Array(w * h * 4);

  function set(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    px[i] = clamp255(r); px[i + 1] = clamp255(g); px[i + 2] = clamp255(b); px[i + 3] = clamp255(a);
  }

  /** Rectangulo relleno con borde oscuro de `border` px y un leve sombreado vertical. */
  function rect(x0, y0, rw, rh, color, border = 2, borderColor = [24, 18, 12]) {
    for (let y = y0; y < y0 + rh; y++) {
      for (let x = x0; x < x0 + rw; x++) {
        const onBorder = x < x0 + border || x >= x0 + rw - border || y < y0 + border || y >= y0 + rh - border;
        if (onBorder) { set(x, y, borderColor); continue; }
        // Sombreado: mas claro arriba, mas oscuro abajo — da algo de volumen
        // sin dejar de ser una forma plana de placeholder.
        const t = (y - y0) / Math.max(1, rh - 1);
        const shade = 1.12 - t * 0.3;
        set(x, y, [color[0] * shade, color[1] * shade, color[2] * shade]);
      }
    }
  }

  /** Triangulo relleno por sus 3 vertices (usado para el cursor y las velas). */
  function triangle(ax, ay, bx, by, cx, cy, color, borderColor) {
    const minX = Math.floor(Math.min(ax, bx, cx)), maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy)), maxY = Math.ceil(Math.max(ay, by, cy));
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area === 0) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area;
        const w1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        // Cerca de cualquier arista -> color de borde
        const edge = Math.min(w0, w1, 1 - w0 - w1);
        set(x, y, borderColor && edge < 0.06 ? borderColor : color);
      }
    }
  }

  return { px, w, h, set, rect, triangle, toPNG: () => encodePNGRGBA(w, h, px) };
}

// ---------------------------------------------------------------------------
// Definicion de cada placeholder. Cambiar aqui solo afecta al PNG generado;
// el juego se limita a cargar el archivo que haya en public/sprites/.
// ---------------------------------------------------------------------------
const SPRITES = {
  // TIERRA
  castle: (c) => {          // cuadrado rojizo con dos torres, 48x48
    c.rect(6, 14, 36, 34, [138, 59, 59]);
    c.rect(2, 4, 12, 20, [116, 48, 48]);
    c.rect(34, 4, 12, 20, [116, 48, 48]);
  },
  port: (c) => {            // cuadrado ambar con un pantalan, 40x40
    c.rect(4, 12, 32, 26, [201, 138, 58]);
    c.rect(14, 2, 4, 14, [90, 66, 30], 1);
    c.rect(10, 2, 16, 4, [120, 88, 40], 1);
  },
  village: (c) => {         // cuadrado gris (como se pidio), 32x32
    c.rect(3, 8, 26, 22, [154, 154, 154]);
    c.rect(11, 2, 10, 8, [124, 124, 124]);
  },

  // DUNGEON: guarnición de orcos/goblins (ver docs/ACCIONES.md sección 27,
  // rules/structures.js, `!dungeon`) — hasta ahora solo se veían las tropas
  // paseando y el cartel de guarnición, sin ningún edificio en el sitio en
  // el que salen. Montículo rocoso con la boca de la cueva, oscura. 50x38.
  dungeon: (c) => {
    const stone = [120, 112, 104];
    const dark = [58, 52, 48];
    c.triangle(2, 22, 25, 2, 48, 22, stone, dark); // montículo
    c.rect(0, 20, 50, 10, stone, 2);               // base
    c.rect(17, 14, 16, 18, [16, 12, 12], 1);        // boca de la cueva, oscura
  },
  tree: (c) => {            // rectangulo vertical verde, 22x40
    c.rect(8, 26, 6, 14, [74, 52, 32], 1); // tronco
    c.rect(2, 0, 18, 28, [47, 107, 52]);   // copa
  },

  // AGUA
  'ship-small': (c) => {    // casco claro + vela, 30x22
    c.rect(2, 12, 26, 9, [216, 210, 196]);
    c.rect(14, 2, 3, 11, [90, 74, 52], 1);
    c.triangle(16, 3, 26, 12, 16, 12, [238, 234, 224], [60, 50, 38]);
  },
  'ship-big': (c) => {      // casco mayor + dos velas, 46x28
    c.rect(2, 16, 42, 11, [184, 174, 152]);
    c.rect(12, 2, 3, 15, [80, 64, 44], 1);
    c.rect(30, 5, 3, 12, [80, 64, 44], 1);
    c.triangle(14, 3, 26, 16, 14, 16, [236, 230, 216], [60, 50, 38]);
    c.triangle(32, 6, 42, 16, 32, 16, [236, 230, 216], [60, 50, 38]);
  },
  whale: (c) => {           // rectangulo azul (como se pidio) + cola, 48x18
    c.rect(0, 4, 38, 13, [47, 95, 168]);
    c.triangle(37, 2, 47, 9, 37, 16, [40, 80, 142], [20, 34, 60]);
  },
  kraken: (c) => {          // masa mayor con tentaculos, 96x96
    c.rect(30, 20, 36, 40, [106, 63, 143]);
    for (let i = 0; i < 4; i++) {
      c.rect(8 + i * 22, 58, 10, 30 - i * 4, [88, 50, 122], 2);
    }
  },

  // CURSOR DEL RATON (fuera del mapa: lo usa el CSS, ver public/shared.css)
  cursor: (c) => {          // triangulo blanco con borde oscuro, 32x32
    c.triangle(1, 1, 1, 27, 20, 20, [245, 245, 245], [26, 22, 18]);
  },

  // ESQUELETO DEL CARTEL DE CAMBIO DE RONDA (fuera del mapa, fondo
  // transparente: lo usa #transitionBanner en public/index.html, ver
  // docs/ACCIONES.md seccion 13). Postura de paseo con un brazo en alto
  // sujetando un cartel en blanco — el texto del cartel NO va horneado aqui,
  // se dibuja por encima con HTML/CSS (transitionMessage() en index.html)
  // para poder cambiarlo segun la fase sin regenerar la imagen. 64x110.
  skeleton: (c) => {
    const bone = [222, 214, 194];
    const boneBorder = [42, 36, 28];
    c.rect(20, 4, 22, 20, bone, 2, boneBorder);   // calavera
    c.rect(16, 24, 30, 32, bone, 2, boneBorder);  // caja toracica
    c.rect(18, 56, 26, 13, bone, 2, boneBorder);  // pelvis
    c.rect(10, 28, 6, 24, bone, 2, boneBorder);   // brazo caido
    c.rect(46, 8, 6, 28, bone, 2, boneBorder);    // brazo en alto (sujeta el cartel)
    c.rect(19, 68, 8, 30, bone, 2, boneBorder);   // pierna trasera
    c.rect(33, 68, 8, 26, bone, 2, boneBorder);   // pierna delantera (zancada)
    c.rect(42, 0, 22, 16, [214, 196, 150], 2, [90, 66, 30]); // cartel en blanco
  },

  // ICONO DEL BOTON DE AYUDA (fuera del mapa, fondo transparente: lo usa
  // #helpButton en public/index.html, ver docs/ACCIONES.md seccion 14).
  // Medallon dorado con una interrogacion en bloques, a juego con las chapas
  // de laton del resto de botones pero suelto (sin border-image), para poder
  // sustituirlo por un icono cualquiera sin tocar CSS. 64x64.
  'help-icon': (c) => {
    c.rect(4, 4, 56, 56, [201, 158, 72], 3, [74, 52, 20]); // medallon
    const ink = [51, 35, 15];
    c.rect(22, 14, 20, 8, ink, 0);  // interrogacion, en bloques: arco superior
    c.rect(34, 20, 8, 10, ink, 0);  // lado derecho del arco
    c.rect(26, 28, 16, 8, ink, 0);  // codo hacia el palo
    c.rect(26, 36, 8, 8, ink, 0);   // palo
    c.rect(26, 46, 8, 8, ink, 0);   // punto
  },

  // MARCADOR DE JUGADOR (soldado): antes era un triangulo dibujado a mano en
  // public/mapRenderer.js (drawWalkers), ahora es un sprite de verdad para
  // poder sustituirlo — rectangulo vertical, como pidio el streamer, en vez
  // de triangulo. Dos variantes, izquierda/derecha, que el juego cambia sola
  // segun hacia donde se mueve el marcador (ver stepWalkers()/drawWalkers()
  // en mapRenderer.js) — el "escalon" de abajo marca el pie que va delante,
  // para que se note el cambio de sentido incluso en el placeholder. El
  // juego tiñe este sprite con el color de la faccion en tiempo real (no
  // hace falta un PNG por facción), asi que se hornea en gris neutro. 24x40.
  'soldier-right': (c) => {
    const body = [222, 222, 222];
    c.rect(6, 4, 12, 12, body, 2);   // cabeza
    c.rect(4, 16, 16, 18, body, 2);  // torso
    c.rect(10, 34, 7, 6, body, 2);   // pie de atras
    c.rect(15, 30, 7, 8, body, 2);   // pie de delante (mas adelantado y mas abajo -> zancada a la derecha)
  },
  'soldier-left': (c) => {
    const body = [222, 222, 222];
    c.rect(6, 4, 12, 12, body, 2);
    c.rect(4, 16, 16, 18, body, 2);
    c.rect(7, 34, 7, 6, body, 2);    // pie de atras
    c.rect(2, 30, 7, 8, body, 2);    // pie de delante -> zancada a la izquierda
  },

  // CABALLERO (mejora de industria nivel 1 y 3, ver docs/ACCIONES.md seccion
  // 16): mismo dibujo que el soldado pero un poco mas grande (28x46 en vez
  // de 24x40, "algo mas grande, no mucho" como se pidio) y con un yelmo
  // (banda oscura en la cabeza) para poder distinguirlo del soldado normal
  // incluso en el placeholder. El juego lo tiñe del color de faccion igual
  // que al soldado (ver drawTintedSprite en mapRenderer.js), un unico PNG
  // gris sirve para todas las facciones.
  'knight-right': (c) => {
    const body = [222, 222, 222];
    const helmet = [120, 120, 128];
    c.rect(6, 4, 16, 14, body, 2);
    c.rect(6, 4, 16, 5, helmet, 0); // yelmo
    c.rect(5, 19, 18, 20, body, 2);
    c.rect(12, 39, 8, 7, body, 2);   // pie de atras
    c.rect(18, 35, 8, 9, body, 2);   // pie de delante -> zancada a la derecha
  },
  'knight-left': (c) => {
    const body = [222, 222, 222];
    const helmet = [120, 120, 128];
    c.rect(6, 4, 16, 14, body, 2);
    c.rect(6, 4, 16, 5, helmet, 0);
    c.rect(5, 19, 18, 20, body, 2);
    c.rect(8, 39, 8, 7, body, 2);
    c.rect(2, 35, 8, 9, body, 2);
  },

  // LOGOTIPO (arriba del todo, centrado — ver #gameLogo en public/index.html
  // y docs/ACCIONES.md seccion 16). Fondo transparente, escudo simple en
  // dorado solo para marcar el hueco: el streamer lo sustituye por su
  // logotipo de verdad. A proposito grande (320x140): mejor que sobre y lo
  // recorte el CSS a que se quede corto, como pidio expresamente.
  'logo': (c) => {
    const gold = [201, 158, 72];
    const border = [74, 52, 20];
    c.rect(40, 10, 240, 90, gold, 5, border);      // cuerpo del escudo
    c.triangle(40, 95, 160, 135, 280, 95, gold, border); // punta inferior
  },

  // EDIFICIO DE INDUSTRIA: antes un cuadrado amarillo semitransparente
  // dibujado a mano (paintIndustryMarkers), ahora sprite sustituible. Mas
  // pequeño que `village` en el mapa (ver INDUSTRY_SPRITE_WORLD_WIDTH en
  // mapRenderer.js, menor que el worldWidth de village en DECOR_SPRITES).
  // Tejadillo simple color trigo/ambar. 36x28.
  industry: (c) => {
    c.rect(3, 10, 30, 16, [214, 181, 64], 2, [90, 66, 8]); // cuerpo
    c.rect(0, 2, 36, 10, [176, 132, 46], 2, [90, 66, 8]);  // tejadillo
  },

  // VACA (easter egg, unica en el mapa, ver docs/ACCIONES.md seccion 15):
  // "un rectangulo blanco" tal cual se pidio. Dos variantes izquierda/derecha
  // que alternan solas segun hacia donde vaga, igual que el soldado. 40x24.
  'cow-right': (c) => {
    const body = [245, 245, 245];
    c.rect(2, 4, 30, 16, body, 2);   // cuerpo
    c.rect(28, 0, 10, 10, body, 2);  // cabeza, hacia la derecha
    c.rect(6, 20, 6, 4, body, 2);    // pata trasera
    c.rect(24, 20, 6, 4, body, 2);   // pata delantera
  },
  'cow-left': (c) => {
    const body = [245, 245, 245];
    c.rect(8, 4, 30, 16, body, 2);
    c.rect(2, 0, 10, 10, body, 2);   // cabeza, hacia la izquierda
    c.rect(10, 20, 6, 4, body, 2);
    c.rect(28, 20, 6, 4, body, 2);
  },

  // ACOMPAÑANTE DE LA VACA (easter egg): un unico sprite, sin variante de
  // direccion (no se pidio) — rectangulo vertical que la sigue siempre a
  // poca distancia (ver stepCow() en mapRenderer.js). 18x30.
  'cow-follower': (c) => {
    c.rect(3, 2, 12, 26, [140, 108, 70], 2, [46, 32, 18]);
  },

  // EASTER EGGS #2 y #3 (ver docs/ACCIONES.md, mapTemplates.js
  // EASTER_EGG_TYPES): dos mas, uno de cada, siempre en tierra al azar en
  // cualquier partida nueva — puro decorado, sin efecto de juego, igual que
  // la vaca de arriba. Un ovni y un yeti, sin mas pretensión que ser
  // reconocibles de un vistazo hasta que se sustituyan por arte definitivo.
  'easteregg-ovni': (c) => {         // platillo volante, 50x30
    const hull = [176, 184, 192];
    const dome = [150, 210, 226];
    c.rect(4, 16, 42, 8, hull, 2);       // casco
    c.rect(18, 6, 14, 12, dome, 1);      // cupula
    c.rect(10, 24, 4, 4, [230, 210, 90], 0); // luz
    c.rect(23, 24, 4, 4, [230, 210, 90], 0); // luz
    c.rect(36, 24, 4, 4, [230, 210, 90], 0); // luz
  },
  'easteregg-yeti': (c) => {         // yeti peludo, 34x50
    const fur = [235, 235, 235];
    const dark = [70, 66, 64];
    c.rect(9, 4, 16, 16, fur, 2);    // cabeza
    c.rect(6, 18, 22, 26, fur, 2);   // cuerpo
    c.rect(6, 44, 8, 6, dark, 1);    // pie izquierdo
    c.rect(20, 44, 8, 6, dark, 1);   // pie derecho
    c.rect(13, 9, 3, 3, dark, 0);    // ojo izquierdo
    c.rect(19, 9, 3, 3, dark, 0);    // ojo derecho
  },

  // TROPA DE IA (ver docs/ACCIONES.md seccion 18, rules/troops.js): sigue
  // siempre al jugador que la lleva, como el acompañante de la vaca — mismo
  // mecanismo, otro sprite, sin variante de sentido tampoco. Mas pequeño que
  // el soldado (que es a quien sigue). 14x22.
  troop: (c) => {
    c.rect(4, 2, 6, 6, [176, 196, 168], 1);   // cabeza
    c.rect(2, 8, 10, 13, [176, 196, 168], 1); // cuerpo
  },

  // TROPA DE IA - ARQUERO (!arqueros, ver rules/troopBuildings.js seccion
  // 19): mismo mecanismo que `troop` (sigue al jugador), color distinto para
  // diferenciarse de un vistazo (tono arena/cuero). 14x22.
  'troop-archer': (c) => {
    c.rect(4, 2, 6, 6, [196, 176, 120], 1);
    c.rect(2, 8, 10, 13, [196, 176, 120], 1);
  },

  // TROPA DE IA - CABALLERO (!caballeros): un pelin mas grande que el resto
  // de tropas (va a caballo), mismo mecanismo de seguimiento, tono
  // azul-acero. 16x26.
  'troop-cavalry': (c) => {
    c.rect(5, 2, 6, 6, [150, 150, 168], 1);
    c.rect(2, 8, 12, 16, [150, 150, 168], 1);
  },

  // GUARNICION NEUTRAL PASEANDO (ver docs/ACCIONES.md seccion 23,
  // syncSiteWalkers() en mapRenderer.js): antes reutilizaban el mismo
  // sprite que las tropas del PROPIO jugador (troop/troop-archer/
  // troop-cavalry), lo que impedia re-skinearlos por separado como
  // "bárbaros" — ahora tienen los suyos propios, mismo tamaño que su
  // equivalente de jugador pero en tonos tierra/óxido, más salvajes/
  // hostiles, para poder sustituirlos sin tocar el sprite de las tropas
  // normales. 14x22 / 14x22 / 16x26, igual que troop/troop-archer/
  // troop-cavalry.
  barbaro: (c) => {
    c.rect(4, 2, 6, 6, [150, 92, 54], 1);
    c.rect(2, 8, 10, 13, [150, 92, 54], 1);
  },
  'barbaro-arquero': (c) => {
    c.rect(4, 2, 6, 6, [112, 98, 48], 1);
    c.rect(2, 8, 10, 13, [112, 98, 48], 1);
  },
  'barbaro-caballero': (c) => {
    c.rect(5, 2, 6, 6, [90, 68, 58], 1);
    c.rect(2, 8, 12, 16, [90, 68, 58], 1);
  },

  // DUNGEON (ver docs/ACCIONES.md sección 27, !dungeon): guarnición de
  // orcos y goblins, siempre 2 orcos + 4 goblins paseando alrededor. El
  // orco es GRANDE (verde oscuro, más ancho que un bárbaro), el goblin es
  // PEQUEÑO (verde claro, el más chico de todos los placeholders de
  // unidad) — para que se distingan de un vistazo incluso sin mirar la
  // etiqueta.
  orco: (c) => {
    const body = [64, 92, 48];
    c.rect(7, 2, 10, 9, body, 1);   // cabeza, mas grande que un bárbaro
    c.rect(3, 12, 18, 18, body, 1); // torso ancho
  },
  goblin: (c) => {
    const body = [124, 158, 82];
    c.rect(3, 2, 5, 5, body, 1);
    c.rect(1, 7, 9, 10, body, 1);
  },

  // ESTATUA-TROFEO (ver docs/ACCIONES.md sección 27): se gana al derrotar
  // un dungeon, se coloca junto a la capital de la facción que lo mató. Gris
  // piedra, SIN teñir de color de facción a propósito (es un monumento
  // compartido de la facción, no "de" nadie en particular) — pedestal +
  // figura sencilla.
  estatua: (c) => {
    const stone = [168, 164, 156];
    const dark = [90, 86, 80];
    c.rect(4, 40, 26, 8, dark, 2);   // pedestal
    c.rect(10, 6, 14, 34, stone, 2); // cuerpo de la estatua
    c.rect(12, 0, 10, 8, stone, 2);  // cabeza
  },

  // MUSEO: trofeo por derrotar un boss (ver docs/ACCIONES.md sección 31,
  // `!boss`, rules/bosses.js) — se coloca junto a la capital de quien lo
  // mató, igual mecanismo de anillo que `estatua` (dungeon), pero un
  // edificio con columnas en vez de una figura, para distinguir de un
  // vistazo qué trofeo es cada uno. SIN teñir de color de facción, mismo
  // criterio que `estatua`: es un monumento compartido, no "de" nadie.
  museo: (c) => {
    const stone = [196, 188, 168];
    const dark = [110, 102, 84];
    c.rect(2, 14, 36, 26, stone, 2, dark);    // cuerpo del edificio
    c.triangle(0, 14, 40, 14, 20, 0, stone, dark); // fronton triangular
    c.rect(8, 20, 4, 18, dark, 0);            // columna
    c.rect(18, 20, 4, 18, dark, 0);           // columna
    c.rect(28, 20, 4, 18, dark, 0);           // columna
  },

  // GUARNICION NEUTRAL (ver docs/ACCIONES.md seccion 20, rules/structures.js):
  // la IA que defiende castillo/aldea/puerto antes de que alguien conquiste
  // con !conquista. Mismo tamaño que `troop` (14x22, sin variante de
  // sentido) para que se lea igual de "una unidad" en el marcador de la
  // estructura, pero tono rojo oscuro/hostil para distinguirla a simple
  // vista de las tropas del propio jugador (verdosas/arena/azuladas).
  guardia: (c) => {
    c.rect(4, 2, 6, 6, [140, 60, 52], 1);
    c.rect(2, 8, 10, 13, [140, 60, 52], 1);
  },

  // EDIFICIO DE LEVAS (barraca, !levas): misma tecnica que `industry` pero
  // tejado rojizo, para diferenciarlo de un vistazo en el mapa. Da +5
  // soldados de IA a quien lo construye y +1/turno despues (repartido en la
  // faccion, ver rules/troopBuildings.js). 36x28.
  barraca: (c) => {
    c.rect(3, 12, 30, 14, [176, 132, 90], 2, [72, 46, 20]); // cuerpo de madera
    c.rect(0, 2, 36, 12, [150, 58, 46], 2, [72, 30, 20]);   // tejado rojizo
  },

  // CAMPO DE ARQUERIA (!arqueros): torreta de madera, tejado verde oscuro.
  // Da +5 arqueros de IA al construirlo y +1/turno despues. 36x28.
  'campo-arqueria': (c) => {
    c.rect(6, 8, 24, 18, [150, 132, 96], 2, [64, 52, 30]); // torre
    c.rect(2, 0, 32, 10, [70, 96, 58], 2, [30, 44, 24]);   // tejado verde
  },

  // CABALLERIZA (!caballeros): establo de piedra, tejado azul-grisaceo. Da
  // +5 caballeros de IA al construirlo y +1/turno despues. 36x28.
  caballeriza: (c) => {
    c.rect(2, 12, 32, 14, [120, 108, 96], 2, [50, 44, 38]); // cuerpo piedra
    c.rect(0, 2, 36, 12, [90, 100, 116], 2, [40, 44, 54]);  // tejado azulado
  },

  // TORRE EN OBRAS (!torre, ver rules/towers.js seccion 28): placeholder de
  // la ronda "en construccion" antes de que se promocione sola a torre
  // terminada la ronda siguiente. Andamiaje de madera sin tejado, para
  // distinguirse de un vistazo de la torre ya acabada de abajo. 20x30.
  'torre-obras': (c) => {
    c.rect(6, 10, 8, 20, [176, 132, 90], 1, [72, 46, 20]);  // cuerpo a medias
    c.rect(2, 6, 2, 24, [120, 90, 56], 0);                  // andamio izquierdo
    c.rect(16, 6, 2, 24, [120, 90, 56], 0);                 // andamio derecho
    c.rect(2, 18, 16, 2, [120, 90, 56], 0);                 // travesaño
  },

  // TORRE TERMINADA (!torre): da +0.5 de defensa pasiva por unidad, hasta 10
  // por faccion — se pinta cerca de la capital como el resto de marcadores
  // de defensa. Piedra gris con tejado conico, para leerse claramente como
  // "defensivo" junto a barraca/campo-arqueria/caballeriza. 20x30.
  torre: (c) => {
    c.rect(4, 12, 12, 18, [140, 136, 128], 2, [64, 62, 56]); // cuerpo de piedra
    c.rect(2, 4, 16, 10, [96, 60, 52], 2, [50, 30, 26]);     // tejado conico
    c.rect(8, 0, 4, 6, [96, 60, 52], 0);                     // remate
  },

  // ALDEANO: aparece paseando alrededor de un castillo/aldea/puerto YA
  // CONQUISTADO (sustituye a la guarnicion neutral, ver `guardia` mas
  // arriba) y alrededor de la CAPITAL de cada faccion (ver `capital` mas
  // abajo) — mismo mecanismo de "acompañante paseando" que las tropas de IA,
  // mismo tamaño que `guardia`/`troop` (14x22, sin variante de sentido), tono
  // calido/trigo para leerse claramente como "civil" y no como tropa.
  aldeano: (c) => {
    c.rect(4, 2, 6, 6, [196, 158, 96], 1);
    c.rect(2, 8, 10, 13, [196, 158, 96], 1);
  },

  // CAPITAL DE FACCION: placeholder representativo (ver docs/ACCIONES.md),
  // uno de los territorios iniciales de cada faccion lo lleva desde que
  // empieza la partida, con aldeanos paseando alrededor. Gris neutro a
  // proposito (como `soldier-right`/`knight-right`): el juego lo tiñe del
  // color de la faccion en tiempo real (ver drawTintedSprite), asi que un
  // unico PNG sirve para todas. Torreon con bandera, mas grande que
  // `castle` para distinguirse de un vistazo. 44x56.
  capital: (c) => {
    const body = [214, 214, 214];
    const dark = [150, 150, 150];
    c.rect(6, 20, 32, 34, body, 2);        // cuerpo del torreon
    c.rect(2, 8, 12, 18, dark, 2);         // torre izquierda
    c.rect(30, 8, 12, 18, dark, 2);        // torre derecha
    c.rect(16, 2, 3, 14, [110, 110, 110], 0); // asta de la bandera
    c.triangle(19, 2, 19, 12, 34, 7, body, dark); // bandera
  },

  // BANNER: quien es el dueño de la capital, un carril fijo a su lado (ver
  // BANNER_OFFSET_X en mapRenderer.js) — SUSTITUYE al tinte de la capital
  // entera (quedaba lavado/poco legible). Paño CASI BLANCO a propósito: el
  // juego lo tiñe casi opaco (alpha .92, ver drawTintedSprite) del color de
  // la facción, y cuanto más claro el paño de base, más "puro" sale el
  // color encima. Asta y travesaño SÍ quedan oscuros (tambien se tiñen,
  // pero al ser tan finos apenas se nota). 20x44.
  banner: (c) => {
    const pole = [90, 70, 40];
    const cloth = [230, 230, 230];
    c.rect(2, 0, 3, 44, pole, 1);      // asta, de arriba a abajo
    c.rect(2, 4, 15, 3, pole, 1);      // travesaño del que cuelga el paño
    c.rect(5, 7, 13, 28, cloth, 1);    // paño, cuelga del travesaño
  },

  // IGLESIA: mejora de nivel 3 de industria (ver rules/industry.js sección
  // 29 nueva) — aparece junto a la capital, igual mecanismo de anillo que
  // estatua/museo, SIN teñir (monumento propio de la facción, pero de
  // piedra neutra como el resto de edificios de trofeo). Cuerpo + tejado a
  // dos aguas + torre con cruz. 36x50.
  iglesia: (c) => {
    const stone = [186, 176, 158];
    const dark = [110, 100, 84];
    c.rect(4, 26, 28, 22, stone, 2);        // nave
    c.triangle(4, 26, 18, 10, 32, 26, stone, dark); // tejado a dos aguas
    c.rect(14, 4, 8, 24, stone, 2);         // torre/campanario
    c.rect(16, 0, 4, 6, dark, 1);           // base de la cruz
    c.rect(13, 2, 10, 2, dark, 1);          // brazos de la cruz
  },

  // CASA: mejora de !casas (ver rules/housing.js) — aparece junto a la
  // capital, igual mecanismo de anillo que estatua/museo/iglesia, SIN
  // teñir (casita neutra de piedra/madera, no lleva color de facción).
  // Cabaña simple para distinguirse de un vistazo de la iglesia (sin
  // torre/campanario ni cruz): paredes + tejado a dos aguas + puerta +
  // ventana. 34x36.
  casa: (c) => {
    const wall = [214, 194, 150];
    const roof = [150, 70, 50];
    const dark = [110, 60, 40];
    c.rect(3, 16, 28, 20, wall, 2);              // paredes
    c.triangle(1, 16, 17, 2, 33, 16, roof, dark); // tejado a dos aguas
    c.rect(13, 24, 8, 12, dark, 1);               // puerta
    c.rect(6, 19, 6, 6, [120, 170, 190], 1);      // ventana
  },

  // POLVAREDA DE COMBATE (Fase de Resolucion, ver docs/ACCIONES.md): dos
  // sprites que se intercalan quietos sobre el punto del combate — "al
  // poner e intercalar la aparicion de 1 y el otro parece que se mueve",
  // tal y como se pidio. dust-2 con los mismos puffs desplazados/mas
  // grandes para que el intercalado se note. 40x30.
  'dust-1': (c) => {
    const cloud = [196, 178, 150];
    c.rect(4, 14, 14, 10, cloud, 1);
    c.rect(14, 8, 16, 16, cloud, 1);
    c.rect(26, 16, 10, 8, cloud, 1);
  },
  'dust-2': (c) => {
    const cloud = [210, 192, 164];
    c.rect(2, 12, 16, 12, cloud, 1);
    c.rect(16, 6, 18, 18, cloud, 1);
    c.rect(30, 14, 10, 10, cloud, 1);
  },

  // CARROMATO (Fase de Resolucion, conquista/expansion, ver docs/ACCIONES.md):
  // avanza de la casilla de origen a la conquistada. Caja + lona a dos
  // aguas + dos ruedas. 50x36.
  wagon: (c) => {
    const wood = [110, 74, 40];
    const cover = [222, 210, 180];
    const dark = [80, 55, 30];
    const wheel = [60, 40, 20];
    c.rect(6, 16, 38, 14, wood, 2);
    c.triangle(6, 16, 25, 2, 44, 16, cover, dark);
    c.rect(10, 30, 8, 8, wheel, 0);
    c.rect(32, 30, 8, 8, wheel, 0);
  },

  // CASTILLO ESPECIAL (nivel 4 de industria, ver rules/industry.js seccion
  // 29): aparece UNA vez junto a la capital de la faccion que llega a ese
  // nivel — placeholder gris neutro, TEÑIDO del color de la faccion en
  // tiempo real igual que `capital` (drawTintedSprite), no un color fijo,
  // asi que un unico PNG sirve para todas. Mas ancho y bajo que la capital
  // (perfil "de fortaleza", no de torreon) para distinguirse de un vistazo.
  // Sin aldeanos alrededor (solo tropa-especial, ver mas abajo). 48x40.
  'castillo-especial': (c) => {
    const body = [214, 214, 214];
    const dark = [150, 150, 150];
    c.rect(2, 16, 44, 24, body, 2);       // muralla
    c.rect(4, 4, 12, 16, dark, 2);        // torreon izquierdo
    c.rect(32, 4, 12, 16, dark, 2);       // torreon derecho
    c.rect(18, 10, 12, 10, dark, 2);      // torreon central
    c.rect(22, 2, 4, 10, [110, 110, 110], 0); // asta de bandera central
  },

  // TROPA ESPECIAL (producida por el castillo especial de arriba, ver
  // rules/industry.js): 0.4 de ataque Y defensa fijos cada una, tope 10 por
  // faccion. Mismo tamaño que `troop`/`guardia` (14x22), tono dorado/morado
  // para leerse claramente como "de elite", distinto de las tropas normales
  // del jugador y de la guarnicion barbara.
  'tropa-especial': (c) => {
    c.rect(4, 2, 6, 6, [196, 168, 64], 1);
    c.rect(2, 8, 10, 13, [108, 72, 148], 1);
  },

  // MARAVILLAS (ver docs/ACCIONES.md sección 30, rules/wonders.js): 6 fijas
  // y nombradas, cada una con su propio placeholder para distinguirse de un
  // vistazo — SIN teñir de color de facción (a diferencia de capital/
  // castillo especial: una maravilla es un landmark del MAPA, no "de"
  // ninguna facción en particular, aunque quien posea su casilla se lleve el
  // bono). Todas ~40-44 de ancho, un pelín más grandes que barraca/campo-
  // arquería/caballeriza para leerse como "importante".
  'wonder-guggenheim': (c) => { // curvas plateadas apiladas, tejado en angulo
    const silver = [200, 200, 208];
    c.rect(2, 20, 40, 20, silver, 2, [110, 110, 120]);
    c.rect(10, 8, 24, 16, silver, 2, [110, 110, 120]);
    c.rect(16, 0, 12, 10, silver, 2, [110, 110, 120]);
  },
  'wonder-numancia': (c) => { // columnas de piedra en ruinas, alturas distintas
    const stone = [186, 176, 156];
    c.rect(2, 18, 8, 22, stone, 2, [100, 92, 76]);
    c.rect(14, 6, 8, 34, stone, 2, [100, 92, 76]);
    c.rect(26, 14, 8, 26, stone, 2, [100, 92, 76]);
    c.rect(0, 36, 40, 4, stone, 1, [100, 92, 76]);
  },
  'wonder-moncloa': (c) => { // edificio blanco con torreta central, rojo institucional
    const white = [232, 228, 220];
    c.rect(2, 16, 40, 24, white, 2, [140, 136, 128]);
    c.rect(16, 0, 12, 18, [176, 44, 44], 2, [90, 20, 20]);
  },
  'wonder-spacex': (c) => { // cohete blanco sobre plataforma gris
    const grey = [120, 120, 128];
    c.rect(4, 34, 36, 8, grey, 2, [60, 60, 66]);
    c.rect(16, 10, 12, 26, [230, 230, 234], 2, [130, 130, 136]);
    c.triangle(16, 10, 28, 10, 22, 0, [190, 40, 40], [130, 130, 136]);
  },
  'wonder-kebab': (c) => { // tienda pequeña, toldo amarillo
    const brick = [156, 90, 62];
    c.rect(4, 16, 32, 24, brick, 2, [80, 44, 28]);
    c.rect(0, 10, 40, 8, [214, 176, 48], 2, [120, 96, 20]);
  },
  'wonder-contrato': (c) => { // tablon de anuncios beige con un papel prendido
    const board = [176, 156, 118];
    c.rect(4, 4, 32, 36, board, 2, [96, 82, 56]);
    c.rect(10, 10, 20, 14, [238, 234, 220], 1, [180, 176, 160]);
  },

  // BOSSES (ver docs/ACCIONES.md sección 31, rules/bosses.js, `!boss`): 3
  // placeholders grandes fijos, "como la vaca y el que la persigue" pero
  // mucho más grandes — cada uno con su propia silueta de monstruo para
  // distinguirse de un vistazo (5-10 de ataque/defensa, sorteado por
  // instancia, se pinta encima de la cabeza). Sin variante de sentido
  // izquierda/derecha a propósito (mismo criterio que la vaca: no se pidió).
  ogro: (c) => { // humanoide grandote, verdoso, un solo garrote
    const skin = [108, 132, 76];
    c.rect(14, 4, 24, 14, skin, 2, [48, 60, 32]);   // cabeza
    c.rect(6, 16, 40, 30, skin, 2, [48, 60, 32]);   // torso ancho
    c.rect(2, 18, 8, 26, skin, 2, [48, 60, 32]);    // brazo izquierdo
    c.rect(46, 14, 9, 20, [120, 92, 60], 2, [56, 40, 24]); // garrote (brazo derecho)
    c.rect(10, 46, 12, 14, skin, 2, [48, 60, 32]);  // pierna izquierda
    c.rect(30, 46, 12, 14, skin, 2, [48, 60, 32]);  // pierna derecha
  },
  troll: (c) => { // encorvado, gris azulado, brazos largos hasta el suelo
    const skin = [110, 118, 128];
    c.rect(16, 8, 20, 16, skin, 2, [46, 50, 58]);   // cabeza pequeña
    c.rect(4, 20, 40, 28, skin, 2, [46, 50, 58]);   // torso encorvado, ancho
    c.rect(0, 22, 7, 38, skin, 2, [46, 50, 58]);    // brazo izquierdo, largo
    c.rect(41, 22, 7, 38, skin, 2, [46, 50, 58]);   // brazo derecho, largo
    c.rect(12, 48, 10, 12, skin, 2, [46, 50, 58]);  // pierna izquierda
    c.rect(26, 48, 10, 12, skin, 2, [46, 50, 58]);  // pierna derecha
  },
  behemot: (c) => { // cuadrupedo grande, oscuro, con cuernos
    const skin = [66, 52, 42];
    c.rect(4, 20, 44, 26, skin, 2, [28, 20, 16]);   // cuerpo grande
    c.rect(40, 8, 16, 18, skin, 2, [28, 20, 16]);   // cabeza adelantada
    c.triangle(40, 8, 44, 8, 38, 0, [200, 196, 188], [90, 86, 78]);  // cuerno izq.
    c.triangle(52, 8, 56, 8, 58, 0, [200, 196, 188], [90, 86, 78]);  // cuerno der.
    c.rect(8, 44, 8, 14, skin, 2, [28, 20, 16]);    // pata trasera
    c.rect(20, 44, 8, 14, skin, 2, [28, 20, 16]);   // pata
    c.rect(34, 44, 8, 14, skin, 2, [28, 20, 16]);   // pata
    c.rect(46, 44, 8, 14, skin, 2, [28, 20, 16]);   // pata delantera
  },

  // NUBES DEL CIELO (decorativo, ver docs/ACCIONES.md seccion 15): 3 tamaños
  // para que no se vean todas iguales al agruparse. Blancas y opacas aqui a
  // proposito — la transparencia final ("muy transparentes" segun se pidio)
  // se aplica en el codigo (CLOUD_ALPHA en mapRenderer.js), no horneada en el
  // PNG, para poder ajustarla sin regenerar nada.
  'cloud-1': (c) => { // pequeña, 46x20
    c.rect(8, 8, 30, 10, [255, 255, 255], 0);
    c.rect(16, 2, 16, 10, [255, 255, 255], 0);
    c.rect(0, 10, 14, 8, [255, 255, 255], 0);
  },
  'cloud-2': (c) => { // mediana, 68x28
    c.rect(10, 12, 48, 14, [255, 255, 255], 0);
    c.rect(22, 4, 26, 14, [255, 255, 255], 0);
    c.rect(0, 14, 20, 12, [255, 255, 255], 0);
    c.rect(50, 12, 18, 12, [255, 255, 255], 0);
  },
  'cloud-3': (c) => { // grande, 96x38
    c.rect(14, 16, 70, 18, [255, 255, 255], 0);
    c.rect(30, 4, 40, 18, [255, 255, 255], 0);
    c.rect(0, 18, 28, 16, [255, 255, 255], 0);
    c.rect(70, 16, 26, 16, [255, 255, 255], 0);
  },
};

const SIZES = {
  castle: [48, 48], port: [40, 40], village: [32, 32], dungeon: [50, 38], tree: [22, 40],
  'ship-small': [30, 22], 'ship-big': [46, 28], whale: [48, 18], kraken: [96, 96],
  cursor: [32, 32], skeleton: [64, 110], 'help-icon': [64, 64],
  'soldier-right': [24, 40], 'soldier-left': [24, 40],
  'knight-right': [28, 46], 'knight-left': [28, 46],
  logo: [320, 140],
  industry: [36, 28],
  'cow-right': [40, 24], 'cow-left': [40, 24], 'cow-follower': [18, 30],
  'easteregg-ovni': [50, 30], 'easteregg-yeti': [34, 50],
  troop: [14, 22], 'troop-archer': [14, 22], 'troop-cavalry': [16, 26],
  barbaro: [14, 22], 'barbaro-arquero': [14, 22], 'barbaro-caballero': [16, 26],
  orco: [24, 30], goblin: [11, 17], estatua: [34, 48], museo: [40, 40],
  barraca: [36, 28], 'campo-arqueria': [36, 28], caballeriza: [36, 28],
  torre: [20, 30], 'torre-obras': [20, 30],
  guardia: [14, 22], aldeano: [14, 22], capital: [44, 56],
  banner: [20, 44], iglesia: [36, 50], casa: [34, 36],
  'dust-1': [40, 30], 'dust-2': [40, 30], wagon: [50, 36],
  'castillo-especial': [48, 40], 'tropa-especial': [14, 22],
  'wonder-guggenheim': [44, 40], 'wonder-numancia': [40, 40], 'wonder-moncloa': [44, 40],
  'wonder-spacex': [40, 42], 'wonder-kebab': [40, 40], 'wonder-contrato': [40, 40],
  ogro: [56, 60], troll: [48, 60], behemot: [64, 58],
  'cloud-1': [46, 20], 'cloud-2': [68, 28], 'cloud-3': [96, 38],
};

if (require.main === module) {
  const outDir = path.join(__dirname, '..', 'public', 'sprites');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, draw] of Object.entries(SPRITES)) {
    const [w, h] = SIZES[name];
    const canvas = createCanvas(w, h);
    draw(canvas);
    fs.writeFileSync(path.join(outDir, `${name}.png`), canvas.toPNG());
  }
  console.log(`placeholders escritos en ${outDir}: ${Object.keys(SPRITES).join(', ')}`);
}

module.exports = { SPRITES, SIZES, createCanvas };
