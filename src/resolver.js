import { LidCache } from "./cache.js";
import { esNumeroValido } from "./validator.js";

const SUFIJO_LID = "@lid";
const SUFIJO_LID_HOSTED = "@hosted.lid";
const SUFIJO_JID = "@s.whatsapp.net";

function esLid(valor) {
  return (
    typeof valor === "string" &&
    (valor.endsWith(SUFIJO_LID) || valor.endsWith(SUFIJO_LID_HOSTED))
  );
}

function esJidResuelto(valor) {
  return typeof valor === "string" && valor.endsWith(SUFIJO_JID);
}

function limpiarJid(valor) {
  if (typeof valor !== "string") return null;
  const raw = valor.split("@")[0].split(":")[0];
  const numero = raw.replace(/\D/g, "");
  if (!esNumeroValido(numero)) return null;
  return `${numero}${SUFIJO_JID}`;
}

export class LidResolver {
  #cache;
  #sock;
  #store;
  #reverseIndex = new Map();
  #handler;
  #msgHandler;
  #lidMappingHandler;
  #historyHandler;
  #groupParticipantHandler;
  #groupsUpsertHandler;
  #groupJoinRequestHandler;
  #groupMemberTagHandler;
  #maxIndexSize;
  #sincronizado = false;

  constructor(sock, options = {}) {
    this.#sock = sock;
    this.#store = options.store || null;
    this.#cache = new LidCache(options.cache || {});
    this.#maxIndexSize = Math.max(1000, options.maxIndexSize || 50000);

    this.#handler = (contactos) => this.#actualizarIndice(contactos);

    this.#msgHandler = async ({ messages }) => {
      const nuevosPares = [];
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const sender = msg.key.participant || msg.key.remoteJid;
        const alt = msg.key.participantAlt || msg.key.remoteJidAlt;

        if (sender && alt) {
          const lid = esLid(sender) ? sender : esLid(alt) ? alt : null;
          const pn = esJidResuelto(sender)
            ? sender
            : esJidResuelto(alt)
            ? alt
            : null;

          if (lid && pn) {
            const jidLimpio = limpiarJid(pn);
            if (jidLimpio) {
              this.#reverseIndex.set(lid, jidLimpio);
              this.#cache.set(lid, jidLimpio);
              nuevosPares.push({ lid, pn: jidLimpio });
            }
          }
        }

        if (esLid(sender)) {
          this.resolver(sender).catch(() => {});
        }
      }
      if (nuevosPares.length > 0) {
        this.#limpiarExcesoIndice();
        this.#guardarEnSignalRepository(nuevosPares);
      }
    };

    this.#lidMappingHandler = ({ lid, pn }) => {
      const jidLimpio = limpiarJid(pn);
      if (lid && jidLimpio) {
        this.#reverseIndex.set(lid, jidLimpio);
        this.#cache.set(lid, jidLimpio);
        this.#limpiarExcesoIndice();
        this.#guardarEnSignalRepository([{ lid, pn: jidLimpio }]);
      }
    };

    this.#historyHandler = ({ lidPnMappings }) => {
      if (!Array.isArray(lidPnMappings) || lidPnMappings.length === 0) return;
      const nuevosPares = [];
      for (const { lid, pn } of lidPnMappings) {
        const jidLimpio = limpiarJid(pn);
        if (lid && jidLimpio) {
          this.#reverseIndex.set(lid, jidLimpio);
          this.#cache.set(lid, jidLimpio);
          nuevosPares.push({ lid, pn: jidLimpio });
        }
      }
      if (nuevosPares.length > 0) {
        this.#limpiarExcesoIndice();
        this.#guardarEnSignalRepository(nuevosPares);
      }
    };

    this.#groupParticipantHandler = ({ author, authorPn, participants }) => {
      const nuevosPares = [];

      if (author && authorPn) {
        const lid = esLid(author) ? author : null;
        const jidLimpio = lid ? limpiarJid(authorPn) : null;
        if (lid && jidLimpio) {
          this.#reverseIndex.set(lid, jidLimpio);
          this.#cache.set(lid, jidLimpio);
          nuevosPares.push({ lid, pn: jidLimpio });
        }
      }

      if (Array.isArray(participants)) {
        for (const p of participants) {
          if (p.lid && p.phoneNumber) {
            const jidLimpio = limpiarJid(p.phoneNumber);
            if (jidLimpio) {
              this.#reverseIndex.set(p.lid, jidLimpio);
              this.#cache.set(p.lid, jidLimpio);
              nuevosPares.push({ lid: p.lid, pn: jidLimpio });
            }
          } else if (esLid(p.id || p.lid)) {
            const lid = p.lid || p.id;
            if (!this.#reverseIndex.has(lid) && !this.#cache.has(lid)) {
              this.resolver(lid).catch(() => {});
            }
          }
        }
      }

      if (nuevosPares.length > 0) {
        this.#limpiarExcesoIndice();
        this.#guardarEnSignalRepository(nuevosPares);
      }
    };

    this.#groupJoinRequestHandler = ({
      author,
      authorPn,
      participant,
      participantPn,
    }) => {
      const nuevosPares = [];
      if (author && authorPn) {
        const jid = limpiarJid(authorPn);
        if (esLid(author) && jid) nuevosPares.push({ lid: author, pn: jid });
      }
      if (participant && participantPn) {
        const jid = limpiarJid(participantPn);
        if (esLid(participant) && jid)
          nuevosPares.push({ lid: participant, pn: jid });
      }

      if (nuevosPares.length > 0) {
        for (const { lid, pn } of nuevosPares) {
          this.#reverseIndex.set(lid, pn);
          this.#cache.set(lid, pn);
        }
        this.#limpiarExcesoIndice();
        this.#guardarEnSignalRepository(nuevosPares);
      }
    };

    this.#groupMemberTagHandler = ({ participant, participantAlt }) => {
      if (!participant || !participantAlt) return;

      const lid = esLid(participant)
        ? participant
        : esLid(participantAlt)
        ? participantAlt
        : null;
      const pn = esJidResuelto(participant)
        ? participant
        : esJidResuelto(participantAlt)
        ? participantAlt
        : null;

      if (!lid || !pn) return;

      const jidLimpio = limpiarJid(pn);
      if (!jidLimpio) return;

      this.#reverseIndex.set(lid, jidLimpio);
      this.#cache.set(lid, jidLimpio);
      this.#limpiarExcesoIndice();
      this.#guardarEnSignalRepository([{ lid, pn: jidLimpio }]);
    };

    this.#groupsUpsertHandler = (groups) => {
      if (!Array.isArray(groups)) return;
      for (const group of groups) {
        if (Array.isArray(group.participants)) {
          this.#actualizarIndice(group.participants);
        }
      }
    };

    this.sincronizarDesdeStore();
    this.#suscribirAEventos();
  }

  #suscribirAEventos() {
    this.#sock.ev.on("contacts.upsert", this.#handler);
    this.#sock.ev.on("contacts.update", this.#handler);
    this.#sock.ev.on("messages.upsert", this.#msgHandler);
    this.#sock.ev.on("lid-mapping.update", this.#lidMappingHandler);
    this.#sock.ev.on("messaging-history.set", this.#historyHandler);
    this.#sock.ev.on("group-participants.update", this.#groupParticipantHandler);
    this.#sock.ev.on("group.join-request", this.#groupJoinRequestHandler);
    this.#sock.ev.on("group.member-tag.update", this.#groupMemberTagHandler);
    this.#sock.ev.on("groups.upsert", this.#groupsUpsertHandler);
    this.#sock.ev.on("groups.update", this.#groupsUpsertHandler);
  }

  #guardarEnSignalRepository(pares) {
    try {
      if (this.#sock.signalRepository?.lidMapping?.storeLIDPNMappings) {
        this.#sock.signalRepository.lidMapping
          .storeLIDPNMappings(pares)
          .catch(() => {});
      }
    } catch (_) {}
  }

  #actualizarIndice(contactos) {
    if (!Array.isArray(contactos)) return;
    const nuevosPares = [];

    for (const c of contactos) {
      const lid = c.lid || (esLid(c.id) ? c.id : null);
      const jidRaw = c.phoneNumber || (esJidResuelto(c.id) ? c.id : null);

      if (lid && jidRaw) {
        const jidLimpio = limpiarJid(jidRaw);
        if (jidLimpio) {
          this.#reverseIndex.set(lid, jidLimpio);
          this.#cache.set(lid, jidLimpio);
          nuevosPares.push({ lid, pn: jidLimpio });
        }
      }
    }

    if (nuevosPares.length > 0) {
      this.#limpiarExcesoIndice();
      this.#guardarEnSignalRepository(nuevosPares);
    }
  }

  #limpiarExcesoIndice() {
    if (this.#reverseIndex.size >= this.#maxIndexSize) {
      const toDelete = Math.floor(this.#maxIndexSize * 0.1);
      let count = 0;
      for (const key of this.#reverseIndex.keys()) {
        if (count >= toDelete) break;
        this.#reverseIndex.delete(key);
        count++;
      }
    }
  }

  esResolvable(id) {
    return esLid(id) && (this.#cache.has(id) || this.#reverseIndex.has(id));
  }

  precargarCache(pares) {
    if (!Array.isArray(pares) && !(pares instanceof Map)) return;
    const nuevosPares = [];

    for (const [lid, jid] of pares) {
      if (esLid(lid) && esJidResuelto(jid)) {
        this.#reverseIndex.set(lid, jid);
        this.#cache.set(lid, jid);
        nuevosPares.push({ lid, pn: jid });
      }
    }

    if (nuevosPares.length > 0) {
      this.#limpiarExcesoIndice();
      this.#guardarEnSignalRepository(nuevosPares);
    }
  }

  getStats() {
    return {
      cache: this.#cache.getStats(),
      index: {
        size: this.#reverseIndex.size,
        maxSize: this.#maxIndexSize,
      },
      sincronizado: this.#sincronizado,
    };
  }

  sincronizarDesdeStore(forzar = false) {
    try {
      if ((this.#sincronizado && !forzar) || !this.#store) return;
      if (typeof this.#store !== "object") return;

      let hayDatos = false;

      if (this.#store.contacts) {
        const contactos = Object.values(this.#store.contacts);
        if (contactos.length > 0) {
          this.#actualizarIndice(contactos);
          hayDatos = true;
        }
      }

      if (this.#store.chats) {
        const chats = Object.values(this.#store.chats);
        for (const chat of chats) {
          if (Array.isArray(chat.participants) && chat.participants.length > 0) {
            this.#actualizarIndice(chat.participants);
            hayDatos = true;
          }
        }
      }

      if (hayDatos) {
        this.#sincronizado = true;
      }
    } catch (_) {}
  }

  async resolver(id) {
    if (!id || typeof id !== "string") return null;
    if (esJidResuelto(id)) return limpiarJid(id) || id;
    if (!esLid(id)) return null;

    const cached = this.#cache.get(id);
    if (cached) return cached;

    const jid = this.#reverseIndex.get(id);
    if (jid) {
      this.#cache.set(id, jid);
      return jid;
    }

    try {
      const repo = this.#sock.signalRepository?.lidMapping;
      if (repo?.getPNForLID) {
        const pn = await repo.getPNForLID(id);
        if (pn) {
          const jidReal = limpiarJid(pn);
          if (jidReal) {
            this.#limpiarExcesoIndice();
            this.#reverseIndex.set(id, jidReal);
            this.#cache.set(id, jidReal);
            return jidReal;
          }
        }
      }
    } catch (_) {}

    return null;
  }

  async resolverLote(ids, opts = {}) {
    const concurrency = opts.concurrency || 5;
    const resultMap = new Map();
    let pendientes = [];

    for (const id of ids) {
      if (!esLid(id)) continue;

      const fromCache = this.#cache.get(id);
      if (fromCache) {
        resultMap.set(id, fromCache);
        continue;
      }

      const fromIndex = this.#reverseIndex.get(id);
      if (fromIndex) {
        this.#cache.set(id, fromIndex);
        resultMap.set(id, fromIndex);
        continue;
      }

      pendientes.push(id);
    }

    if (pendientes.length === 0) return resultMap;

    try {
      const repo = this.#sock.signalRepository?.lidMapping;
      if (repo?.getPNsForLIDs) {
        const mappings = await repo.getPNsForLIDs(pendientes);
        if (Array.isArray(mappings)) {
          for (const { lid, pn } of mappings) {
            if (!lid || !pn) continue;
            const jidReal = limpiarJid(pn);
            if (jidReal) {
              this.#limpiarExcesoIndice();
              this.#reverseIndex.set(lid, jidReal);
              this.#cache.set(lid, jidReal);
              resultMap.set(lid, jidReal);
            }
          }
        }
      }
    } catch (_) {}

    pendientes = pendientes.filter((id) => !resultMap.has(id));

    for (let i = 0; i < pendientes.length; i += concurrency) {
      const chunk = pendientes.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (id) => {
          const res = await this.resolver(id);
          if (res) resultMap.set(id, res);
        })
      );
    }

    return resultMap;
  }

  async resolverParticipantes(participants) {
    if (!Array.isArray(participants)) return new Map();

    const lids = participants
      .map((p) => (typeof p === "string" ? p : p?.id || p?.lid))
      .filter((id) => esLid(id));

    return this.resolverLote(lids);
  }

  destroy() {
    this.#cache.destroy();
    this.#reverseIndex.clear();
    this.#sock.ev.off("contacts.upsert", this.#handler);
    this.#sock.ev.off("contacts.update", this.#handler);
    this.#sock.ev.off("messages.upsert", this.#msgHandler);
    this.#sock.ev.off("lid-mapping.update", this.#lidMappingHandler);
    this.#sock.ev.off("messaging-history.set", this.#historyHandler);
    this.#sock.ev.off("group-participants.update", this.#groupParticipantHandler);
    this.#sock.ev.off("group.join-request", this.#groupJoinRequestHandler);
    this.#sock.ev.off("group.member-tag.update", this.#groupMemberTagHandler);
    this.#sock.ev.off("groups.upsert", this.#groupsUpsertHandler);
    this.#sock.ev.off("groups.update", this.#groupsUpsertHandler);
  }
        }
