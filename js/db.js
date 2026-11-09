// Penyimpanan lokal di browser (IndexedDB) — semua data tetap di perangkat kamu.
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open("maker-soal", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("docs", { keyPath: "id" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("docs", mode);
      const req = fn(t.objectStore("docs"));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    all: () => tx("readonly", (s) => s.getAll()),
    get: (id) => tx("readonly", (s) => s.get(id)),
    put: (doc) => tx("readwrite", (s) => s.put(doc)),
    del: (id) => tx("readwrite", (s) => s.delete(id)),
  };
})();
