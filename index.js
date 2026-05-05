import { LidResolver } from "./src/resolver.js";
import { LidDatabase } from "./src/sqlite.js";

export function pluginLid(sock, options = {}) {
  const resolver = new LidResolver(sock, options);

  sock.lid = {
    resolve: async (id) => resolver.resolver(id).catch(() => null),
    resolveBatch: async (ids, opts) => {
      if (!ids?.[Symbol.iterator]) return new Map();
      return resolver.resolverLote(ids, opts).catch(() => new Map());
    },
    resolveParticipants: async (participants) => resolver.resolverParticipantes(participants).catch(() => new Map()),
    preload: (pares) => pares && resolver.precargarCache(pares),
    getStats: () => resolver.getStats(),
    isResolvable: (id) => resolver.esResolvable(id),
    syncStore: (forzar = false) => resolver.sincronizarDesdeStore(forzar),
    destroy: () => resolver.destroy(),
    onJoin: (callback) => resolver.onJoin(callback),
  };

  return sock;
}

export { LidResolver } from "./src/resolver.js";
export { LidDatabase } from "./src/sqlite.js";
