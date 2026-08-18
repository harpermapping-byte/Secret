# Documento de diseño — Juego de facciones para Condejorge (v1, borrador)

> Inspirado en el patrón técnico de streamer-wars.com (WebSocket + servidor autoritativo + bot de chat + panel de admin), pero con reglas y temática propias, construido de cero. Este documento recoge todo lo decidido hasta ahora en la fase de diseño, antes de entrar en la parte técnica.

---

## 1. Resumen del concepto

Juego de conquista de territorio por facciones (estilo Risk / Hearts of Iron / Civilization simplificado), pensado para jugarse en directo con el chat de Twitch como "tropas". El admin (Condejorge u otro operador) configura y controla la partida desde un panel; los espectadores se unen a una facción y actúan escribiendo comandos sencillos en el chat. Todo se visualiza en tiempo real en una web tipo tablero, con animaciones, mapa y personajes representando a cada usuario.

Puede jugarse con **varios chats de Twitch a la vez** (por ejemplo Condejorge + un streamer invitado), fusionados por un bot que evita que un mismo usuario cuente dos veces.

**Alcance de v1:** una única partida activa a la vez (la lanza el admin cuando quiera, con su contraseña). Sin persistencia: al terminar la partida, todo el estado vuelve a cero, no se guarda nada de nadie. Esto es una decisión de v1, no una limitación técnica — el modelo de jugador (identificado siempre por su ID de Twitch) se diseñará de forma que más adelante se pueda añadir progresión entre partidas (XP, personalización de personaje/skins, etc.) sin tener que rehacer el motor del juego.

**Qué entra en la v1 (primera versión jugable) y qué se deja para más adelante, sobre la misma base:**

| Incluido en v1 | Se añade en una versión futura |
|---|---|
| Fase 0 (config admin), Reclutamiento, las 3 fases de ronda (Acción/Desarrollo-Combate/Resumen) | Eventos aleatorios (Meteorito, Refuerzos globales, Niebla de guerra, Motín) |
| Los 5 comandos de acción + `!alianza` | Maravillas (casillas especiales con bonus de industria) |
| Combate simultáneo con azar y prioridad de bajas | Persistencia entre partidas / XP / personalización de personaje |
| Industria y las 4 mejoras automáticas (Tanque, Bombardeo, 2ª mejora de unidad, Operación especial) | Variedad de tipos de unidad más allá de Tanque (Artillería, Avión, Ingeniero) |
| Territorio neutral y `!expansion` | Otros modos de juego (por tiempo, por turnos) |
| Habilidad especial por facción (catálogo de 4) | Dirección de expansión elegible por el chat |
| Eliminación y pantalla de victoria | — |
| Placeholders gráficos (sin arte final) | Arte/estética definitiva |

---

## 2. Flujo general de una partida

0. **Fase 0 — Configuración** — el admin monta la partida entera en su panel. Nadie puede unirse ni hacer nada todavía; los bots de Twitch no están escuchando y la web solo muestra una pantalla de espera/placeholder.
1. **Fase de Reclutamiento** — se activa en el instante en que el admin pulsa "Iniciar partida". A partir de aquí, los controles de configuración desaparecen del panel. Ocurre **una única vez**, al principio, y no se repite.
2. **Bucle de rondas** — se repite hasta que solo queda una facción con territorio:
   - Fase de Acción (con timer)
   - Fase de Desarrollo / Combate (sin timer, dura lo que tarden las animaciones)
   - Fase de Resumen (sin timer fijo, bloques de info de 10-15s cada uno)
3. **Fin de partida** — pantalla de victoria con estadísticas.

---

## 3. Fase 0 — Configuración (panel de admin, antes de iniciar)

El admin define, antes de pulsar "Iniciar partida":

- Modo de juego (v1: **Eliminación total**; roadmap futuro: por tiempo, por turnos).
- Número de facciones.
- Por cada facción: nombre libre, color, alias numérico automático (`!faccion1`, `!faccion2`...), y si tiene habilidad especial habilitada (y cuál, del catálogo).
- Lista de canales de Twitch a escuchar (el propio Condejorge y streamers invitados).
- Plantilla de mapa: tamaño (ej. 20 / 35 / 50 casillas) y variante concreta dentro de ese tamaño.
- Modo de reparto inicial: **reparto total** (todo el mapa asignado desde el minuto uno, sin terreno gris, `!expansion` no tiene efecto) o **zonas pequeñas + territorio neutral** (recomendado, da una fase de expansión inicial y activa `!expansion`).
- Si las **alianzas** están activadas o no para esta partida (si no lo están, el comando `!alianza` no existe esa partida).
- % de usuarios activos necesario para conquistar una casilla neutral (bárbaros) — por defecto 25%.
- % de usuarios activos necesario para activar una alianza — por defecto 50%.
- % de usuarios activos necesario para activar la habilidad especial de una facción — por defecto 75%.
- Duración de la Fase de Reclutamiento — por defecto 3 min.
- Duración de la Fase de Acción — por defecto 1 min.

