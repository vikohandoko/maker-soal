// Penyimpanan lokal di browser (IndexedDB) — semua data tetap di perangkat kamu.
//  - "docs":  materi (teks, soal, kartu, kemajuan)
//  - "files": file asli (PDF) & gambar halaman, untuk menampilkan halaman asli (tabel, diagram).
//             Kunci: "<docId>|pdf|<namaFile>" atau "<docId>|img|<label>". Tidak ikut diekspor.
//  - "exams": simulasi ujian per folder mata kuliah (soal, jawaban, nilai)
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open("maker-soal", 3);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
          if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
          if (!db.objectStoreNames.contains("exams")) db.createObjectStore("exams", { keyPath: "id" });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Penyimpanan browser penuh atau ditolak."));
    });
  }
  const range = (docId) => IDBKeyRange.bound(docId + "|", docId + "|￿");
  return {
    all: () => tx("docs", "readonly", (s) => s.getAll()),
    get: (id) => tx("docs", "readonly", (s) => s.get(id)),
    put: (doc) => tx("docs", "readwrite", (s) => s.put(doc)),
    del: async (id) => {
      await tx("docs", "readwrite", (s) => s.delete(id));
      await tx("files", "readwrite", (s) => s.delete(range(id)));
    },
    exams: {
      all: () => tx("exams", "readonly", (s) => s.getAll()),
      get: (id) => tx("exams", "readonly", (s) => s.get(id)),
      put: (e) => tx("exams", "readwrite", (s) => s.put(e)),
      del: (id) => tx("exams", "readwrite", (s) => s.delete(id)),
    },
    files: {
      put: (key, blob) => tx("files", "readwrite", (s) => s.put(blob, key)),
      get: (key) => tx("files", "readonly", (s) => s.get(key)),
      count: (docId) => tx("files", "readonly", (s) => s.count(range(docId))),
    },
  };
})();

// Minta browser agar data tidak dihapus otomatis saat ruang penyimpanan menipis
try { navigator.storage?.persist?.(); } catch {}
