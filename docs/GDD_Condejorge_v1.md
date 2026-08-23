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
| `!industria` | Fase de Acción | Levantas una industria en un terreno al azar de tu facción: +0.5 de producción por ronda, para siempre (y se pierde si te conquistan ese terreno). |
| `!ataque <nº facción>` | Fase de Acción | P.ej. `!ataque 2`. Mismo formato que `!alianza`: solo el número de la facción objetivo. Atacas a esa facción; el sistema dirige el golpe automáticamente al punto fronterizo más débil. Inválido si hay una alianza activa esa ronda entre tu facción y la atacada, **o si tu facción no tiene ninguna casilla que toque a la atacada** (sin frontera compartida no se puede atacar). "Tocar" ya no es solo tierra con tierra: dos costas a menos de ~400km de mar también cuentan como frontera (así una facción en una isla o continente aislado, como Australia en el mapa mundial, no se queda sin poder jugar) — más allá de ese alcance, sigue haciendo falta llegar por `!expansion`. |
| `!defender` | Fase de Acción | Refuerzas la defensa de tu facción esa ronda. |
| `!expansion` | Fase de Acción | Ocupáis territorio neutral (bárbaros) fronterizo: hacen falta 2 votantes por cada casilla nueva (1 o 2 votos = 1 casilla, 4 = 2, 6 = 3). Sin efecto si la partida se configuró con reparto total (sin terreno gris). |
| `!especial` | Fase de Acción | Vota para activar la habilidad especial de tu facción (solo una vez por partida en total). |
| `!alianza <nº facción>` | Fase de Acción, solo si el admin activó alianzas en esta partida | Vota por un alto el fuego de una ronda con esa facción. |
| `!levas` | Fase de Acción | Levantas una barraca en un terreno al azar de tu facción (igual que `!industria`) y te lleva de inmediato +5 soldados de IA que te siguen por el mapa, +1 por ronda las 3 rondas siguientes por cada barraca en pie (luego deja de producir, hay que levantar otra). |
| `!arqueros` | Fase de Acción | Igual que `!levas` pero con un campo de arquería: +5 arqueros de IA al momento, especialistas de ataque (+0.2 fijo atacando, 0 defendiendo). |
| `!caballeros` | Fase de Acción | Igual que `!levas` pero con una caballeriza: +5 caballeros de IA al momento, especialistas de defensa (+0.2 fijo defendiendo, 0 atacando). No confundir con el caballero de la mejora de industria (ese es un jugador con sprite propio, no un acompañante). |
| `!conquista` | Fase de Acción | Ataca a una estructura neutral (castillo, aldea o puerto) elegida al azar entre las que están dentro de tu propio territorio y todavía tienen guarnición. Si ganáis, la estructura empieza a producir para tu facción para siempre; si perdéis, los votantes sufren bajas. |

Solo cuenta el **último comando** que escribas antes de que cierre la Fase de Acción — puedes cambiar de opinión mientras dure.

No hay comandos por botón en la web para el público: los botones/paneles interactivos son solo para el admin. El público solo interactúa por el chat de Twitch.

---

## 5. Las fases de una partida

- **Fase 0 — Configuración** (una sola vez, antes de iniciar) — el admin lo monta todo; nada es visible ni funcional para el público.
- **Fase de Reclutamiento** (una sola vez, al iniciar la partida) — timer configurable, 3 min por defecto. Solo funcionan los comandos `!faccion1`, `!faccion2`... Se puede cambiar de facción libremente mientras dure. Al cerrarse, el roster queda fijo y no se repite esta fase en toda la partida.
- **Fase de Acción** (se repite cada ronda) — timer configurable, 1 min por defecto. Cada usuario **vivo** vota una única acción entre `!industria`, `!ataque <facción>`, `!defender`, `!expansion`, `!especial`, `!alianza <nº>`. Se muestran en pantalla en tiempo real las amenazas entrantes por territorio.
- **Fase de Desarrollo / Combate** (se repite cada ronda) — **sin timer fijo**, dura lo que tarden las animaciones necesarias. Primero se anima el movimiento de cada facción según lo votado (industria generándose en su territorio, tropas moviéndose a posición defensiva mostrando el nombre de cada usuario que defendió, tropas marchando hacia la frontera de quienes atacaron), y al terminar ese movimiento se dispara la animación de Combate en las fronteras con sus resultados.
- **Fase de Resumen** (se repite cada ronda) — sin timer fijo global; cada bloque de información (quién atacó a quién, industria ganada por facción, bajas, conquistas, habilidades activadas...) se queda en pantalla unos 10-15s antes de pasar al siguiente. Al terminar todos los bloques, se vuelve automáticamente a la Fase de Acción.
- **Paron entre fases** (antes de la primera Ronda de Acción, entre Acción y Resumen, y entre Resumen y la siguiente Ronda de Acción) — pausa real de 10-15s: la ronda no avanza y ningún comando de chat tiene efecto. Un esqueleto cruza la pantalla con un cartel anunciando el cambio (primera ronda / resumen de la ronda / número de la siguiente ronda). Ver `docs/ACCIONES.md` sección 13.