Una vez pulsado "Iniciar partida", **nada de esto se puede volver a tocar**: no hay reconfiguración a mitad de partida. Los únicos controles que le quedan al admin durante el juego están en la sección 8.

---

## 4. Comandos de chat (lo único que puede hacer el espectador)

| Comando | Cuándo | Qué hace |
|---|---|---|
| `!faccion1`, `!faccion2`... | Solo durante la Fase de Reclutamiento | Te une a esa facción. Puedes cambiar de facción mientras dure el reclutamiento (cuenta tu último comando); al cerrarse esa fase, el roster queda fijo para el resto de la partida. |
| `!industria` | Fase de Acción | Aportas a la producción de recursos de tu facción. |
| `!ataque <nº facción>` | Fase de Acción | P.ej. `!ataque 2`. Mismo formato que `!alianza`: solo el número de la facción objetivo. Atacas a esa facción; el sistema dirige el golpe automáticamente al punto fronterizo más débil. Inválido si hay una alianza activa esa ronda entre tu facción y la atacada. |
| `!defender` | Fase de Acción | Refuerzas la defensa de tu facción esa ronda. |
| `!expansion` | Fase de Acción | Intentas conquistar territorio neutral (bárbaros) fronterizo. Sin efecto si la partida se configuró con reparto total (sin terreno gris). |
| `!especial` | Fase de Acción | Vota para activar la habilidad especial de tu facción (solo una vez por partida en total). |
| `!alianza <nº facción>` | Fase de Acción, solo si el admin activó alianzas en esta partida | Vota por un alto el fuego de una ronda con esa facción. |

Solo cuenta el **último comando** que escribas antes de que cierre la Fase de Acción — puedes cambiar de opinión mientras dure.

No hay comandos por botón en la web para el público: los botones/paneles interactivos son solo para el admin. El público solo interactúa por el chat de Twitch.

---

## 5. Las fases de una partida

- **Fase 0 — Configuración** (una sola vez, antes de iniciar) — el admin lo monta todo; nada es visible ni funcional para el público.
- **Fase de Reclutamiento** (una sola vez, al iniciar la partida) — timer configurable, 3 min por defecto. Solo funcionan los comandos `!faccion1`, `!faccion2`... Se puede cambiar de facción libremente mientras dure. Al cerrarse, el roster queda fijo y no se repite esta fase en toda la partida.
- **Fase de Acción** (se repite cada ronda) — timer configurable, 1 min por defecto. Cada usuario **vivo** vota una única acción entre `!industria`, `!ataque <facción>`, `!defender`, `!expansion`, `!especial`, `!alianza <nº>`. Se muestran en pantalla en tiempo real las amenazas entrantes por territorio.
- **Fase de Desarrollo / Combate** (se repite cada ronda) — **sin timer fijo**, dura lo que tarden las animaciones necesarias. Primero se anima el movimiento de cada facción según lo votado (industria generándose en su territorio, tropas moviéndose a posición defensiva mostrando el nombre de cada usuario que defendió, tropas marchando hacia la frontera de quienes atacaron), y al terminar ese movimiento se dispara la animación de Combate en las fronteras con sus resultados.
- **Fase de Resumen** (se repite cada ronda) — sin timer fijo global; cada bloque de información (quién atacó a quién, industria ganada por facción, bajas, conquistas, habilidades activadas...) se queda en pantalla unos 10-15s antes de pasar al siguiente. Al terminar todos los bloques, se vuelve automáticamente a la Fase de Acción.

---

## 6. Mecánicas del núcleo

### Mapa y plantillas
Varias plantillas prediseñadas por tamaño (varias variantes de 20 casillas, varias de 50, etc.), cada una con su cuadrícula de adyacencias ya definida. El admin elige tamaño y variante en la Fase 0.

### Territorio neutral ("bárbaros")
En el modo de zonas pequeñas, las casillas sin dueño tienen una guarnición fija (no se defiende con chat). Se conquistan cuando el % configurado de usuarios activos de una facción vota `!expansion` en la misma ronda; el sistema elige automáticamente la casilla neutral fronteriza a conquistar.

### Industria y las 4 mejoras (progresión fija)
Cada `!industria` único suma recursos a la facción (más un pequeño extra pasivo por territorio controlado). Al alcanzar 4 umbrales sucesivos (valores exactos por definir), se desbloquean, en este orden y de forma automática y permanente:

