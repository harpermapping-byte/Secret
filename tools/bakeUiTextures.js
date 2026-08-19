'use strict';

/**
 * Horneado de las texturas de interfaz "medieval" — madera para las barras
 * flotantes (arriba/abajo del mapa), chapa de latón para los botones, y
 * pergamino para los desplegables/popups. Script de DESARROLLO, se ejecuta a
 * mano UNA vez (`node tools/bakeUiTextures.js`) y el resultado (3 PNGs
 * pequeños) se guarda en `public/ui/` como asset estatico normal — mismo
 * criterio que `tools/bakeWorldTerrain.js` para `public/terrain/world.png`,
 * pero a una escala muchisimo mas pequeña (son texturas de UI que se repiten
 * por CSS, no un mundo entero), asi que el resultado pesa unos pocos KB en
 * vez de MB.
 *
 * `public/shared.css` es quien las usa (`background-image`/`border-image`,
 * ver comentarios ahi). Si se cambia el tamaño de cualquiera de estas tres
 * texturas hay que revisar ese CSS (background-size / border-image-slice
 * dependen de las dimensiones exactas generadas aqui).
 */

const fs = require('fs');
const path = require('path');
const { encodePNGRGBA, encodePNG } = require('./pngEncoder');
const { mulberry32 } = require('./terrainNoise');

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/** Interpola A..B en `n` pasos usando smoothstep entre anchors espaciados `step` px, para un perfil 1D organico sin depender de una libreria de ruido 2D. */
function jaggedProfile(width, seed, { step = 10, amplitude = 6, base = 0 } = {}) {
  const rand = mulberry32(seed);
  const anchorCount = Math.ceil(width / step) + 2;
  const anchors = new Float32Array(anchorCount);
  for (let i = 0; i < anchorCount; i++) anchors[i] = base + (rand() - 0.5) * 2 * amplitude;

  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const fx = x / step;
    const i0 = Math.floor(fx);
    const t = fx - i0;
    const s = t * t * (3 - 2 * t);
    out[x] = anchors[i0] * (1 - s) + anchors[i0 + 1] * s;
  }
  return out;
}

// ===========================================================================
// 1. Barra de madera (public/ui/wood-bar.png) — tira horizontal tileable
//    (repeat-x), con el borde de ABAJO irregular (huecos transparentes) y el
//    de ARRIBA recto. La barra de abajo del mapa reutiliza este MISMO PNG
//    volteado verticalmente por CSS (transform:scaleY(-1)) en vez de hornear
//    una segunda textura — con el borde recto pegado al borde real de la
//    pantalla en los dos casos, el irregular siempre queda mirando al mapa.
// ===========================================================================
// Tira ANCHA a proposito (6 veces mas ancha que alta): la textura se repite
// horizontalmente por CSS, y con una tira corta el ojo pilla enseguida el
// patron repetido — sobre todo en el borde irregular, que con pocos px de
// ciclo se lee como un serrucho regular en vez de como madera gastada.
const WOOD_W = 384;
const WOOD_H = 64;
const WOOD_JAGGED_ZONE = 7; // px maximos que puede "comerse" el borde irregular

