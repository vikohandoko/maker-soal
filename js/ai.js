// Koneksi ke Google Gemini (kuota gratis) + semua instruksi untuk AI.
// Hemat kuota: model cadangan otomatis, penghitung pemakaian harian, tugas ringan memakai model ringan.
const AI = (() => {
  const API = "https://generativelanguage.googleapis.com/v1beta";
  const DEFAULT_MODEL = "gemini-2.5-flash";
  const DEFAULT_LITE = "gemini-2.5-flash-lite";

  const store = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const settings = {
    get key() { return store.get("ms_key"); },
    set key(v) { store.set("ms_key", v.trim()); },
    get model() { return store.get("ms_model") || DEFAULT_MODEL; },
    set model(v) { store.set("ms_model", v); },
    // Model cadangan/ringan. "none" = tidak dipakai.
    get lite() { const v = store.get("ms_lite"); return v === "none" ? "" : v || DEFAULT_LITE; },
    set lite(v) { store.set("ms_lite", v || "none"); },
    get verify() { return store.get("ms_verify") !== "0"; },
    set verify(v) { store.set("ms_verify", v ? "1" : "0"); },
  };

  // ---------- Kuota ----------
  // Kuota harian Gemini direset tengah malam waktu Pasifik (≈ 14.00–15.00 WIB).
  const ptDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  function quota() {
    let s;
    try { s = JSON.parse(store.get("ms_quota") || "{}"); } catch { s = {}; }
    if (s.date !== ptDate()) s = { date: ptDate(), usage: {}, dayOut: {}, minuteOut: {}, missing: {} };
    return s;
  }
  const saveQuota = (s) => store.set("ms_quota", JSON.stringify(s));
  const available = (m, s) => !s.dayOut[m] && !s.missing[m] && !(s.minuteOut[m] > Date.now());
  function chain(tier) {
    const list = tier === "ringan" ? [settings.lite, settings.model] : [settings.model, settings.lite];
    return [...new Set(list.filter(Boolean))];
  }
  const QUOTA_MSG = "Kuota gratis harian semua model sudah habis. Kuota direset sekitar pukul 14.00–15.00 WIB. Sementara itu kamu tetap bisa review flashcard, mengerjakan soal yang tersimpan, dan latihan tanpa kuota.";

  // Aturan utama: hanya boleh memakai isi materi.
  const RULES = `Kamu adalah asisten belajar yang sangat teliti dan jujur.
ATURAN WAJIB:
1. Gunakan HANYA informasi yang tertulis di MATERI. Dilarang menambah fakta, angka, nama, contoh, atau referensi dari pengetahuan di luar materi — walaupun kamu yakin benar.
2. Jika suatu hal tidak ada di materi, katakan tidak ada. Jangan menebak.
3. Setiap "kutipan" harus disalin PERSIS kata per kata dari MATERI (bukan parafrase, bukan terjemahan), 8–30 kata, dari satu bagian yang berurutan.
4. Tulis dalam Bahasa Indonesia yang jelas. Istilah teknis tetap sesuai materi.
5. Jika materi mengandung kesalahan, tetap ikuti materi tetapi jangan membuat soal dari bagian yang meragukan.`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function callModel(model, body) {
    let r;
    try {
      r = await fetch(`${API}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": settings.key },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Tidak bisa terhubung ke internet / server Google.");
    }
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status === 503) {
      const det = j.error?.details || [];
      const ids = det.flatMap((d) => (d.violations || []).map((v) => v.quotaId || "")).join(" ");
      const perDay = /PerDay/i.test(ids) || /per.?day|daily/i.test(j.error?.message || "");
      const retry = parseInt(det.find((d) => d.retryDelay)?.retryDelay) || (r.status === 503 ? 10 : 30);
      throw Object.assign(new Error("quota"), { kind: perDay ? "day" : "minute", retry: Math.min(retry, 65) });
    }
    if (r.status === 404) throw Object.assign(new Error("missing"), { kind: "missing" });
    if (!r.ok) {
      const msg = j.error?.message || `HTTP ${r.status}`;
      if (/API key not valid|API_KEY_INVALID/i.test(msg)) throw new Error("API key tidak valid. Periksa lagi di Pengaturan.");
      throw new Error("Gemini menolak permintaan: " + msg);
    }
    return j;
  }

  async function call({ tier = "berat", system, contents, schema, temperature = 0.2, onStatus }) {
    if (!settings.key) throw new Error("API key Gemini belum diisi. Buka Pengaturan (ikon roda gigi).");
    const body = { contents, generationConfig: { temperature } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (schema) {
      body.generationConfig.responseMimeType = "application/json";
      body.generationConfig.responseSchema = schema;
    }
    const models = chain(tier);
    let badJson = 0;
    for (let round = 0; round < 8; round++) {
      const s = quota();
      const model = models.find((m) => available(m, s));
      if (!model) {
        if (models.every((m) => s.missing[m])) throw new Error("Model AI yang dipilih tidak tersedia. Pilih model lain di Pengaturan.");
        const waits = models.filter((m) => !s.dayOut[m] && !s.missing[m]).map((m) => s.minuteOut[m] - Date.now()).filter((x) => x > 0);
        if (!waits.length) throw new Error(QUOTA_MSG);
        const ms = Math.min(...waits, 65000);
        onStatus?.(`Batas per menit tercapai — menunggu ${Math.ceil(ms / 1000)} detik…`);
        await sleep(ms + 500);
        continue;
      }
      let j;
      try { j = await callModel(model, body); }
      catch (e) {
        if (!e.kind) throw e;
        const s2 = quota();
        if (e.kind === "day") s2.dayOut[model] = true;
        else if (e.kind === "missing") s2.missing[model] = true;
        else s2.minuteOut[model] = Date.now() + e.retry * 1000;
        saveQuota(s2);
        const next = models.find((m) => m !== model && available(m, s2));
        if (next) onStatus?.(e.kind === "day" ? `Kuota harian ${model} habis — pindah ke ${next}…` : `Pindah sementara ke ${next}…`);
        continue;
      }
      const s3 = quota();
      s3.usage[model] = (s3.usage[model] || 0) + 1;
      saveQuota(s3);

      const cand = j.candidates?.[0];
      if (!cand) throw new Error("AI tidak memberi jawaban" + (j.promptFeedback?.blockReason ? ` (diblokir: ${j.promptFeedback.blockReason})` : "") + ".");
      const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (cand.finishReason === "MAX_TOKENS" && schema) throw new Error("Jawaban AI terpotong karena terlalu panjang. Kurangi jumlah soal/kartu.");
      if (!schema) return text;
      try { return JSON.parse(text); }
      catch {
        const a = text.indexOf("{"), b = text.lastIndexOf("}");
        try { return JSON.parse(text.slice(a, b + 1)); } catch {}
        if (++badJson < 2) continue;
        throw new Error("Format jawaban AI rusak. Coba lagi.");
      }
    }
    throw new Error("Gagal mendapat jawaban dari AI. Coba lagi.");
  }

  const material = (doc) => doc.pages.map((p) => `[${p.label}]\n${p.text}`).join("\n\n");
  const userTurn = (doc, task) => [{ role: "user", parts: [{ text: `MATERI:\n"""\n${material(doc)}\n"""\n\nTUGAS:\n${task}` }] }];

  const S = (type, extra = {}) => ({ type, ...extra });
  const STR = S("STRING");
  const obj = (props, required = Object.keys(props)) => S("OBJECT", { properties: props, required });
  const arr = (items) => S("ARRAY", { items });
  const SOAL = obj({
    jenis: S("STRING", { enum: ["pilihan_ganda", "isian", "esai"] }),
    pertanyaan: STR, opsi: arr(STR), jawaban: STR, pembahasan: STR, kutipan: STR,
  });
  const KARTU = obj({ depan: STR, belakang: STR, kutipan: STR });
  const ISTILAH = obj({ istilah: STR, arti: STR, kutipan: STR });
  const TOPIK = obj({ judul: STR, deskripsi: STR, lokasi: arr(STR) });

  const SOAL_RULES = `- Setiap soal HARUS bisa dijawab hanya dengan membaca MATERI.
- pilihan_ganda: "opsi" berisi 4 pilihan TANPA awalan huruf; tepat SATU yang benar; pengecoh masuk akal tetapi jelas salah menurut materi; hindari "semua benar"/"semua salah". "jawaban" diisi huruf A/B/C/D.
- isian: "opsi" dikosongkan []; "jawaban" berupa kata/frasa singkat.
- esai: "opsi" dikosongkan []; "jawaban" berisi poin-poin jawaban ideal untuk penilaian.
- "pembahasan": jelaskan mengapa jawaban benar (untuk pilihan ganda, juga mengapa opsi lain salah), berdasarkan materi.
- "kutipan": kalimat persis dari MATERI yang membuktikan jawaban.`;
  const KARTU_RULES = `"depan": pertanyaan/istilah singkat (maks 15 kata); "belakang": jawaban singkat dan tepat MENURUT MATERI (maks 40 kata); "kutipan": kalimat persis dari MATERI yang mendukung.`;
  const PANJANG = { singkat: "sekitar 150–250 kata", sedang: "sekitar 300–600 kata", detail: "lengkap, mencakup semua konsep penting" };

  return {
    settings, DEFAULT_MODEL, DEFAULT_LITE,

    // Ringkasan pemakaian hari ini untuk ditampilkan
    usage() {
      const s = quota();
      const models = [...new Set([...chain("berat"), ...Object.keys(s.usage)])];
      return models.map((m) => ({
        model: m, n: s.usage[m] || 0,
        status: s.missing[m] ? "tidak tersedia" : s.dayOut[m] ? "habis hari ini" : s.minuteOut[m] > Date.now() ? "jeda sebentar" : "siap",
      }));
    },
    resetQuotaFlags() { const s = quota(); s.dayOut = {}; s.minuteOut = {}; s.missing = {}; saveQuota(s); },

    async listModels() {
      const r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": settings.key } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "Gagal memuat model");
      return (j.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/i.test(m.name) && !/embedding|tts|image|live|audio/i.test(m.name))
        .map((m) => ({ id: m.name.replace("models/", ""), name: m.displayName || m.name }));
    },

    async ocr(files, onStatus) {
      return call({
        onStatus, temperature: 0,
        contents: [{
          role: "user",
          parts: [
            ...files.map((f) => ({ inline_data: { mime_type: f.mime, data: f.data } })),
            { text: `Transkripsikan SELURUH teks pada dokumen/gambar di atas PERSIS apa adanya. Jangan meringkas, jangan menerjemahkan, jangan memperbaiki, jangan menambah.
Awali setiap halaman (atau setiap gambar) dengan baris penanda tersendiri: ===HALAMAN n=== (n mulai dari 1).
Tabel ditulis per baris dengan pemisah " | ". Rumus ditulis apa adanya. Untuk diagram/gambar tanpa teks tulis [gambar: keterangan singkat apa yang terlihat]. Tulisan yang tidak terbaca tulis [tidak terbaca].` },
          ],
        }],
      });
    },

    // Satu panggilan saat unggah: ringkasan + istilah + peta topik (hemat kuota).
    // Untuk materi panjang dipanggil per bagian (part), lalu ringkasannya digabung.
    async setup(doc, nT, onStatus, part) {
      return call({
        onStatus, system: RULES,
        contents: userTurn(doc, `${part ? `MATERI di atas adalah BAGIAN ${part.i} dari ${part.n} sebuah modul panjang (${part.range}). Kerjakan hanya untuk bagian ini.\n` : ""}Analisis materi lalu buat:
1. "judul": judul singkat materi${part ? " (bagian ini)" : ""}.
2. "ringkasan": ringkasan ${part ? "bagian ini, sekitar 200–400 kata," : `umum ${PANJANG.sedang}`} dalam Markdown dengan sub-judul (##) dan poin-poin. Di akhir setiap poin penting tulis rujukan lokasinya dalam kurung, contoh "(Halaman 3)", sesuai label di MATERI.
3. "istilah": istilah/konsep penting beserta artinya MENURUT MATERI, dengan "kutipan" persis.
4. "topik": pecah SELURUH materi menjadi sekitar ${nT} topik (boleh ${Math.max(2, nT - 2)}–${nT + 2}) BERURUTAN sesuai alur materi, sehingga setiap bagian materi masuk ke minimal satu topik. Tiap topik: "judul" singkat, "deskripsi" satu kalimat, "lokasi" = daftar label PERSIS seperti tertulis di MATERI (contoh "Halaman 3") yang membahas topik itu.`),
        schema: obj({ judul: STR, ringkasan: STR, istilah: arr(ISTILAH), topik: arr(TOPIK) }),
      });
    },

    // Gabungkan ringkasan per bagian menjadi satu ringkasan utuh (tanpa mengirim ulang materi lengkap)
    async mergeSummary(parts, detail, onStatus) {
      const pseudo = { pages: parts.map((p, i) => ({ label: `Ringkasan bagian ${i + 1} (${p.range})`, text: p.ringkasan })) };
      return call({
        onStatus, system: RULES,
        contents: userTurn(pseudo, `MATERI di atas berisi ringkasan dari setiap bagian sebuah modul panjang, berurutan.
Gabungkan menjadi SATU ringkasan utuh, panjang ${PANJANG[detail] || PANJANG.detail}, dalam Markdown dengan sub-judul (##) mengikuti alur modul dan poin-poin.
- Pertahankan rujukan lokasi asli seperti "(Halaman 37)" apa adanya. Jangan membuat rujukan baru.
- Jangan menambah informasi yang tidak ada di ringkasan-ringkasan tersebut.
- "judul": judul singkat untuk seluruh modul.`),
        schema: obj({ judul: STR, ringkasan: STR }),
      });
    },

    async summary(doc, detail, onStatus, part) {
      return call({
        onStatus, system: RULES,
        contents: userTurn(doc, `${part ? `MATERI di atas adalah BAGIAN ${part.i} dari ${part.n} sebuah modul panjang (${part.range}). Ringkas hanya bagian ini.\n` : ""}Buat ringkasan materi, panjang ${part ? "sekitar 200–400 kata" : PANJANG[detail]}.
- "judul": judul singkat materi.
- "ringkasan": format Markdown dengan sub-judul (##) dan poin-poin. Di akhir setiap poin penting tulis rujukan lokasinya dalam kurung, contoh "(Halaman 3)" atau "(Bagian 2)", sesuai label di MATERI.
- "istilah": istilah/konsep penting beserta artinya MENURUT MATERI, dengan "kutipan" persis yang mendukung.`),
        schema: obj({ judul: STR, ringkasan: STR, istilah: arr(ISTILAH) }),
      });
    },

    async topicMap(doc, nT, onStatus, part) {
      return call({
        onStatus, system: RULES,
        contents: userTurn(doc, `${part ? `MATERI di atas adalah BAGIAN ${part.i} dari ${part.n} sebuah modul panjang (${part.range}).\n` : ""}Pecah SELURUH materi menjadi sekitar ${nT} topik (boleh ${Math.max(2, nT - 2)}–${nT + 2}) BERURUTAN sesuai alur materi, sehingga setiap bagian materi masuk ke minimal satu topik. Tiap topik: "judul" singkat, "deskripsi" satu kalimat, "lokasi" = daftar label PERSIS seperti tertulis di MATERI (contoh "Halaman 3").`),
        schema: obj({ topik: arr(TOPIK) }),
      });
    },

    // Satu panggilan per topik: penjelasan + poin kunci + kartu + soal
    async topicPack(subDoc, topik, onStatus) {
      return call({
        onStatus, system: RULES, temperature: 0.3,
        contents: userTurn(subDoc, `Fokus HANYA pada topik: "${topik.judul}" — ${topik.deskripsi || ""}
Buat paket belajar:
- "penjelasan": penjelasan lengkap topik ini dalam Markdown (sub-judul ###, poin-poin, contoh dari materi bila ada). Tulis rujukan lokasi dalam kurung, contoh "(Halaman 3)".
- "poin_kunci": 3–6 poin terpenting topik ini, masing-masing dengan "kutipan" persis.
- "kartu": 4–8 flashcard. ${KARTU_RULES}
- "soal": tepat 4 soal (3 pilihan_ganda + 1 isian) tentang topik ini.
${SOAL_RULES}`),
        schema: obj({ penjelasan: STR, poin_kunci: arr(obj({ poin: STR, kutipan: STR })), kartu: arr(KARTU), soal: arr(SOAL) }),
      });
    },

    async quiz(doc, { jumlah, tingkat, jenis, fokus, hindari = [] }, onStatus) {
      const nama = { pilihan_ganda: "pilihan ganda (4 opsi)", isian: "isian singkat", esai: "esai/uraian" };
      return call({
        onStatus, system: RULES, temperature: 0.4,
        contents: userTurn(doc, `Buat tepat ${jumlah} soal latihan. Tingkat kesulitan: ${tingkat}. Jenis yang dipakai (bagi merata): ${jenis.map((j) => nama[j]).join(", ")}.
${fokus ? `Fokus: ${fokus}\n` : ""}Ketentuan:
- Sebar soal ke seluruh bagian MATERI, jangan menumpuk di satu bagian.
- Tingkat "mudah": mengingat fakta. "sedang": memahami & menerapkan. "sulit": menganalisis, membandingkan, menyimpulkan — tetap berdasarkan materi.
${SOAL_RULES}${hindari.length ? `
- WAJIB BARU: pelajar sudah pernah mengerjakan soal-soal di bawah. JANGAN membuat soal yang sama, mirip, atau sekadar diparafrasekan. Tanyakan fakta/konsep LAIN dari materi, atau sudut pandang berbeda (penerapan, perbandingan, sebab-akibat). Jika materi terbatas, boleh konsep sama tetapi dengan bentuk pertanyaan yang benar-benar berbeda.
SOAL YANG SUDAH PERNAH KELUAR:
${hindari.map((h) => "- " + h.slice(0, 160)).join("\n")}` : ""}`),
        schema: obj({ soal: arr(SOAL) }),
      });
    },

    // Pemeriksaan ulang: AI memeriksa setiap soal terhadap materi.
    async verifyQuiz(doc, soal, onStatus) {
      const list = soal.map((s, i) => ({
        nomor: i + 1, jenis: s.jenis, pertanyaan: s.pertanyaan,
        opsi: s.opsi?.map((o, k) => `${"ABCD"[k]}. ${o}`), jawaban: s.jawaban, kutipan: s.kutipan,
      }));
      return call({
        onStatus, temperature: 0,
        system: RULES + "\nKamu sekarang bertindak sebagai PEMERIKSA soal yang ketat.",
        contents: userTurn(doc, `Periksa setiap soal berikut TERHADAP MATERI:
${JSON.stringify(list, null, 1)}

Untuk setiap soal tentukan "status":
- "benar": soal jelas, bisa dijawab dari materi, kunci jawaban benar, (pilihan ganda) hanya satu opsi benar.
- "perbaiki": kunci jawaban atau pembahasan salah/kurang tetapi soal masih layak → isi "jawaban" dan "pembahasan" yang benar menurut materi.
- "buang": soal memakai info di luar materi, ambigu, punya lebih dari satu jawaban benar, atau tidak bisa dijawab dari materi.
Isi "alasan" singkat. Untuk status "benar" isi "jawaban" dan "pembahasan" dengan string kosong.`),
        schema: obj({
          hasil: arr(obj({
            nomor: S("INTEGER"), status: S("STRING", { enum: ["benar", "perbaiki", "buang"] }),
            alasan: STR, jawaban: STR, pembahasan: STR,
          })),
        }),
      });
    },

    async flashcards(doc, jumlah, existing, onStatus) {
      return call({
        tier: "ringan", onStatus, system: RULES, temperature: 0.3,
        contents: userTurn(doc, `Buat ${jumlah} flashcard untuk menghafal konsep penting dari materi. ${KARTU_RULES}
${existing.length ? `Jangan membuat kartu yang sama dengan yang sudah ada berikut:\n- ${existing.slice(0, 150).join("\n- ")}` : ""}`),
        schema: obj({ kartu: arr(KARTU) }),
      });
    },

    async chat(doc, history, onStatus, partial) {
      return call({
        tier: "ringan", onStatus, temperature: 0.2,
        system: `${RULES}
6. Kamu sedang menjawab pertanyaan pelajar tentang MATERI di bawah. Sebutkan lokasi sumbernya, contoh "(Halaman 3)".
7. Jika jawabannya tidak ada di materi, katakan dengan jelas: "${partial ? "Hal ini tidak ditemukan di halaman yang relevan dari materimu. Coba tanyakan dengan kata kunci lain yang ada di modul." : "Hal ini tidak dibahas di materi yang kamu unggah."}" Lalu boleh sebutkan bagian materi yang paling terkait.${partial ? "\n   (Catatan: modul ini panjang, jadi yang diberikan hanya halaman-halaman yang paling relevan dengan pertanyaan.)" : ""}
8. Boleh menjelaskan ulang dengan bahasa lebih sederhana atau memakai analogi sehari-hari, TETAPI tandai dengan "Analogi:" dan jangan menambah fakta baru.
9. Jawab ringkas dengan Markdown.

MATERI:
"""
${material(doc)}
"""`,
        contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      });
    },

    async feynman(doc, konsep, penjelasan, onStatus) {
      return call({
        onStatus, temperature: 0.2,
        system: RULES + "\nKamu adalah penilai pemahaman dengan metode Feynman: tegas, adil, dan membangun.",
        contents: userTurn(doc, `Pelajar mencoba menjelaskan konsep "${konsep}" dengan kata-katanya sendiri:
"""
${penjelasan}
"""
Nilai penjelasan itu HANYA berdasarkan MATERI:
- "skor": 0–100 seberapa tepat & lengkap dibanding materi.
- "ringkasan_penilaian": 1–2 kalimat.
- "sudah_benar": poin yang sudah tepat.
- "keliru": pernyataan pelajar yang salah menurut materi, beserta "koreksi" dan "kutipan" persis dari materi.
- "terlewat": poin penting di materi tentang konsep ini yang belum disebut, beserta "kutipan".
- "saran": saran singkat agar penjelasan lebih baik.
Jika konsep ini tidak dibahas di materi, beri skor 0 dan jelaskan di ringkasan_penilaian.`),
        schema: obj({
          skor: S("INTEGER"), ringkasan_penilaian: STR, sudah_benar: arr(STR),
          keliru: arr(obj({ pernyataan: STR, koreksi: STR, kutipan: STR })),
          terlewat: arr(obj({ poin: STR, kutipan: STR })), saran: STR,
        }),
      });
    },
  };
})();