1. **Mejora de unidad** — 1 usuario al azar de la facción pasa de soldado a Tanque; mejoran sus stats de ataque y defensa.
2. **Bombardeo** — se dispara **una sola vez**, en el instante en que se desbloquea: bombardea automáticamente a la facción que atacó a esta en la ronda anterior, causando daño y bajas (prioridad de bajas: primero quien no puso comando en esa ronda anterior). Si nadie atacó a esta facción la ronda anterior, la mejora se desbloquea pero no tiene a quién golpear esa vez.
3. **Mejora de 2 unidades** — 2 usuarios más pasan a Tanque, igual que la Mejora 1, pero la selección prioriza a quien más ha participado en rondas anteriores de la partida (con preferencia por quienes usaron `!ataque`/`!defender` sobre solo `!industria`); si no hay historial (se desbloquea en la primera ronda), se elige al azar entre todos los de la facción.
4. **Operación especial** — se dispara **una sola vez**, en el instante en que se desbloquea: una animación de comando especial golpea un objetivo aleatorio entre las facciones que tengan frontera con esta, causando daño, **incluso si hay una alianza activa** con esa facción (esta mejora ignora alianzas).

### Combate
Cuando una facción recibe ataques de una o varias facciones en la misma ronda, **todos se resuelven juntos, no en secuencia** (evita que "quien ataca primero" se coma toda la defensa). La defensa reduce el ataque entrante; lo que sobra causa bajas reales, repartidas en este orden de prioridad: **inactivos → usuarios en `!industria` → atacantes propios → defensores** (los defensores son los últimos en caer, ya que su rol es bloquear). Hay un componente de azar en el daño (rango a afinar, ejemplo de partida 0.5-1.5 por unidad) para que no sea matemática pura. El territorio conquistado se asigna automáticamente al punto fronterizo más débil implicado en el combate ganador. Visualmente, los atacantes se mueven hacia la casilla de destino y los defensores se reparten entre los distintos frentes activos de su facción.

### Maravillas
Casillas fijas y concretas de cada plantilla de mapa con un monumento real (ilustración original, no fotos con derechos), que dan un extra de industria por ronda a quien las controle. Lista corta reutilizable (6-8 maravillas) repartida de forma distinta según la plantilla.

### Habilidad especial (catálogo v1)
Configurable sí/no por facción en la Fase 0. Activable una única vez por partida cuando el % configurado de votantes activos escribe `!especial` en la misma ronda:
- **Refuerzo** — revive a los últimos caídos de la facción (su ficha ya existía, solo cambia su estado a "vivo", no hace falta volver a unirse).
- **Escudo** — reduce el próximo ataque recibido esa ronda.
- **Frenesí** — aumenta el próximo ataque lanzado esa ronda.
- **Sabotaje** — reduce la industria del objetivo elegido la siguiente ronda.

Si el intento de activación **no llega** al % necesario, todos los que votaron `!especial` ese turno cuentan como neutrales/inactivos en la Fase de Desarrollo de esa ronda (no defienden, no atacan, no producen, y son los primeros aniquilables si hay combate) — la misma penalización que un intento de alianza fallido.

### Alianzas (unilaterales, con coste)
Configurable sí/no en la Fase 0. Si están activas, cualquier facción puede intentar imponer un alto el fuego: si el % configurado (por defecto 50%) de votantes activos de la Facción 1 escribe `!alianza 2` en una ronda, se activa un alto el fuego **obligatorio para ambas** esa ronda (`!ataque 1` y `!ataque 2` entre ellas quedan inválidos), **aunque la Facción 2 no haya votado nada** — el coste lo paga solo quien la propone, al sacrificar la mitad de su gente en votar alianza en vez de producir o defender. Dos casos especiales:
- Si el intento de alianza **no llega** al % necesario, todos los que votaron `!alianza` ese turno cuentan como neutrales/inactivos esa ronda (no defienden, no atacan, no producen).
- Si alguien de la Facción 2 ya había votado `!ataque 1` esa misma ronda pero la alianza de la Facción 1 sí se activa, ese ataque queda anulado y esos usuarios de la Facción 2 también cuentan como neutrales/inactivos esa ronda (sin redirigir su ataque a otro sitio).

### Eliminación
Al perder todo su territorio, la facción queda fuera de la partida; su territorio pasa al color del conquistador. No hace falta ninguna regla adicional de "decaimiento" para facciones inactivas: al no defenderse ni expandirse, quedan naturalmente vulnerables y son conquistadas por sus vecinos activos.

---

## 7. Eventos aleatorios