---

## 6. Mecánicas del núcleo

### Mapa y plantillas
Varias plantillas prediseñadas por tamaño (varias variantes de 20 casillas, varias de 50, etc.), cada una con su cuadrícula de adyacencias ya definida. El admin elige tamaño y variante en la Fase 0.

### Territorio neutral ("bárbaros")
En el modo de zonas pequeñas, las casillas sin dueño se ocupan con `!expansion`, y el coste es **2 votantes por cada casilla nueva**, con un mínimo de 1 casilla si vota alguien: 1 o 2 votos dan 1 casilla, 4 votos dan 2, 6 dan 3, y así. No hay umbral de porcentaje. El sistema elige automáticamente, al azar, entre las casillas neutrales que tocan la frontera de esa facción, recalculando la frontera tras cada conquista (así se puede avanzar en cadena hacia dentro del territorio neutral, no solo repartirse por el borde inicial).

### Industria y las 4 mejoras (progresión fija)
Cada `!industria` levanta un **edificio de industria** en una casilla al azar de las que controla la facción — en el mapa aparece como un sprite (placeholder, a sustituir por arte de campo de trigo / herrería). La producción de una facción por ronda es:

```
casillas × 0.1  +  edificios de industria × 0.5
```

El edificio pertenece a la **casilla**, no a la facción: si te conquistan un terreno que tiene una industria, el nuevo dueño se queda con los `0.1 + 0.5 = 0.6` completos.

Los 4 umbrales de mejora **escalan con el tamaño de la facción** (3, 8, 15 y 24 de industria por cada miembro que tenía al cerrar el reclutamiento). Es la única forma de que el juego funcione igual con 3 personas por facción que con 60: como cada `!industria` deja una renta permanente, una facción numerosa acumula industria muchísimo más rápido, y con umbrales fijos tendría las 4 mejoras en la ronda 2 mientras una pequeña tardaría 9 rondas. Escalando el umbral, ambas las desbloquean sobre las rondas 4, 7, 10 y 13 — y lo que de verdad marca el ritmo pasa a ser **cuánta gente de tu facción colabora**: con un 20% haciendo industria son las rondas 8-14-19-24; con el 100%, 3-6-8-10.

Por eso la probeta del panel de facciones es comparable entre facciones de tamaños distintos: mide "cómo de bien coopera mi gente", no "cuánta gente tengo". Al alcanzar cada marca se desbloquea, en este orden y de forma automática y permanente:

1. **Caballero** — 1 soldado al azar de la facción pasa a **caballero**: tira su fuerza de combate en 0.9–1.4 en vez de 0.7–1.3, se mueve más rápido en el mapa ("simula un caballo") y tiene su propio sprite, algo más grande que el de un soldado normal. Por lo demás se comporta exactamente igual que cualquier jugador (mismos comandos, mismos destinos al atacar/defender/expandir).
2. **Industria extra** — se levantan **3 edificios de industria** de golpe en casillas al azar de la facción, como si 3 usuarios más hubieran votado `!industria` esa ronda.
3. **Iglesia** — aparece una iglesia junto a la capital de la facción (placeholder propio, igual mecanismo de anillo que el trofeo de dungeon/boss) que da **+50 permanente** al límite de tropas de cada jugador de la facción, mientras dure la partida.
4. **Castillo especial** — aparece un castillo junto a la capital de la facción (placeholder neutro, igual mecanismo que la capital misma), que trae **2 tropas especiales** al construirse y produce **1 más cada ronda** después, hasta un tope de **10 por facción** (al llegar al tope deja de producir). Cada tropa especial es una tropa MÁS del jugador al que le toque (repartida igual que las de IA normales, cuenta para su límite de tropas, le sigue en el mapa): aporta **0.4 fijo tanto de ataque como de defensa**, pero solo cuando ESE jugador escribe `!ataque`/`!defender`, igual que cualquier otra tropa.

