// Koneksi AI: Google Gemini (utama) + penyedia cadangan opsional (Groq, OpenRouter).
// Hemat kuota: banyak model bergiliran (masing-masing punya kuota sendiri), penghitung pemakaian,
// tugas ringan memakai model ringan, dan permintaan yang terlalu besar untuk suatu model langsung dilewati.
const AI = (() => {
  const API = "https://generativelanguage.googleapis.com/v1beta";
  const DEFAULT_MODEL = "gemini-2.5-flash";
  const DEFAULT_LITE = "gemini-2.5-flash-lite";

  // Penyedia cadangan berformat OpenAI (bisa dipanggil langsung dari browser)
  const PROVIDERS = {
    groq: { name: "Groq", url: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", json: true },
    openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", json: false },
  };

  const store = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const jget = (k, d) => { try { return JSON.parse(store.get(k)) ?? d; } catch { return d; } };

  const settings = {
    get key() { return store.get("ms_key"); },
    set key(v) { store.set("ms_key", v.trim()); },
    // Daftar model Gemini yang dipakai, berurutan (utama dulu). Versi lama: ms_model + ms_lite.
    get gemini() {
      const list = jget("ms_gmodels", null);
      if (Array.isArray(list) && list.length) return list;
      const lite = store.get("ms_lite");
      return [store.get("ms_model") || DEFAULT_MODEL, lite === "none" ? "" : lite || DEFAULT_LITE].filter(Boolean);
    },
    set gemini(list) { store.set("ms_gmodels", JSON.stringify(list)); },
    get model() { return this.gemini[0] || DEFAULT_MODEL; }, // kompatibilitas
    // { groq: {key, models:[]}, openrouter: {key, models:[]} }
    get providers() { return jget("ms_prov", {}); },
    set providers(v) { store.set("ms_prov", JSON.stringify(v)); },
    get verify() { return store.get("ms_verify") !== "0"; },
    set verify(v) { store.set("ms_verify", v ? "1" : "0"); },
  };

  // ---------- Kuota ----------
  // Gemini direset tengah malam waktu Pasifik (≈ 14.00–15.00 WIB); Groq/OpenRouter tengah malam UTC (07.00 WIB).
  const ptDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const utcDate = () => new Date().toISOString().slice(0, 10);
  const provOf = (key) => key.split(":")[0];
  const dateFor = (key) => (provOf(key) === "gemini" ? ptDate() : utcDate());
  function quota() {
    let s;
    try { s = JSON.parse(store.get("ms_quota") || "{}"); } catch { s = {}; }
    if (s.date || !s.v) s = { v: 2, usage: {}, dayOut: {}, minuteOut: {}, missing: {}, tooBig: {} }; // format lama → mulai baru
    for (const k of Object.keys(s.usage)) if (s.usage[k].d !== dateFor(k)) delete s.usage[k];
    for (const k of Object.keys(s.dayOut)) if (s.dayOut[k] !== dateFor(k)) delete s.dayOut[k];
    for (const k of Object.keys(s.tooBig)) if (s.tooBig[k].d !== dateFor(k)) delete s.tooBig[k];
    return s;
  }
  const saveQuota = (s) => store.set("ms_quota", JSON.stringify(s));
  const available = (k, s, size) =>
    !s.dayOut[k] && !s.missing[k] && !(s.minuteOut[k] > Date.now()) && !(s.tooBig[k] && size >= s.tooBig[k].n * 0.9);

  // Rantai model: "berat" = Gemini dulu; "ringan" = Groq dulu (hemat Gemini untuk OCR & tugas berat).
  // Tugas bergambar (OCR) hanya bisa memakai Gemini.
  function chain(tier, vision) {
    const g = settings.gemini.map((m) => `gemini:${m}`);
    const gLiteFirst = [...g].sort((a, b) => /lite/i.test(b) - /lite/i.test(a));
    if (vision) return g;
    const p = settings.providers;
    const extra = (id) => (p[id]?.key ? (p[id].models || []).map((m) => `${id}:${m}`) : []);
    const list = tier === "ringan"
      ? [...extra("groq"), ...gLiteFirst, ...extra("openrouter")]
      : [...g, ...extra("groq"), ...extra("openrouter")];
    return [...new Set(list)];
  }
  const label = (k) => { const [p, ...m] = k.split(":"); return `${p === "gemini" ? "Gemini" : PROVIDERS[p]?.name || p} · ${m.join(":")}`; };
  const QUOTA_MSG = "Kuota gratis harian semua model sudah habis. Kuota Gemini direset sekitar pukul 14.00–15.00 WIB (Groq/OpenRouter pukul 07.00 WIB). Sementara itu kamu tetap bisa review flashcard, mengerjakan soal yang tersimpan, dan latihan tanpa kuota.";

  // Aturan utama: hanya boleh memakai isi materi.
  const RULES = `Kamu adalah asisten belajar yang sangat teliti dan jujur.
ATURAN WAJIB:
1. Gunakan HANYA informasi yang tertulis di MATERI. Dilarang menambah fakta, angka, nama, contoh, atau referensi dari pengetahuan di luar materi — walaupun kamu yakin benar.
2. Jika suatu hal tidak ada di materi, katakan tidak ada. Jangan menebak.
3. Setiap "kutipan" harus disalin PERSIS kata per kata dari MATERI (bukan parafrase, bukan terjemahan), 8–30 kata, dari satu bagian yang berurutan.
4. Tulis dalam Bahasa Indonesia yang jelas. Istilah teknis tetap sesuai materi.
5. Jika materi mengandung kesalahan, tetap ikuti materi tetapi jangan membuat soal dari bagian yang meragukan.`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const quotaErr = (kind, retry = 30) => Object.assign(new Error(kind), { kind, retry: Math.min(retry, 65) });

  // Setiap permintaan punya batas waktu (server kadang tidak menjawab sama sekali) dan bisa dihentikan pengguna.
  const active = new Set();
  let cancelled = false;
  async function fetchJson(url, opt, ms) {
    const ctrl = new AbortController();
    active.add(ctrl);
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opt, signal: ctrl.signal });
      const j = await r.json().catch((e) => { if (ctrl.signal.aborted) throw e; return {}; });
      return { r, j };
    } catch (e) {
      if (cancelled) throw Object.assign(new Error("Dihentikan."), { cancel: true });
      if (ctrl.signal.aborted) throw quotaErr("slow", 30);
      throw e;
    } finally { clearTimeout(t); active.delete(ctrl); }
  }

  // Deteksi AI yang terjebak mengulang hal yang sama tanpa akhir (sering terjadi saat OCR tabel).
  // Mengembalikan teks yang sudah dipotong sebelum bagian berulang, atau null jika tidak ada pengulangan.
  function cutLoop(t) {
    const tail = t.slice(-3000);
    const m = tail.match(/(.{2,100}?)\1{20,}\s*$/s);
    if (m && m[0].length >= 400) return t.slice(0, t.length - m[0].length + m[1].length); // ≥400 karakter: titik-titik daftar isi tidak ikut terpotong
    const lines = t.split("\n");
    const recent = lines.map((x) => x.trim()).filter(Boolean).slice(-40);
    if (recent.length < 40) return null;
    const set = new Set(recent);
    if (set.size > 4) return null;
    while (lines.length && (!lines[lines.length - 1].trim() || set.has(lines[lines.length - 1].trim()))) lines.pop();
    return lines.join("\n");
  }

  // Gemini streaming (untuk OCR): kemajuan terlihat, batas waktu dihitung dari "diam" (bukan total), pengulangan dipotong.
  async function streamGemini(url, opt, onProgress) {
    const ctrl = new AbortController();
    active.add(ctrl);
    let idle;
    const arm = (ms) => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), ms); };
    const hard = setTimeout(() => ctrl.abort(), 300000);
    let r, text = "", finish = "", block = "";
    arm(90000);
    try {
      r = await fetch(url, { ...opt, signal: ctrl.signal });
      if (!r.ok) return { r, j: await r.json().catch(() => ({})) };
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", n = 0;
      for (;;) {
        arm(60000);
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k).trim();
          buf = buf.slice(k + 1);
          if (!line.startsWith("data:")) continue;
          let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
          if (d.promptFeedback?.blockReason) block = d.promptFeedback.blockReason;
          const c = d.candidates?.[0];
          if (c) {
            text += (c.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
            if (c.finishReason) finish = c.finishReason;
          }
        }
        onProgress?.(text.length);
        if (++n % 3 === 0 && text.length > 1500) {
          const cut = cutLoop(text);
          if (cut !== null) { reader.cancel().catch(() => {}); return { r, text: cut, finish: "LOOP" }; }
        }
      }
      return { r, text, finish, block };
    } catch (e) {
      if (cancelled) throw Object.assign(new Error("Dihentikan."), { cancel: true });
      if (ctrl.signal.aborted) {
        if (text.trim()) return { r, text, finish: "STOPPED" }; // sebagian sudah diterima → pakai yang ada
        throw quotaErr("slow", 30);
      }
      throw e;
    } finally { clearTimeout(idle); clearTimeout(hard); active.delete(ctrl); }
  }

  // ----- Gemini -----
  async function callGemini(model, req) {
    const body = { contents: req.contents, generationConfig: { temperature: req.temperature } };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.schema) { body.generationConfig.responseMimeType = "application/json"; body.generationConfig.responseSchema = req.schema; }
    // OCR tidak butuh "berpikir": matikan agar jauh lebih cepat (hanya model 2.5 Flash/Flash-Lite yang bisa dimatikan)
    if (req.fast && /2\.5-flash/i.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const opt = { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": settings.key }, body: JSON.stringify(body) };
    let r, j, st = null;
    try {
      if (req.stream) { st = await streamGemini(`${API}/models/${model}:streamGenerateContent?alt=sse`, opt, req.onProgress); r = st.r; j = st.j || {}; }
      else ({ r, j } = await fetchJson(`${API}/models/${model}:generateContent`, opt, req.vision ? 180000 : 300000));
    } catch (e) { if (e.kind || e.cancel) throw e; throw new Error("Tidak bisa terhubung ke internet / server Google."); }
    if (st && r.ok) {
      if (!st.text && st.block) throw new Error(`AI tidak memberi jawaban (diblokir: ${st.block}).`);
      let text = st.text;
      // Jawaban terpotong/berulang: buang halaman terakhir yang belum lengkap (nanti dibaca ulang)
      if (["LOOP", "STOPPED", "MAX_TOKENS"].includes(st.finish)) {
        const marks = [...text.matchAll(/===\s*HALAMAN\s*\d+\s*===/gi)];
        if (req.pages > 1 && marks.length > 1) text = text.slice(0, marks[marks.length - 1].index);
        else text += "\n[sebagian tidak terbaca]";
      }
      return { text, truncated: false };
    }
    if (r.status === 429 || r.status === 503) {
      const det = j.error?.details || [];
      const ids = det.flatMap((d) => (d.violations || []).map((v) => v.quotaId || "")).join(" ");
      const perDay = /PerDay/i.test(ids) || /per.?day|daily/i.test(j.error?.message || "");
      throw quotaErr(perDay ? "day" : "minute", parseInt(det.find((d) => d.retryDelay)?.retryDelay) || (r.status === 503 ? 10 : 30));
    }
    if (r.status === 404) throw quotaErr("missing");
    if (!r.ok) {
      const msg = j.error?.message || `HTTP ${r.status}`;
      if (/API key not valid|API_KEY_INVALID/i.test(msg)) throw new Error("API key Gemini tidak valid. Periksa lagi di Pengaturan.");
      if (/token count|too large|exceeds/i.test(msg)) throw quotaErr("size");
      throw new Error("Gemini menolak permintaan: " + msg);
    }
    const cand = j.candidates?.[0];
    if (!cand) throw new Error("AI tidak memberi jawaban" + (j.promptFeedback?.blockReason ? ` (diblokir: ${j.promptFeedback.blockReason})` : "") + ".");
    return { text: (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join(""), truncated: cand.finishReason === "MAX_TOKENS" };
  }

  // ----- Groq / OpenRouter (format OpenAI) -----
  // Skema Gemini (tipe huruf besar) → JSON Schema biasa, dipakai sebagai petunjuk format di prompt
  const toJsonSchema = (s) => {
    const o = { type: s.type.toLowerCase() };
    if (s.enum) o.enum = s.enum;
    if (s.properties) { o.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)])); o.required = s.required; }
    if (s.items) o.items = toJsonSchema(s.items);
    return o;
  };
  async function callOpenAI(pid, model, req) {
    const P = PROVIDERS[pid], key = settings.providers[pid]?.key;
    let system = req.system || "";
    if (req.schema) system += `\n\nFORMAT JAWABAN: keluarkan HANYA satu objek JSON valid (tanpa teks lain, tanpa \`\`\`) yang sesuai JSON Schema berikut:\n${JSON.stringify(toJsonSchema(req.schema))}`;
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...req.contents.map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: c.parts.map((p) => p.text || "").join("\n") })),
    ];
    const body = { model, messages, temperature: req.temperature, max_tokens: 8000 };
    if (req.schema && P.json) body.response_format = { type: "json_object" };
    let r, j;
    try {
      ({ r, j } = await fetchJson(`${P.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(pid === "openrouter" ? { "X-Title": "Maker Soal" } : {}) },
        body: JSON.stringify(body),
      }, 240000));
    } catch (e) { if (e.kind || e.cancel) throw e; throw new Error(`Tidak bisa terhubung ke ${P.name}.`); }
    const msg = j.error?.message || j.message || `HTTP ${r.status}`;
    if (r.status === 413 || /too large|context length|maximum context|reduce the length|tokens per minute|TPM/i.test(msg)) throw quotaErr("size");
    if (r.status === 429 || r.status === 402) {
      const perDay = r.status === 402 || /per.?day|daily|RPD|TPD|free-models-per-day/i.test(msg);
      throw quotaErr(perDay ? "day" : "minute", parseInt(r.headers.get("retry-after")) || 20);
    }
    if (r.status >= 500) throw quotaErr("minute", 10);
    if (r.status === 401 || r.status === 403) throw Object.assign(quotaErr("missing"), { auth: true, reason: "key ditolak — periksa Pengaturan" }); // lewati SEMUA model penyedia ini
    if (/data policy|privacy/i.test(msg)) throw Object.assign(quotaErr("missing"), { reason: "perlu izin: aktifkan model gratis di openrouter.ai/settings/privacy" });
    if (r.status === 404 || /model.*(not found|does not exist|decommission|not available)/i.test(msg)) throw quotaErr("missing");
    if (!r.ok) {
      if (/json/i.test(msg)) return { text: "", truncated: false }; // mode JSON gagal → anggap format rusak, coba lagi
      throw new Error(`${P.name} menolak permintaan: ${msg}`);
    }
    const ch = j.choices?.[0];
    let text = ch?.message?.content;
    if (Array.isArray(text)) text = text.map((x) => x.text || "").join("");
    text = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return { text, truncated: ch?.finish_reason === "length" };
  }

  async function call({ tier = "berat", system, contents, schema, temperature = 0.2, onStatus, fast = false, stream = false }) {
    if (!settings.key) throw new Error("API key Gemini belum diisi. Buka Pengaturan (ikon roda gigi).");
    cancelled = false;
    const vision = contents.some((c) => c.parts.some((p) => p.inline_data));
    const size = (system || "").length + contents.reduce((n, c) => n + c.parts.reduce((m, p) => m + (p.text || "").length, 0), 0);
    const pages = contents.reduce((n, c) => n + c.parts.filter((p) => p.inline_data).length, 0);
    const req = { system, contents, schema, temperature, fast, vision, stream, pages };
    const models = chain(tier, vision);
    const bad = new Map(); // format JSON rusak per model (percobaan ini saja)
    for (let round = 0; round < 14; round++) {
      const s = quota();
      const key = models.find((k) => available(k, s, size) && (bad.get(k) || 0) < 2);
      if (!key) {
        if (models.every((k) => s.missing[k])) throw new Error("Semua model AI yang dipilih tidak tersedia atau key-nya ditolak. Periksa Pengaturan.");
        if (models.every((k) => s.missing[k] || s.dayOut[k] || (s.tooBig[k] && size >= s.tooBig[k].n * 0.9) || (bad.get(k) || 0) >= 2)) {
          if (models.some((k) => (bad.get(k) || 0) >= 2)) throw new Error("Format jawaban AI rusak. Coba lagi.");
          throw new Error(QUOTA_MSG);
        }
        const waits = models.map((k) => s.minuteOut[k] - Date.now()).filter((x) => x > 0);
        const ms = Math.min(...waits, 65000);
        onStatus?.(`Batas per menit tercapai di semua model — menunggu ${Math.ceil(ms / 1000)} detik…`);
        await sleep(ms + 500);
        if (cancelled) throw Object.assign(new Error("Dihentikan."), { cancel: true });
        continue;
      }
      const [pid, ...rest] = key.split(":");
      const model = rest.join(":");
      let res;
      req.onProgress = onStatus && ((n) => onStatus(`${label(key)} · ${n.toLocaleString("id-ID")} karakter diterima`));
      try { res = pid === "gemini" ? await callGemini(model, req) : await callOpenAI(pid, model, req); }
      catch (e) {
        if (!e.kind) throw e;
        const s2 = quota();
        if (e.kind === "day") s2.dayOut[key] = dateFor(key);
        else if (e.kind === "missing") {
          s2.missing[key] = e.reason || true;
          if (e.auth) for (const k of models) if (k.startsWith(pid + ":")) s2.missing[k] = e.reason; // key salah berlaku untuk semua modelnya
        }
        else if (e.kind === "size") s2.tooBig[key] = { n: Math.min(size, s2.tooBig[key]?.n ?? Infinity), d: dateFor(key) };
        else s2.minuteOut[key] = Date.now() + e.retry * 1000;
        if (pid !== "gemini" && e.kind !== "size") s2.usage[key] = { d: dateFor(key), n: (s2.usage[key]?.n || 0) + 1 }; // OpenRouter menghitung permintaan gagal
        saveQuota(s2);
        const next = models.find((k) => k !== key && available(k, s2, size));
        const why = { day: "kuota harian habis", minute: "sedang sibuk/batas per menit", missing: "tidak tersedia", size: "materi terlalu besar untuk model ini", slow: "terlalu lama tidak menjawab" }[e.kind];
        onStatus?.(next ? `${label(key)}: ${why} — pindah ke ${label(next)}…` : `${label(key)}: ${why} — mencoba lagi…`);
        continue;
      }
      const s3 = quota();
      s3.usage[key] = { d: dateFor(key), n: (s3.usage[key]?.n || 0) + 1 };
      saveQuota(s3);
      if (res.truncated && schema) throw new Error("Jawaban AI terpotong karena terlalu panjang. Kurangi jumlah soal/kartu.");
      if (!schema) { if (res.text) return res.text; bad.set(key, (bad.get(key) || 0) + 1); continue; }
      const t = res.text.replace(/^```(?:json)?\s*|\s*```$/g, "");
      try { return JSON.parse(t); }
      catch {
        const a = t.indexOf("{"), b = t.lastIndexOf("}");
        try { return JSON.parse(t.slice(a, b + 1)); } catch {}
        bad.set(key, (bad.get(key) || 0) + 1);
        onStatus?.(`Format jawaban ${label(key)} rusak — mencoba lagi…`);
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
    settings, DEFAULT_MODEL, DEFAULT_LITE, PROVIDERS, label,

    // Ringkasan pemakaian hari ini untuk ditampilkan (semua model dalam rantai + yang pernah dipakai)
    usage() {
      const s = quota();
      const keys = [...new Set([...chain("berat"), ...Object.keys(s.usage)])];
      return keys.map((k) => ({
        key: k, model: label(k), n: s.usage[k]?.n || 0,
        status: s.missing[k] ? (typeof s.missing[k] === "string" ? s.missing[k] : "tidak tersedia") : s.dayOut[k] ? "habis hari ini" : s.minuteOut[k] > Date.now() ? "jeda sebentar" : "siap",
        tooBig: !!s.tooBig[k],
      }));
    },
    cancel() { cancelled = true; active.forEach((c) => c.abort()); },
    resetQuotaFlags() { const s = quota(); s.dayOut = {}; s.minuteOut = {}; s.missing = {}; s.tooBig = {}; saveQuota(s); },

    async listModels(key = settings.key) {
      const r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "Gagal memuat model");
      return (j.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/i.test(m.name) && !/embedding|tts|image|live|audio|robotics|computer-use/i.test(m.name))
        .map((m) => ({ id: m.name.replace("models/", ""), name: m.displayName || m.name }));
    },

    // Daftar model chat dari Groq / OpenRouter (OpenRouter: hanya yang gratis)
    async listProviderModels(pid, key) {
      const P = PROVIDERS[pid];
      const r = await fetch(`${P.url}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 401 ? `API key ${P.name} tidak valid.` : j.error?.message || `Gagal memuat model ${P.name}`);
      let list = j.data || [];
      if (pid === "openrouter") {
        list = list.filter((m) => (m.id.endsWith(":free") || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0))
          && (m.architecture?.output_modalities || ["text"]).every((x) => x === "text") // hanya model teks (bukan musik/gambar)
          && (m.context_length || 0) >= 32000);
      } else {
        list = list.filter((m) => m.active !== false && !/whisper|tts|guard|playai|orpheus|distil|embed|compound/i.test(m.id));
      }
      return list.map((m) => ({ id: m.id, name: m.name || m.id, ctx: m.context_length || m.context_window || 0 }))
        .sort((a, b) => (b.ctx - a.ctx) || a.id.localeCompare(b.id));
    },
    // Cek cepat apakah key penyedia bisa dipakai (Groq: daftar model butuh key; OpenRouter: cek /key)
    async checkProviderKey(pid, key) {
      const url = pid === "openrouter" ? `${PROVIDERS.openrouter.url}/key` : `${PROVIDERS[pid].url}/models`;
      const r = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
      if (!r.ok) throw new Error(`API key ${PROVIDERS[pid].name} tidak valid (HTTP ${r.status}).`);
      return true;
    },

    async ocr(files, onStatus) {
      return call({
        onStatus, temperature: 0, fast: true, stream: true,
        contents: [{
          role: "user",
          parts: [
            ...files.map((f) => ({ inline_data: { mime_type: f.mime, data: f.data } })),
            { text: `Transkripsikan SELURUH teks pada dokumen/gambar di atas PERSIS apa adanya. Jangan meringkas, jangan menerjemahkan, jangan memperbaiki, jangan menambah.
Awali setiap halaman (atau setiap gambar) dengan baris penanda tersendiri: ===HALAMAN n=== (n mulai dari 1).
TABEL: tulis sebagai tabel Markdown yang utuh — baris judul kolom, baris pemisah |---|---|, lalu satu baris tabel per baris; isi setiap sel persis seperti aslinya (sel kosong biarkan kosong, sel gabungan ulangi isinya). Beri satu baris kosong sebelum dan sesudah tabel.
DIAGRAM/BAGAN/SKEMA/GAMBAR: salin semua tulisan/label di dalamnya, lalu jelaskan isinya dalam format [diagram: ...] — sebutkan jenisnya (alur, hierarki, siklus, perbandingan, peta konsep, grafik) dan hubungan antar-bagiannya secara lengkap, misalnya "A → B → C", "X terbagi menjadi Y dan Z", atau nilai pada grafik. Jangan menambah informasi yang tidak tampak di gambar. Foto/ilustrasi tanpa informasi penting cukup ditulis [gambar: keterangan singkat].
Rumus ditulis apa adanya. Tulisan yang tidak terbaca tulis [tidak terbaca].
Jika gambar berupa SCREENSHOT layar HP/komputer dari aplikasi pembaca buku digital: salin HANYA isi halaman buku/modul. Abaikan elemen antarmuka seperti status bar (jam, baterai, sinyal), tombol, menu, bilah navigasi, kotak pencarian, nomor halaman milik aplikasi, dan notifikasi.
Jika sebuah gambar tidak berisi teks sama sekali, tetap tulis penandanya lalu [halaman kosong].` },
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
    // Paket belajar untuk 1–3 topik sekaligus (hemat kuota): penjelasan + poin kunci + kartu + soal per topik
    async topicPacks(subDoc, topics, onStatus) {
      const multi = topics.length > 1;
      return call({
        onStatus, system: RULES, temperature: 0.3,
        contents: userTurn(subDoc, `Buat paket belajar untuk ${multi ? `${topics.length} topik berikut, MASING-MASING terpisah` : "topik berikut"}:
${topics.map((t, i) => `${i + 1}. "${t.judul}" — ${t.deskripsi || ""}${t.lokasi?.length ? ` (lokasi: ${t.lokasi.join(", ")})` : ""}`).join("\n")}

Untuk SETIAP topik buat satu objek di "paket" dengan "nomor" sesuai daftar di atas, berisi:
- "penjelasan": penjelasan lengkap topik itu dalam Markdown (sub-judul ###, poin-poin, contoh dari materi bila ada). Tulis rujukan lokasi dalam kurung, contoh "(Halaman 3)". Jika materi topik memuat TABEL, sajikan ulang sebagai tabel Markdown (isi sesuai materi). Jika ada DIAGRAM (ditandai [diagram: ...]), jelaskan alur/hubungannya dengan jelas, boleh memakai panah (A → B → C).
- "poin_kunci": 3–6 poin terpenting topik itu, masing-masing dengan "kutipan" persis.
- "kartu": 4–6 flashcard. ${KARTU_RULES}
- "soal": tepat 4 soal (3 pilihan_ganda + 1 isian) tentang topik itu saja.
${multi ? "Jangan mencampur isi antar-topik; setiap paket hanya membahas topiknya sendiri.\n" : ""}${SOAL_RULES}`),
        schema: obj({
          paket: arr(obj({
            nomor: S("INTEGER"), penjelasan: STR,
            poin_kunci: arr(obj({ poin: STR, kutipan: STR })), kartu: arr(KARTU), soal: arr(SOAL),
          })),
        }),
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

    // Simulasi ujian: MATERI berisi beberapa modul (label "[Modul X · Halaman N]"), jumlah soal ditentukan per modul
    async exam(doc, dist, { tingkat, jenis }, hindari = [], onStatus) {
      const nama = { pilihan_ganda: "pilihan ganda (4 opsi)", isian: "isian singkat" };
      const names = dist.map((d) => d.name);
      return call({
        onStatus, system: RULES, temperature: 0.4,
        contents: userTurn(doc, `MATERI di atas berisi beberapa MODUL; setiap bagian diberi label "[<nama modul> · <lokasi>]".
Buat soal SIMULASI UJIAN akhir semester dengan pembagian TEPAT seperti ini:
${dist.map((d) => `- ${d.name}: ${d.k} soal`).join("\n")}
Tingkat kesulitan: ${tingkat}. Jenis soal: ${jenis.map((j) => nama[j]).join(", ")}${jenis.length > 1 ? " (utamakan pilihan ganda, sekitar 70%)" : ""}.
Ketentuan:
- Setiap soal hanya boleh memakai isi modul yang disebut di "modul" (isi persis salah satu: ${names.map((n) => `"${n}"`).join(", ")}).
- Sebar soal ke berbagai bagian setiap modul; tanyakan konsep penting, bukan detail remeh.
- Gaya soal seperti ujian universitas: jelas, tidak ambigu, pengecoh masuk akal.
${SOAL_RULES}${hindari.length ? `
- WAJIB BARU: JANGAN membuat soal yang sama/mirip dengan soal yang pernah keluar berikut:
${hindari.map((h) => "- " + h.slice(0, 140)).join("\n")}` : ""}`),
        schema: obj({ soal: arr(obj({ ...SOAL.properties, modul: S("STRING", { enum: names }) })) }),
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
9. Jawab ringkas dengan Markdown. Untuk perbandingan atau data dari tabel di materi, boleh menyajikan tabel Markdown.

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
