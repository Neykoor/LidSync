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
  <img src="https://img.shields.io/badge/estado-funciona%20✅-success.svg?style=flat-square"/>
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

LidSync no es un parche externo — sigue de cerca la arquitectura interna de Baileys. Usa el `signalRepository.lidMapping` que Baileys expone nativamente, se suscribe a los mismos eventos que Baileys emite y escribe de vuelta en el store de señal cuando aprende nuevos pares.

---

## Estado

> ✅ **La librería funciona con la versión actual de Baileys.**
>
> LidSync se actualiza cuando Baileys cambia su implementación LID interna. Las actualizaciones normalmente siguen el ritmo de Baileys, aunque si un cambio crítico lo requiere, se lanza un parche de inmediato.

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

## Ejemplo completo — Welcome con LID resuelto

Este es el caso más común: enviar un mensaje de bienvenida cuando alguien entra a un grupo, resolviendo su LID al número real para mencionarlo correctamente.

```js
import {
  makeWASocket,
  useMultiFileAuthState,
  makeInMemoryStore,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { pluginLid } from "lidsync";
import pino from "pino";

const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }),
});

store.readFromFile("./baileys_store.json");
setInterval(() => store.writeToFile("./baileys_store.json"), 10_000);

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");

  let sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "silent" }),
  });

  // 1. Inyectar LidSync antes de store.bind()
  sock = pluginLid(sock, { store });
  store.bind(sock.ev);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") {
      console.log("Bot conectado y LidSync activado.");
      // Si el store carga datos desde disco, forzar sincronización aquí
      sock.lid.syncStore();
    }
  });

  // Welcome con resolución de LID
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action !== "add") return;

    // Resolver todos los LIDs del batch de una vez
    const resolved = await sock.lid.resolveParticipants(participants);

    for (const p of participants) {
      const lid = p.lid || (p.id?.endsWith("@lid") ? p.id : null);
      const jid = resolved.get(lid || p.id) || p.id;

      await sock.sendMessage(id, {
        text: `¡Bienvenido @${jid.split("@")[0]}! 👋`,
        mentions: [jid],
      });
    }
  });
}

start();
```

**¿Por qué usar `resolveParticipants` en el welcome?**

Cuando varios usuarios entran al mismo tiempo, `resolveParticipants` resuelve el lote completo en una sola operación batch. Es más eficiente que llamar `resolve()` uno a uno y garantiza que la mención llegue con el JID real, no con el LID crudo.

> **Nota:** Si el LID aún no tiene mapeo conocido, `resolved.get(...)` devuelve `undefined` y el fallback `|| p.id` usa el LID original. El mensaje se envía igual — WhatsApp lo entrega correctamente, aunque la mención visual puede quedar sin nombre en clientes muy nuevos.

---

## Cómo funciona

LidSync resuelve mediante tres capas en cascada:

| Nivel | Fuente | Detalle |
|:---:|---|---|
| **1** | Cache LRU | TTL de 24 h con refresco automático en cada lectura. Máx 7 500 entradas. |
| **2** | Índice invertido | `Map<LID, JID>` en memoria, O(1). Se promueve al caché en cada consulta. |
| **3** | Signal Repository | Fallback al `lidMapping` interno de Baileys. |

El aprendizaje es completamente pasivo: cada mensaje, evento de contacto, actualización de grupo o historial que Baileys emite es interceptado y procesado para enriquecer el índice automáticamente.

> **Nota:** Un LID solo puede resolverse si el usuario ya interactuó con el bot o está en la agenda del número vinculado. Esta es una restricción de WhatsApp, no de LidSync.

---

## Vinculación con store personalizado

Si usas un store propio (JSON, SQLite, etc.), pásalo en las opciones para que LidSync pueda aprender de los contactos y chats ya almacenados:

```js
sock = pluginLid(sock, { store: miStore });
```

El store debe exponer al menos `contacts` y/o `chats` como objetos planos. Después de que la conexión abra, fuerza la sincronización si el store carga sus datos desde disco:

```js
sock.ev.on("connection.update", ({ connection }) => {
  if (connection === "open") sock.lid.syncStore();
});
```

---

## API

### `sock.lid.resolve(id)`

Resuelve un LID a su JID real. Si el input ya es un JID `@s.whatsapp.net`, lo devuelve normalizado directamente.

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

Resuelve múltiples LIDs con concurrencia controlada.

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

### `sock.lid.resolveParticipants(participants)`

Resuelve los LIDs de un array de participantes de grupo en una sola operación batch. Es el método recomendado para el evento `group-participants.update`.

```js
const resolved = await sock.lid.resolveParticipants(participants);
const jid = resolved.get(p.lid || p.id);
```

**Retorna:** `Map<string, string>`

---

### `sock.lid.syncStore(forzar?)`

Sincroniza el índice desde el store manualmente.

```js
sock.lid.syncStore();       // Solo si no se sincronizó antes
sock.lid.syncStore(true);   // Fuerza re-sincronización siempre
```

---

### `sock.lid.isResolvable(id)`

Comprueba si un LID tiene mapeo conocido sin hacer ninguna consulta externa.

```js
if (sock.lid.isResolvable("170360431460562@lid")) {
  const jid = await sock.lid.resolve("170360431460562@lid");
}
```

**Retorna:** `boolean`

---

### `sock.lid.preload(pares)`

Pre-carga mapeos desde una fuente externa directamente al caché e índice.

```js
sock.lid.preload([
  ["123456789@lid", "521234567890@s.whatsapp.net"],
  ["987654321@lid", "521987654321@s.whatsapp.net"],
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
    maxSize: 50000,
    ttlMs: 21600000
  },
  sincronizado: true
}
*/
```

---

### `sock.lid.destroy()`

Limpia el caché, vacía el índice y remueve todos los listeners. Llámalo siempre antes de una reconexión.

```js
sock.lid.destroy();
sock = await reconnect();
sock = pluginLid(sock, { store });
```

---

## Eventos que LidSync escucha

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
    ├── resolveParticipants(participants)
    ├── syncStore(forzar?)
    ├── isResolvable(id)
    ├── preload(pares)
    ├── getStats()
    └── destroy()
```

---

## Política de actualizaciones

LidSync se actualiza siguiendo el ritmo de Baileys. Cuando Baileys modifica su implementación interna del sistema LID, LidSync se adapta en consecuencia. Las actualizaciones pueden tardar algunos días si el cambio es menor, pero si un breaking change afecta el funcionamiento core, **se lanza un parche de inmediato**.

Si encontrás que algo dejó de funcionar después de actualizar Baileys, abrí un issue indicando la versión de Baileys y el comportamiento observado.

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