### Tropas de IA
Cada casilla que controla una facción genera **1 tropa de IA por ronda**, automático — se reparte entre los jugadores vivos de la facción dándole siempre la siguiente al que menos tropas tenga (así, con más jugadores que territorios, primero les toca a los que todavía no tienen ninguna). Cada tropa sigue siempre en el mapa al jugador que la lleva (su "general"), formando una fila detrás de él, y le suma **+0.1 fijo** de fuerza cuando ese jugador escribe `!ataque` o `!defender` — no es una tirada, es un plus por cada tropa que lleve encima.

### Edificios de tropa: `!levas`, `!arqueros`, `!caballeros`
Además de la generación pasiva de arriba, cada jugador puede votar uno de estos 3 comandos (misma mecánica que `!industria`: un voto, un edificio, en una casilla al azar de tu facción) para levantar una barraca, un campo de arquería o una caballeriza. El edificio le da a **quien lo construyó** un bono inmediato de +5 tropas del tipo correspondiente, y a partir de la ronda siguiente sigue produciendo +1 por ronda durante **3 rondas** — pasadas esas 3 rondas deja de producir (el edificio se queda en pie, hay que levantar otro para que esa casilla vuelva a dar tropa). Mientras produce, ese +1 ya no va necesariamente a quien lo construyó, sino que se reparte por la facción con la misma prioridad de siempre (al que menos tenga). Si el terreno donde está el edificio cambia de dueño, la producción (mientras dure) pasa a la nueva facción sin más, igual que con una industria. Excepción: la guarnición de un castillo/aldea conquistados con `!conquista` (ver abajo) SÍ produce para siempre, sin las 3 rondas de límite — es un premio de conquista, no un edificio votado.

Los soldados de barraca son iguales que los de la generación pasiva (+0.1 fijo, ataque y defensa). Los arqueros y los caballeros de IA son **especialistas**: el arquero solo suma atacando (+0.2), el caballero de IA solo defendiendo (+0.2) — ninguno de los dos aporta nada del otro lado. (No confundir al caballero de IA, un acompañante que sigue al jugador, con el caballero de la mejora de industria nivel 1, que es un jugador que cambia de sprite y de unidad.)

### Estructuras neutrales conquistables: `!conquista`
Los castillos, aldeas y puertos que decoran el mapa empiezan sin dueño, con una guarnición de tropas de IA al azar (distinta cada partida): el castillo trae 5-10 levas + 0-2 arqueros + 0-2 caballeros de IA, la aldea 3-15 levas, y el puerto 6-12 levas + 0-5 arqueros. Sobre cada una se ve un marcador con su guarnición y su fuerza de ataque/defensa, para saber si conviene intentarlo.

Votando `!conquista` atacas, junto con el resto de tu facción que también lo vote esa ronda, a UNA estructura elegida al azar entre las que estén dentro de tu propio territorio y todavía tengan guarnición — no se puede elegir cuál. Tu fuerza de ataque se calcula igual que en un `!ataque` normal (tirada + tus propias tropas); la guarnición no tira dado, solo suma su fuerza fija. Si ganáis, la estructura queda conquistada para siempre y empieza a producir para tu facción: castillo +1 caballero de IA/ronda, aldea +2 levas/ronda, puerto +1 de industria/ronda — y si más adelante pierdes ese terreno, la producción se la lleva quien te lo conquiste a ti, igual que con cualquier otro edificio. Si perdéis el asalto, los que votaron sufren bajas según lo grande que fuera la diferencia de fuerza.

