<p align="center">
  <img src="https://files.catbox.moe/m28b4w.gif" width="100%" />
</p>

<h1 align="center">LidSync</h1>

<p align="center">
  <b>LID → JID Identity Resolver para Baileys</b><br>
  <sub>Construido para seguir de cerca la evolución interna de Baileys y su implementación del sistema LID de WhatsApp</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.0.2-blue.svg?style=flat-square"/>
  <img src="https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square"/>
  <img src="https://img.shields.io/badge/Node.js-18%2B-green.svg?style=flat-square&logo=node.js"/>
  <img src="https://img.shields.io/badge/Baileys-%3E%3D6.7.0-purple.svg?style=flat-square"/>
  <img src="https://img.shields.io/badge/status-stable-success.svg?style=flat-square"/>
</p>

---

## ¿Qué es LidSync?

WhatsApp introdujo los **LIDs** como identificadores de privacidad que ocultan el número real de un usuario. Cuando un bot opera en grupos modernos de WhatsApp, los remitentes llegan como:

```
170360431460562@lid
```

en lugar del número real. LidSync resuelve esos LIDs al JID real correspondiente:

```
170360431460562@lid  →  521234567890@s.whatsapp.net
```

LidSync no es un parche externo — sigue de cerca la arquitectura interna de Baileys. Usa el `signalRepository.lidMapping` que Baileys expone nativamente, se suscribe a los mismos eventos que Baileys emite (`lid-mapping.update`, `messaging-history.set`, `group-participants.update`, `group.join-request`, `group.member-tag.update`) y escribe de vuelta en el store de señal cuando aprende nuevos pares.

---

## Cómo funciona

LidSync resuelve mediante tres capas en cascada:

| Nivel | Fuente | Detalle |
|:---:|---|---|
| **1** | Cache LRU | TTL de 24 h con refresco automático en cada lectura. Máx 7 500 entradas. |
| **2** | Índice invertido | `Map<LID, JID>` en memoria, O(1). Se promueve al caché en cada consulta. |
| **3** | Signal Repository | Fallback al `lidMapping` interno de Baileys y, si no hay resultado, al `pnToLIDFunc` vía USync. |

El aprendizaje es completamente pasivo: cada mensaje, evento de contacto, actualización de grupo o acción de historial que Baileys emite es interceptado y procesado para enriquecer el índice automáticamente.

> **Nota:** Un LID solo puede resolverse si el usuario ya interactuó con el bot o está en la agenda del número vinculado. Esto es una restricción de WhatsApp, no de LidSync.

---

## Instalación

```bash
npm install lidsync
```

O via git para siempre tener la última versión:

```bash
npm install git+https://github.com/Neykoor/LidSync.git
```

**Requisitos:**
- Node.js `>= 18`
- `@whiskeysockets/baileys >= 6.7.0` (peer dependency)

---

## Inicio rápido

```js
import { makeWASocket, useMultiFileAuthState } from "@whiskeysockets/baileys";
import { pluginLid } from "lidsync";

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");

  let sock = makeWASocket({ auth: state });

  // Inyectar LidSync — debe ir antes de store.bind()
  sock = pluginLid(sock, { store });

  // Vincular el store a los eventos del socket
  store.bind(sock.ev);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const jid = await sock.lid.resolve(sender);

    console.log(`Mensaje de: ${jid ?? sender}`);
  });
}

start();
```

> `pluginLid` debe llamarse **antes** de `store.bind()` para que el resolver ya esté suscrito cuando lleguen los primeros eventos de contactos.

---

## Vinculación con store personalizado

Si usas un store propio (JSON, SQLite, etc.), pásalo en las opciones para que LidSync pueda aprender de los contactos y chats ya almacenados:

```js
sock = pluginLid(sock, { store: miStore });
```

El store debe exponer al menos `contacts` y/o `chats` como objetos planos con los contactos indexados por JID. Después de que la conexión abra, fuerza la sincronización si el store carga sus datos desde disco:

```js
sock.ev.on("connection.update", ({ connection }) => {
  if (connection === "open") sock.lid.syncStore();
});
```

---

## API

### `sock.lid.resolve(id)`

Resuelve un LID a su JID real. Si el input ya es un JID `@s.whatsapp.net`, lo devuelve normalizado directamente. Los sufijos de dispositivo (`:0`, `:1`, `:2`) se eliminan automáticamente de la salida.

```js
const jid = await sock.lid.resolve("170360431460562@lid");
// → "521234567890@s.whatsapp.net" | null
```

| Retorno | Significado |
|---|---|
| `string` | JID limpio y normalizado |
| `null` | LID sin mapeo conocido aún |

---

### `sock.lid.resolveBatch(ids, opciones?)`

Resuelve múltiples LIDs con concurrencia controlada. Los que están en caché o índice se resuelven de inmediato sin bloquear.

```js
const resultado = await sock.lid.resolveBatch(
  ["id1@lid", "id2@lid", "id3@lid"],
  { concurrency: 5 }
);

for (const [lid, jid] of resultado) {
  console.log(`${lid} → ${jid}`);
}
```