function bakeWoodBar() {
  const rgba = new Uint8Array(WOOD_W * WOOD_H * 4);
  const grainRand = mulberry32(4001);

  // Vetas horizontales: unas pocas franjas de 1-2px un poco mas oscuras/claras
  // que el fondo, a alturas aleatorias — asi se lee como grano de madera
  // corriendo en horizontal (tablones de izquierda a derecha), no como ruido.
  const streaks = [];
  for (let i = 0; i < 14; i++) {
    streaks.push({ y: 3 + Math.floor(grainRand() * (WOOD_H - 6)), delta: (grainRand() - 0.5) * 30, h: grainRand() < 0.3 ? 2 : 1 });
  }

  // Costuras verticales entre tablones distintos (a proposito NO
  // perfectamente regulares — un tablon real no mide siempre lo mismo). Cada
  // costura es una linea oscura + un pixel de brillo al lado (bisel), para
  // que se note el desnivel entre un tablon y el siguiente en vez de verse un
  // patron impreso plano.
  const seamXs = [];
  {
    const seamRand = mulberry32(4002);
    let x = 24 + Math.floor(seamRand() * 30);
    while (x < WOOD_W - 12) {
      seamXs.push(x);
      x += 58 + Math.floor(seamRand() * 46);
    }
  }

  // Perfil irregular del borde inferior. DOS octavas: una onda larga y suave
  // (el alabeo general del canto de la tabla) mas una micro-rugosidad muy
  // pequeña encima. La amplitud es deliberadamente baja — el objetivo es que
  // se lea "madera gastada", no un serrucho: con amplitudes altas y ciclo
  // corto el borde se convierte en dientes de sierra evidentes.
  const edgeLong = jaggedProfile(WOOD_W, 4003, { step: 34, amplitude: 2.0, base: 3.4 });
  const edgeFine = jaggedProfile(WOOD_W, 4013, { step: 6, amplitude: 0.75, base: 0 });
  const edgeProfile = new Float32Array(WOOD_W);
  for (let x = 0; x < WOOD_W; x++) {
    edgeProfile[x] = Math.max(0.6, Math.min(WOOD_JAGGED_ZONE, edgeLong[x] + edgeFine[x]));
  }
  const noiseRand = mulberry32(4004);

  for (let y = 0; y < WOOD_H; y++) {
    for (let x = 0; x < WOOD_W; x++) {
      const i = (y * WOOD_W + x) * 4;

      // Tono base por tablon: cada tablon tira un poco distinto (no dos tonos
      // alternos fijos, que se leen como ajedrez), dentro de una gama de
      // castaño oscuro de madera vieja.
      let plankIndex = 0;
      for (const sx of seamXs) if (x >= sx) plankIndex++;
      const plankShade = ((Math.sin(plankIndex * 12.9898) * 43758.5453) % 1 + 1) % 1; // hash estable por tablon
      const base = [104 + plankShade * 26, 66 + plankShade * 18, 34 + plankShade * 12];

      let r = base[0], g = base[1], b = base[2];

      // Grano fino pixel a pixel (variacion suave, look "pixel art", no foto).
      const grain = (noiseRand() - 0.5) * 10;
      r += grain; g += grain * 0.85; b += grain * 0.6;

      // Vetas horizontales.
      for (const s of streaks) {
        if (y >= s.y && y < s.y + s.h) { r += s.delta; g += s.delta * 0.8; b += s.delta * 0.5; }
      }

      // Sombra superior / brillo justo debajo (simula la tabla superior
      // proyectando una sombra fina sobre la de abajo, borde superior recto).
      if (y < 2) { r *= 0.72; g *= 0.72; b *= 0.72; }
      else if (y < 4) { r += 14; g += 11; b += 6; }

      r = clamp255(r); g = clamp255(g); b = clamp255(b);

      // Costuras verticales: linea oscura de 1px + resalte de 1px al lado.
      let isSeam = false, isSeamHighlight = false;
      for (const sx of seamXs) {
        if (x === sx) isSeam = true;
        if (x === sx + 1) isSeamHighlight = true;
      }
      if (isSeam) { r *= 0.45; g *= 0.45; b *= 0.45; }
      if (isSeamHighlight) { r = clamp255(r + 24); g = clamp255(g + 18); b = clamp255(b + 10); }

      // Borde inferior irregular: por debajo del perfil de este tablon, alfa 0.
      const cutoff = WOOD_H - edgeProfile[x];
      let alpha = 255;
      if (y > cutoff) alpha = 0;
      else if (y > cutoff - 1.2) alpha = Math.round(255 * (cutoff - y + 0.2)); // 1px de antialiasing manual en el borde

      rgba[i] = clamp255(r);
      rgba[i + 1] = clamp255(g);
      rgba[i + 2] = clamp255(b);
      rgba[i + 3] = clamp255(alpha);
    }
  }

  return encodePNGRGBA(WOOD_W, WOOD_H, rgba);
}

// ===========================================================================
// 2. Chapa de laton (public/ui/metal-plate.png) — placa pequeña con bisel y
//    4 remaches, pensada para `border-image` (9-slice): las esquinas (con
//    remache) se quedan fijas, los bordes/centro se estiran, asi sirve igual
//    para un boton estrecho ("+") que para uno largo ("Clasificacion"). Ver
//    METAL_SLICE en shared.css — tiene que coincidir con METAL_INSET de aqui.
// ===========================================================================
const METAL_SIZE = 32;
const METAL_INSET = 3; // margen transparente para que se vea la madera alrededor de la chapa
const METAL_SLICE = 11; // debe cubrir el remache de la esquina, ver dibujo de rivets mas abajo

