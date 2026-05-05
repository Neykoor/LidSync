import { makeWASocket, useMultiFileAuthState, makeInMemoryStore, jidNormalizedUser } from '@whiskeysockets/baileys';
import { pluginLid } from 'lidsync';
import pino from 'pino';

const store = makeInMemoryStore({
  logger: pino().child({ level: 'silent', stream: 'store' })
});

store.readFromFile('./baileys_store.json');
setInterval(() => {
  store.writeToFile('./baileys_store.json');
}, 10_000);

async function startExample() {
  const { state, saveCreds } = await useMultiFileAuthState('./session_example');

  let sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock = pluginLid(sock, { store });
  store.bind(sock.ev);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'open') console.log('Bot conectado y LidSync activado.');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    let sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
    let realJid = sender;

    if (sender.endsWith('@lid')) {
      const resolved = await sock.lid.resolve(sender);
      if (resolved) realJid = jidNormalizedUser(resolved);
    }

    console.log(`Mensaje de: ${msg.pushName || 'Desconocido'}`);
    console.log(`LID: ${sender} → JID: ${realJid}`);
    console.log(`Texto: ${msg.message.conversation || msg.message.extendedTextMessage?.text || '[Multimedia]'}`);
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action !== 'add') return;

    const resolved = await sock.lid.resolveParticipants(participants);

    for (const p of participants) {
      const lid = p.lid || (p.id?.endsWith('@lid') ? p.id : null);
      const jid = resolved.get(lid || p.id) || p.id;

      await sock.sendMessage(id, {
        text: `Bienvenido @${jid.split('@')[0]}`,
        mentions: [jid]
      });
    }
  });
}

startExample();