Mientras una estructura no está conquistada, su guarnición se ve paseando alrededor (los mismos placeholders que las tropas de un jugador, en tono bárbaro para diferenciarlos); en cuanto se conquista, esos mismos puestos pasan a ser aldeanos. Cada facción también tiene, desde que empieza la partida, una **capital** representativa en una de sus casillas iniciales, con sus propios aldeanos paseando alrededor — de momento puramente decorativa, sin efecto de juego.

### Dungeons: `!dungeon`
Configurable sí/no en la Fase 0 (panel de admin). Si está activado, aparecen de 1 a 5 dungeons al azar en el mapa entero, cada uno con una guarnición de **orcos y goblins** (siempre 2 orcos + 4 goblins paseando alrededor) — un tipo de tropa aparte de las de castillo/aldea/puerto.

Votando `!dungeon` atacas, junto con el resto de tu facción, a un dungeon que esté dentro de tu propio territorio — comando aparte de `!conquista` porque la recompensa es distinta. Mismo combate bidireccional que `!conquista`: tu ataque decide si lo derrotas, el ataque de la guarnición contra tu defensa os causa bajas siempre, ganéis o no. Al derrotarlo, la guarnición desaparece para siempre y tu facción gana una **estatua** nueva junto a su capital (no producción para la casilla) — con sus propios 4 aldeanos paseando alrededor, igual que la capital. Varias estatuas se reparten en anillo alrededor de la capital sin amontonarse, así que la capital "va creciendo" visiblemente según se derrotan más dungeons.

### Torres: `!torre`
Disponible desde el principio, sin toggle de admin. Construcción en **dos rondas**: votar `!torre` levanta un placeholder "en obras" en un terreno al azar de tu facción esa misma ronda; a la ronda siguiente se termina solo, sin volver a votar. Máximo **10 torres por facción**, contando las terminadas y las en obras a la vez.

Cada torre terminada da **+0.5 de defensa pasiva** a su facción, para siempre — una de las cuatro únicas excepciones a "el territorio no se defiende solo" (las otras tres son las tropas especiales del castillo del nivel 4 de industria, las maravillas de defensa y los museos, ver más abajo; ver Combate para las cuatro juntas): el bonus de las torres se suma SIEMPRE, aunque nadie escriba `!defender` esa ronda, y se acumula con la defensa que sí aporte la gente cuando la haya. Si el terreno donde está la torre cambia de dueño (terminada o a medias), la torre se la lleva quien lo conquiste, igual que cualquier otro edificio.

### Combate
Cuando una facción recibe ataques de una o varias facciones en la misma ronda, **todos se resuelven juntos, no en secuencia** (evita que "quien ataca primero" se coma toda la defensa).

**Cada usuario aporta una tirada propia**, no un valor fijo: quien escribe `!ataque` suma entre **0.7 y 1.3** de ataque (al azar, incluidos los extremos), y quien escribe `!defender` suma entre **0.7 y 1.3** de defensa — un **caballero** (mejora de industria 1/3, ver arriba) tira entre **0.9 y 1.4** en los dos casos. La fuerza de cada bando es la suma de sus tiradas, así que dos combates con el mismo número de gente no salen iguales — un 1 contra 1 lo puede ganar cualquiera de los dos.

**El territorio no se defiende solo.** Una facción a la que nadie defiende esa ronda entra al combate con **0 de defensa** — más el bonus fijo de sus torres terminadas si tiene alguna (ver `!torre` más arriba), más el de sus maravillas de defensa si posee alguna (ver Maravillas más arriba), más el de sus museos si tiene alguno (trofeo de `!boss`, ver más abajo) — estas tres son las ÚNICAS excepciones pasivas, por muchas casillas que tenga la facción: el resto de la defensa sale de los `!defender` de esa ronda. Las tropas especiales del castillo del nivel 4 de industria NO son una excepción pasiva: son una tropa más de quien las lleve, así que solo cuentan si ESE jugador concreto escribe `!ataque`/`!defender` esa ronda, igual que sus demás tropas.