function bakeMetalPlate() {
  const rgba = new Uint8Array(METAL_SIZE * METAL_SIZE * 4);
  const noiseRand = mulberry32(5001);

  const rivets = [
    [METAL_INSET + 5, METAL_INSET + 5],
    [METAL_SIZE - METAL_INSET - 6, METAL_INSET + 5],
    [METAL_INSET + 5, METAL_SIZE - METAL_INSET - 6],
    [METAL_SIZE - METAL_INSET - 6, METAL_SIZE - METAL_INSET - 6],
  ];

  for (let y = 0; y < METAL_SIZE; y++) {
    for (let x = 0; x < METAL_SIZE; x++) {
      const i = (y * METAL_SIZE + x) * 4;

      // Silueta: rectangulo con esquinas cortadas a 45 grados (chapa
      // "recortada a tijera", no un cuadrado perfecto de fabrica).
      const dCorner = Math.min(x - METAL_INSET, y - METAL_INSET, METAL_SIZE - 1 - METAL_INSET - x, METAL_SIZE - 1 - METAL_INSET - y);
      const inside = dCorner >= 0 - 0.01 && cornerCut(x, y);
      if (!inside) { rgba[i + 3] = 0; continue; }

      // Bisel: borde exterior oscuro (sombra), un anillo mas claro justo
      // dentro (arista que recibe luz desde arriba-izquierda), relleno medio.
      const edge = Math.min(x - METAL_INSET, y - METAL_INSET, METAL_SIZE - 1 - METAL_INSET - x, METAL_SIZE - 1 - METAL_INSET - y);
      let r, g, b;
      if (edge < 1) { r = 74; g = 50; b = 14; } // sombra de borde
      else if (edge < 2 && (x < METAL_SIZE / 2 || y < METAL_SIZE / 2)) { r = 246; g = 212; b = 138; } // arista iluminada
      else if (edge < 2) { r = 104; g = 70; b = 22; } // arista en sombra
      else { r = 190; g = 138; b = 52; } // laton liso

      // Degradado interior: la chapa recibe la luz desde arriba, asi que la
      // mitad de abajo va un punto mas apagada — sin esto el laton se ve
      // plano, como un rectangulo de color y no como metal.
      const lightFall = 1 - (y / METAL_SIZE) * 0.22;
      r *= lightFall; g *= lightFall; b *= lightFall;

      // Textura "cepillada": lineas finas horizontales muy sutiles.
      if ((y & 1) === 0) { r -= 6; g -= 5; b -= 3; }
      const grain = (noiseRand() - 0.5) * 8;
      r += grain; g += grain * 0.9; b += grain * 0.5;

      rgba[i] = clamp255(r);
      rgba[i + 1] = clamp255(g);
      rgba[i + 2] = clamp255(b);
      rgba[i + 3] = 255;
    }
  }

  // Remaches: circulo oscuro + punto de brillo, encima del relleno ya pintado.
  for (const [cx, cy] of rivets) {
    for (let y = -2; y <= 2; y++) {
      for (let x = -2; x <= 2; x++) {
        const d2 = x * x + y * y;
        if (d2 > 6) continue;
        const px = cx + x, py = cy + y;
        if (px < 0 || px >= METAL_SIZE || py < 0 || py >= METAL_SIZE) continue;
        const i = (py * METAL_SIZE + px) * 4;
        if (rgba[i + 3] === 0) continue; // fuera de la silueta de la chapa
        const isHighlight = x === -1 && y === -1;
        const [r, g, b] = isHighlight ? [252, 226, 168] : d2 <= 3 ? [70, 48, 16] : [104, 74, 28];
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    }
  }

  return encodePNGRGBA(METAL_SIZE, METAL_SIZE, rgba);

  function cornerCut(x, y) {
    const cut = 3;
    if (x < METAL_INSET + cut && y < METAL_INSET + cut && (x - METAL_INSET) + (y - METAL_INSET) < cut) return false;
    if (x > METAL_SIZE - 1 - METAL_INSET - cut && y < METAL_INSET + cut && (METAL_SIZE - 1 - METAL_INSET - x) + (y - METAL_INSET) < cut) return false;
    if (x < METAL_INSET + cut && y > METAL_SIZE - 1 - METAL_INSET - cut && (x - METAL_INSET) + (METAL_SIZE - 1 - METAL_INSET - y) < cut) return false;
    if (x > METAL_SIZE - 1 - METAL_INSET - cut && y > METAL_SIZE - 1 - METAL_INSET - cut && (METAL_SIZE - 1 - METAL_INSET - x) + (METAL_SIZE - 1 - METAL_INSET - y) < cut) return false;
    if (x < METAL_INSET || y < METAL_INSET || x > METAL_SIZE - 1 - METAL_INSET || y > METAL_SIZE - 1 - METAL_INSET) return false;
    return true;
  }
}

// ===========================================================================
// 3. Pergamino (public/ui/parchment.png) — tileable (repeat), papel envejecido
//    en blanco (sin texto, ver docs/GDD): manchas suaves + motas, para que
//    los popups/paneles se lean como una hoja antigua sin tapar el texto que
//    va encima. Sin `image-rendering:pixelated` en CSS (a diferencia de la
//    madera/chapa) — el papel se ve mejor suavizado.
// ===========================================================================
const PARCH_SIZE = 128;

function bakeParchment() {
  const rgb = new Uint8Array(PARCH_SIZE * PARCH_SIZE * 3);
  // Papel algo mas tostado que un beige claro: sobre un fondo casi blanco el
  // pergamino se lee como "hoja de impresora", no como documento antiguo.
  const base = [219, 201, 163];
  for (let i = 0; i < PARCH_SIZE * PARCH_SIZE; i++) {
    rgb[i * 3] = base[0]; rgb[i * 3 + 1] = base[1]; rgb[i * 3 + 2] = base[2];
  }

  // Manchas ("foxing" de papel viejo) — cada mancha se dibuja tambien
  // desplazada +-PARCH_SIZE en x/y para que el tile siga siendo seamless
  // (una mancha que sale por un borde reaparece por el opuesto). Muchas y
  // pequeñas, no pocas y enormes: unas pocas manchas grandes y muy difusas
  // parecen una foto desenfocada, no fibra de papel.
  const blotchRand = mulberry32(6001);
  const blotchCount = 90;
  for (let n = 0; n < blotchCount; n++) {
    const cx = blotchRand() * PARCH_SIZE;
    const cy = blotchRand() * PARCH_SIZE;
    const radius = 3 + blotchRand() * 11;
    const strength = 5 + blotchRand() * 11;
    const darker = blotchRand() < 0.7;
    for (const ox of [-PARCH_SIZE, 0, PARCH_SIZE]) {
      for (const oy of [-PARCH_SIZE, 0, PARCH_SIZE]) {
        blendBlotch(rgb, cx + ox, cy + oy, radius, strength, darker);
      }
    }
  }

  // Motas finas (grano de fibra de papel) — pixel a pixel, sutil.
  const speckleRand = mulberry32(6002);
  for (let i = 0; i < PARCH_SIZE * PARCH_SIZE; i++) {
    if (speckleRand() < 0.06) {
      const d = (speckleRand() - 0.5) * 16;
      rgb[i * 3] = clamp255(rgb[i * 3] + d);
      rgb[i * 3 + 1] = clamp255(rgb[i * 3 + 1] + d * 0.9);
      rgb[i * 3 + 2] = clamp255(rgb[i * 3 + 2] + d * 0.7);
    }
  }

  return encodePNG(PARCH_SIZE, PARCH_SIZE, rgb);

  function blendBlotch(buf, cx, cy, radius, strength, darker) {
    const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(PARCH_SIZE - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(PARCH_SIZE - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d > 1) continue;
        const falloff = 1 - d * d; // mancha suave, mas fuerte en el centro
        const delta = (darker ? -1 : 1) * strength * falloff;
        const i = (y * PARCH_SIZE + x) * 3;
        buf[i] = clamp255(buf[i] + delta);
        buf[i + 1] = clamp255(buf[i + 1] + delta * 0.9);
        buf[i + 2] = clamp255(buf[i + 2] + delta * 0.65);
      }
    }
  }
}

// ===========================================================================
if (require.main === module) {
  const outDir = path.join(__dirname, '..', 'public', 'ui');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'wood-bar.png'), bakeWoodBar());
  fs.writeFileSync(path.join(outDir, 'metal-plate.png'), bakeMetalPlate());
  fs.writeFileSync(path.join(outDir, 'parchment.png'), bakeParchment());
  console.log(`texturas de UI escritas en ${outDir}`);
}

module.exports = { bakeWoodBar, bakeMetalPlate, bakeParchment, WOOD_W, WOOD_H, WOOD_JAGGED_ZONE, METAL_SIZE, METAL_INSET, METAL_SLICE, PARCH_SIZE };