**Retorna:** `Map<string, string>` — solo incluye los LIDs que pudieron resolverse.

---

### `sock.lid.syncStore(forzar?)`

Sincroniza el índice desde el store manualmente. Útil cuando el store carga datos desde disco después de que `pluginLid` ya fue inicializado.

```js
sock.lid.syncStore();       // Solo si no se sincronizó antes
sock.lid.syncStore(true);   // Fuerza re-sincronización siempre
```

---

### `sock.lid.isResolvable(id)`

Comprueba si un LID tiene mapeo conocido **sin hacer ninguna consulta**. Útil para decidir si vale la pena llamar a `resolve`.

```js
if (sock.lid.isResolvable("170360431460562@lid")) {
  const jid = await sock.lid.resolve("170360431460562@lid");
}
```

**Retorna:** `boolean`

---

### `sock.lid.preload(pares)`

Pre-carga mapeos desde una fuente externa (base de datos, archivo) directamente al caché e índice.

```js
sock.lid.preload([
  ["123456789@lid", "521234567890@s.whatsapp.net"],
  ["987654321@lid", "521987654321@s.whatsapp.net"]
]);

// También acepta Map
sock.lid.preload(new Map([["123@lid", "521...@s.whatsapp.net"]]));
```

---

### `sock.lid.getStats()`

Devuelve métricas del caché LRU y el índice invertido.

```js
const stats = sock.lid.getStats();
/*
{
  cache: {
    size: 1250,
    maxSize: 7500,
    hits: 4821,
    misses: 302,
    evictions: 0,
    expirations: 14,
    hitRate: "94.10%",
    memoryEstimate: "305.18 KB"
  },
  index: {
    size: 1250,
    maxSize: 50000
  },
  sincronizado: true
}
*/
```

---

### `sock.lid.destroy()`

Limpia el caché, vacía el índice y remueve todos los listeners del socket. Llámalo siempre antes de una reconexión para evitar listeners duplicados.

```js
sock.lid.destroy();
sock = await reconnect();
sock = pluginLid(sock, { store });
```

---

## Eventos que LidSync escucha

LidSync se suscribe a los eventos nativos de Baileys. No agrega overhead — aprovecha lo que Baileys ya emite:

| Evento | Qué aprende |
|---|---|
| `contacts.upsert` / `contacts.update` | Contactos con LID y número telefónico |
| `messages.upsert` | Pares LID↔JID desde `participant` y `participantAlt` |
| `lid-mapping.update` | Mappings directos desde acciones de AppState |
| `messaging-history.set` | Historial con `lidPnMappings` |
| `group-participants.update` | Participantes con `phoneNumber` y `lid` |
| `group.join-request` | `authorPn` y `participantPn` |
| `group.member-tag.update` | `participantAlt` con LID/JID |
| `groups.upsert` / `groups.update` | Participantes de grupos al sincronizar |

---

## Arquitectura interna

```
pluginLid(sock, { store })
│
├── LidResolver
│   ├── LidCache          — LRU, TTL 24h, máx 7 500 entradas
│   ├── #reverseIndex     — Map<LID, JID>, O(1), máx 50 000
│   ├── Listeners         — 9 eventos de Baileys
│   └── signalRepository  — lidMapping nativo de Baileys
│
└── sock.lid
    ├── resolve(id)
    ├── resolveBatch(ids, opts?)
    ├── syncStore(forzar?)
    ├── isResolvable(id)
    ├── preload(pares)
    ├── getStats()
    └── destroy()
```

---

## Compatibilidad

| Entorno | Soporte |
|---|---|
| Node.js | `>= 18` |
| Baileys | `>= 6.7.0` |
| Termux | ✅ |
| Render / Railway | ✅ |
| Pterodactyl / Pelican | ✅ |

---

## Bot de referencia

Repositorio con implementación completa lista para usar:

🔗 [LidSync-CoreBot](https://github.com/Neykoor/LidSync-CoreBot)

---

## Creador

<p align="center">
  <a href="https://github.com/Neykoor">
    <img src="https://github.com/Neykoor.png" width="80" style="border-radius:50%"/>
  </a><br>
  <b>Neykoor</b><br>
  <a href="https://github.com/Neykoor">github.com/Neykoor</a>
</p>

---

## Agradecimientos

<p align="center">
  <a href="https://github.com/WhiskeySockets/Baileys">
    <img src="https://github.com/WhiskeySockets.png" width="80" style="border-radius:50%"/>
  </a><br>
  <b>WhiskeySockets / Baileys</b><br>
  <a href="https://github.com/WhiskeySockets/Baileys">github.com/WhiskeySockets/Baileys</a>
</p>

---

<p align="center">
  <sub>LidSync sigue la evolución de Baileys. Cuando Baileys cambia su implementación LID, LidSync se actualiza en consecuencia.</sub>
</p>