**No se implementan en la primera versión jugable.** Se dejan diseñados aquí para una fase posterior, y el sistema se construirá pensando en poder añadirlos sin rehacer el núcleo del juego. Catálogo inicial corto (ampliable), pensado para dispararse **automáticamente** cada cierto número de rondas (rango aleatorio, ej. cada 4-6), sin botón de disparo manual del admin (ver sección 8):

- **Meteorito** — reduce la guarnición de un territorio al azar.
- **Refuerzos globales** — todas las facciones reciben un pequeño empujón de industria.
- **Niebla de guerra** — durante una ronda no se muestran las amenazas entrantes en pantalla, más tensión.
- **Motín** — una facción al azar pierde temporalmente el acceso a su habilidad especial esa ronda.

---

## 8. Controles del admin durante la partida (en vivo)

Una vez iniciada la partida, el panel de configuración desaparece. Los únicos controles disponibles mientras la partida está en marcha son:

- **Pausar / reanudar** la ronda actual (congela el timer, no avanza nada).
- **Pasar ronda manualmente** (forzar el avance a la siguiente fase sin esperar al timer).
- **Terminar partida** (finalizarla en cualquier momento, por ejemplo por un problema técnico).

No hay expulsión de usuarios, reasignación de facción, disparo manual de eventos ni ajuste de los % de umbral en vivo — todo eso queda fijado en la Fase 0 y no se puede tocar después.

---

## 9. Qué ve un espectador / jugador (paso a paso)

1. Antes de que el admin inicie la partida (Fase 0): solo ve una pantalla de espera/placeholder en la web. Ningún comando funciona todavía.
2. El admin pulsa "Iniciar partida": arranca la Fase de Reclutamiento (3 min por defecto). Ahora sí ve el mapa (con las facciones y, si aplica, territorio neutral en gris).
3. Escribe `!faccion1` (o el número que quiera) en el chat de Twitch de cualquiera de los canales conectados al juego. Aparece su placeholder en el mapa, con su nombre encima, dentro de la zona de su facción. Puede cambiar de facción escribiendo otro número mientras dure el reclutamiento.
4. Cada vez que escribe algo en el chat, su mensaje aparece unos segundos como un bocadillo de texto encima de su placeholder.
5. Al cerrarse el reclutamiento, el roster queda fijo (esta fase no se repite) y empieza la primera Fase de Acción: ve el timer y las amenazas entrantes sobre los territorios, y escribe uno de los comandos de acción (puede cambiarlo mientras dure el timer).
6. Al cerrar la Fase de Acción, ve la Fase de Desarrollo/Combate: primero el movimiento de tropas de cada facción según lo votado (con nombres encima de cada placeholder), luego la animación de Combate en las fronteras. Después, la Fase de Resumen muestra en bloques (10-15s cada uno) qué pasó: ataques, industria, bajas, conquistas, especiales, mejoras desbloqueadas.
7. El ciclo Acción → Desarrollo/Combate → Resumen se repite ronda tras ronda hasta que su facción gana, es eliminada, o él mismo cae en combate (podría revivir si su facción usa la habilidad de Refuerzo).
8. Al final de la partida ve la pantalla de victoria con la facción ganadora y estadísticas.

## 10. Qué ve/hace el admin (paso a paso)

1. Entra con contraseña al panel de admin. Está en Fase 0: configura la partida entera (modo, facciones, canales de Twitch, plantilla de mapa, modo de reparto, alianzas sí/no, todos los % y timers).
2. Pulsa "Iniciar partida": en ese momento se activan los bots de los canales configurados, el panel de configuración desaparece, y arranca la Fase de Reclutamiento. Antes de esto no había nada visible ni funcional en la web.
3. Ve el mapa mientras la gente se une en vivo durante el reclutamiento.
4. A partir de ahí el juego corre solo por rondas (Acción → Desarrollo/Combate → Resumen). El admin solo conserva los tres controles de la sección 8: pausar/reanudar, pasar ronda manualmente, terminar partida.
5. Al terminar, puede lanzar una partida nueva repitiendo el proceso desde la Fase 0.

---

## 11. Pendiente / a definir más adelante

- Números exactos: umbrales de industria para cada una de las 4 mejoras, rango de azar en combate, valores concretos de cada habilidad especial y bonus de maravillas.
- Si más adelante se quiere variedad de unidades (Artillería, Avión/Explorador con ataque no fronterizo, Ingeniero con expansión más barata) en vez de que las mejoras 1 y 3 sean siempre Tanque.
- Lista final de maravillas y su reparto por plantilla de mapa.
- Estética visual definitiva (estilo de mapa, unidades, paleta, tipografía).
- Modos de juego futuros: por tiempo, por turnos.
- Dirección de expansión elegible por el chat (de momento automática).