La defensa reduce el ataque entrante; lo que sobra se reparte primero entre las tropas de IA del bando perdedor, en orden **caballero → arquero → leva → especial** (un tipo sin nada de defensa, como el arquero defendiendo, muere entero gratis sin gastar nada del daño). A diferencia de dungeons/bosses/`!conquista`, en combate **jugador contra jugador** ese daño sobrante YA NO mata a nadie: un usuario nunca muere ni desaparece de la partida por quedarse sin tropas, ni atacando ni defendiendo — si se queda a 0 tropas, simplemente tiene que reponerlas. Y ganar el cálculo de fuerza tampoco basta por sí solo para conquistar: solo se pierde territorio si esa cascada deja a TODOS los defensores en 0 tropas (o si nadie defendió) — si a alguno le queda aunque sea una, la defensa aguanta, aunque el atacante ganara el número. El territorio conquistado (cuando sí ocurre) se elige al azar entre las casillas fronterizas del perdedor que tocan al ganador. Visualmente, los atacantes se mueven hacia la casilla de destino y los defensores se reparten entre los distintos frentes activos de su facción.

`!conquista` (contra la guarnición neutral de un castillo/aldea/puerto, ver arriba) es la excepción bidireccional: ahí SÍ hay un "ataque del defensor" de verdad (la guarnición tiene su propia fuerza de ataque fija), así que el contraataque se aplica siempre, ganes o pierdas el asalto — puedes conquistar el edificio y perder tropas en el mismo turno.

Durante la Fase de Acción, el mapa muestra en vivo, sobre cada facción, un **escudo verde 🛡 con el número de defensores** que lleva acumulados y una **espada roja ⚔ con el número de atacantes** que tiene encima, actualizados según la gente va escribiendo en el chat.

### Maravillas
Configurable sí/no en la Fase 0 (panel de admin, `!!wonders`). Si está activado, aparecen de **2 a 6** maravillas al azar en el mapa, sorteadas sin repetir ninguna de las 6 fijas: **Guggenheim** 🏛️ y **La Moncloa** 🏢 y **Plataforma SpaceX** 🚀 (+4 de industria/ronda cada una), **Ruinas de Numancia** 🏺 y **Kebab** 🥙 y **Contrato indefinido** 📄 (+4 de defensa base cada una). Cada una lleva su nombre y su bono escritos justo encima de su placeholder, siempre visibles.

A diferencia de dungeons/castillo/aldea/puerto, una maravilla **no se conquista con ningún comando**: su dueño es, en todo momento, quien controle la casilla en la que salió — basta con `!ataque`/`!expansion` normales, igual que con cualquier otro terreno. Las de industria suman su bono a la producción de la ronda de quien la posea, igual que un edificio; las de defensa se suman de forma pasiva al combate, igual que las torres (ver más abajo) — ambas siguiendo a la casilla automáticamente si cambia de dueño, sin código especial.

### Bosses: `!boss`
Configurable sí/no en la Fase 0 (panel de admin). Si está activado, aparecen de **1 a 3** bosses al azar en el mapa, sorteados sin repetir ninguno de los 3 fijos (**ogro** 👹, **troll** 🧌, **behemot** 🐗), cada uno atado para siempre a la casilla en la que salió y vagando SOLO por ella (nunca sale de ahí, a diferencia de la vaca easter egg, que recorre el mapa entero). Cada instancia sortea su propio ataque y defensa, entre **5 y 10** cada uno, que se ven encima de su cabeza.

Votando `!boss` atacas, junto con el resto de tu facción, a un boss vivo que esté dentro de tu propio territorio — comando aparte de `!conquista`/`!dungeon`, misma mecánica de grupo. Mismo combate bidireccional de siempre: tu ataque decide si lo derrotas, el ataque del boss contra tu defensa os causa bajas siempre, ganéis o no. Al derrotarlo, tu facción gana un **museo** nuevo junto a su capital (mismo mecanismo de anillo que la estatua de dungeon, con sus propios 4 aldeanos alrededor) que da, PARA SIEMPRE y de forma acumulable: **+1 leva/ronda**, **+1 industria/ronda** y **+2 de defensa base**. Si derrotas más de un boss, se crea otro museo por cada uno, y los tres bonos se suman sin tope.

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

