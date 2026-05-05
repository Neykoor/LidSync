import { LidCache } from "./cache.js";

const SUFIJO_LID = "@lid";
const SUFIJO_JID = "@s.whatsapp.net";

function esLid(valor) {
  return typeof valor === "string" && valor.endsWith(SUFIJO_LID);
}

function esJidResuelto(valor) {
  return typeof valor === "string" && valor.endsWith(SUFIJO_JID);
}

function limpiarJid(valor) {
  if (typeof valor !== "string") return null;
  const numero = valor.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!numero || numero.length < 5) return null;
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
          const pn = esJidResuelto(sender) ? sender : esJidResuelto(alt) ? alt : null;
          
          if (lid && pn) {
            const jidLimpio = limpiarJid(pn);
            if (jidLimpio) {
              this.#limpiarExcesoIndice();
              this.#reverseIndex.set(lid, jidLimpio);
              this.#cache.set(lid, jidLimpio);
              nuevosPares.push({ lid, pn: jidLimpio });
            }
          }
        }

        if (esLid(sender)) {
          this.resolver(sender).catch(e => console.warn(`[LidSync] Event Resolve Error:`, e.message));
        }
      }
      if (nuevosPares.length > 0) this.#guardarEnSignalRepository(nuevosPares);
    };

    this.#lidMappingHandler = ({ lid, pn }) => {
      const jidLimpio = limpiarJid(pn);
      if (lid && jidLimpio) {
        this.#limpiarExcesoIndice();
        this.#reverseIndex.set(lid, jidLimpio);
        this.#cache.set(lid, jidLimpio);
        this.#guardarEnSignalRepository([{ lid, pn: jidLimpio }]);
      }
    };

    this.#historyHandler = ({ lidPnMappings }) => {
      if (!Array.isArray(lidPnMappings) || lidPnMappings.length === 0) return;
      const nuevosPares = [];
      for (const { lid, pn } of lidPnMappings) {
        const jidLimpio = limpiarJid(pn);
        if (lid && jidLimpio) {
          this.#limpiarExcesoIndice();
          this.#reverseIndex.set(lid, jidLimpio);
          this.#cache.set(lid, jidLimpio);
          nuevosPares.push({ lid, pn: jidLimpio });
        }
      }
      if (nuevosPares.length > 0) this.#guardarEnSignalRepository(nuevosPares);
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
  }

  #guardarEnSignalRepository(pares) {
    try {
      if (this.#sock.signalRepository?.lidMapping?.storeLIDPNMappings) {
        this.#sock.signalRepository.lidMapping.storeLIDPNMappings(pares);
      }
    } catch (e) {
      console.warn(`[LidSync] Error guardando en signalRepository:`, e.message);
    }
  }

  #actualizarIndice(contactos) {
    if (!Array.isArray(contactos)) return;
    const nuevosPares = [];

    for (const c of contactos) {
      let lid = c.lid || (esLid(c.id) ? c.id : null);
      let jid = c.phoneNumber || (esJidResuelto(c.id) ? c.id : null);

      if (lid && jid) {
        const jidLimpio = limpiarJid(jid);
        if (jidLimpio) {
          this.#limpiarExcesoIndice();
          this.#reverseIndex.set(lid, jidLimpio);
          this.#cache.set(lid, jidLimpio);
          nuevosPares.push({ lid, pn: jidLimpio });
        }
      }
    }
    
    if (nuevosPares.length > 0) this.#guardarEnSignalRepository(nuevosPares);
  }

  #limpiarExcesoIndice() {
    if (this.#reverseIndex.size >= this.#maxIndexSize) {
      const keys = Array.from(this.#reverseIndex.keys());
      const toDelete = keys.slice(0, Math.floor(this.#maxIndexSize * 0.1));
      for (const key of toDelete) {
        this.#reverseIndex.delete(key);
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
        this.#limpiarExcesoIndice();
        this.#reverseIndex.set(lid, jid);
        this.#cache.set(lid, jid);
        nuevosPares.push({ lid, pn: jid });
      }
    }

    if (nuevosPares.length > 0) this.#guardarEnSignalRepository(nuevosPares);
  }

  getStats() {
    return {
      cache: this.#cache.getStats(),
      index: {
        size: this.#reverseIndex.size,
        maxSize: this.#maxIndexSize
      },
      sincronizado: this.#sincronizado
    };
  }

  sincronizarDesdeStore(forzar = false) {
    try {
      if ((this.#sincronizado && !forzar) || !this.#store) return;

      if (typeof this.#store !== 'object' || !this.#store.contacts) {
        return;
      }

      const contactos = Object.values(this.#store.contacts);
      if (contactos.length > 0) {
        this.#actualizarIndice(contactos);
        this.#sincronizado = true;
      }
    } catch (error) {
      console.warn(`[LidSync] Store Sync Error:`, error.message);
    }
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
    } catch (e) {
      console.warn(`[LidSync] Error signalRepository:`, e.message);
    }
    return null;
  }

  async resolverLote(ids, opts = {}) {
    const concurrency = opts.concurrency || 5;
    const resultMap = new Map();
    let pendientes = [];

    for (const id of ids) {
      if (!esLid(id)) continue;

      const cached = this.#cache.get(id) || this.#reverseIndex.get(id);
      if (cached) {
        resultMap.set(id, cached);
        this.#cache.set(id, cached); 
      } else {
        pendientes.push(id);
      }
    }

    if (pendientes.length === 0) return resultMap;

    try {
      const repo = this.#sock.signalRepository?.lidMapping;
      if (repo?.getPNsForLIDs) {
        const mapeosLote = await repo.getPNsForLIDs(pendientes);
        if (mapeosLote) {
          const entries = mapeosLote instanceof Map ? mapeosLote.entries() : Object.entries(mapeosLote);
          for (const [lid, pn] of entries) {
            if (pn) {
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
      }
    } catch (e) {
      console.warn(`[LidSync] Error signalRepository batch:`, e.message);
    }

    pendientes = pendientes.filter(id => !resultMap.has(id));

    for (let i = 0; i < pendientes.length; i += concurrency) {
      const chunk = pendientes.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (id) => {
        const res = await this.resolver(id);
        if (res) resultMap.set(id, res);
      }));
    }

    return resultMap;
  }

  destroy() {
    this.#cache.destroy();
    this.#reverseIndex.clear();
    this.#sock.ev.off("contacts.upsert", this.#handler);
    this.#sock.ev.off("contacts.update", this.#handler);
    this.#sock.ev.off("messages.upsert", this.#msgHandler);
    this.#sock.ev.off("lid-mapping.update", this.#lidMappingHandler);
    this.#sock.ev.off("messaging-history.set", this.#historyHandler);
  }
    }
