import Database from "better-sqlite3";

export class LidDatabase {
  #db;
  #insert;

  constructor(path = "lidsync.db") {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS lids (lid TEXT PRIMARY KEY, jid TEXT NOT NULL, timestamp INTEGER)"
    );
    this.#insert = this.#db.prepare(
      "INSERT INTO lids (lid, jid, timestamp) VALUES (?, ?, ?) ON CONFLICT(lid) DO UPDATE SET jid = excluded.jid, timestamp = excluded.timestamp"
    );
  }

  save(pares) {
    if (!Array.isArray(pares) || !pares.length) return;
    const now = Date.now();
    this.#db.transaction((items) => {
      for (const p of items) {
        const lid = p.lid || p[0];
        const jid = p.pn || p.jid || p[1];
        if (lid && jid) this.#insert.run(lid, jid, now);
      }
    })(pares);
  }

  load() {
    return this.#db.prepare("SELECT lid, jid FROM lids").all();
  }

  close() {
    this.#db.close();
  }
}
