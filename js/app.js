// Maker Soal — logika tampilan & fitur
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (s) => DOMPurify.sanitize(marked.parse(s || ""));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const DAY = 864e5;
const fmtDate = (t) => new Date(t).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const calls = (n) => `<span class="small muted">Memakai ±${n} panggilan AI</span>`;

const state = {
  view: "home", doc: null, tab: "belajar", topicId: null,
  quizId: null, answers: {}, revealAll: false, tAnswers: {},
  local: null, review: null, chatBusy: false, feyPrefill: "",
};

// ---------- Utilitas UI ----------
let toastTimer;
function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "err" ? 8000 : 3500);
}
async function run(text, fn) {
  const box = document.getElementById("busy"), label = document.getElementById("busyText");
  label.textContent = text;
  box.hidden = false;
  try { return await fn((s) => (label.textContent = s)); }
  catch (e) { console.error(e); toast(e.message || String(e), "err"); }
  finally { box.hidden = true; }
}
function openModal(html) {
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modal").hidden = false;
}
function closeModal() { document.getElementById("modal").hidden = true; }
document.getElementById("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
const keepScroll = (fn) => { const y = scrollY; fn(); scrollTo(0, y); };

async function save() { if (state.doc) await DB.put(state.doc); }

// Lencana sumber: hijau = kutipan persis ada di file, kuning = hampir sama, merah = tidak ditemukan
function cite(c, quote) {
  if (!c) return "";
  const cls = { ok: "ok", mirip: "warn", tidak: "bad" }[c.status];
  const txt = c.status === "ok" ? `Sumber terverifikasi · ${c.label}`
    : c.status === "mirip" ? `Hampir sama dengan isi ${c.label}`
    : "Kutipan tidak ditemukan di file — cek manual";
  return `<button class="cite ${cls}" data-act="source" data-label="${esc(c.label || "")}" data-quote="${esc(quote)}">${esc(txt)}</button>`;
}
// Ubah "(Halaman 3)" menjadi tombol yang membuka halaman asli
function linkRefs(html) {
  return html.replace(/\(((?:[^()<]*?· )?(?:Halaman|Bagian|Gambar) \d+(?:\s*[,;–-]\s*(?:(?:Halaman|Bagian|Gambar) )?\d+)*)\)/g, (m, inner) => {
    const first = inner.match(/^(.*?(?:Halaman|Bagian|Gambar) \d+)/)[1];
    return `<button class="ref" data-act="source" data-label="${esc(first)}">${esc(inner)}</button>`;
  });
}
function showSource(label, quote) {
  const doc = state.doc || (state.review && state.review.docs[state.review.queue[state.review.idx]?.docId]);
  const page = doc?.pages.find((p) => p.label === label) || doc?.pages.find((p) => p.label.endsWith(label));
  let body = esc(page ? page.text : "");
  if (page && quote) {
    const words = quote.match(/[\p{L}\p{N}]+/gu) || [];
    if (words.length >= 3) {
      const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+"), "iu");
      const raw = page.text, m = raw.match(re);
      if (m) body = esc(raw.slice(0, m.index)) + "<mark>" + esc(m[0]) + "</mark>" + esc(raw.slice(m.index + m[0].length));
    }
  }
  openModal(`
    <h2>${esc(page ? page.label : "Kutipan")}</h2>
    ${quote ? `<p class="small muted">Kutipan yang dipakai AI:</p><blockquote class="small">“${esc(quote)}”</blockquote>` : ""}
    ${page ? `<p class="small muted">Teks asli dari file kamu:</p><div class="source-text" id="srcText">${body}</div>`
      : `<p>Kutipan ini tidak ditemukan di file. Kemungkinan AI memparafrasekan atau keliru — periksa secara manual.</p>`}`);
  document.querySelector("#srcText mark")?.scrollIntoView({ block: "center" });
}

function usageHtml() {
  const rows = AI.usage();
  return `<div class="usage">${rows.map((r) => `<div class="spread small"><span>${esc(r.model)}</span>
    <span><b>${r.n}</b> permintaan · <span class="${r.status === "siap" ? "ok-t" : "warn-t"}">${r.status}</span></span></div>`).join("")}</div>`;
}

// ---------- Data materi ----------
function pagesFor(doc, labels) {
  const set = new Set(labels || []);
  const pages = doc.pages.filter((p) => set.has(p.label));
  return { pages: pages.length ? pages : doc.pages };
}
function sanitizeTopics(doc, list) {
  const labels = doc.pages.map((p) => p.label);
  return (list || []).filter((t) => t.judul).map((t) => ({
    id: uid(), judul: t.judul.trim(), deskripsi: t.deskripsi || "",
    lokasi: [...new Set((t.lokasi || []).map((l) => labels.find((x) => x === l) || labels.find((x) => x.endsWith(l))).filter(Boolean))],
    paket: null, skor: null, percobaan: 0, feynmanSkor: null,
  }));
}
function applySummary(doc, s, detail) {
  doc.summary = {
    judul: s.judul, ringkasan: s.ringkasan, detail,
    istilah: (s.istilah || []).map((t) => ({ ...t, cek: locateQuote(t.kutipan, doc.pages) })),
  };
}
function topicStatus(doc, t) {
  if (!t.paket) return "belum";
  const cards = doc.cards.filter((c) => c.topikId === t.id);
  return t.skor >= 80 && cards.every((c) => c.reps >= 1) ? "dikuasai" : "sedang";
}
const STATUS_LABEL = { belum: "Belum dipelajari", sedang: "Sedang dipelajari", dikuasai: "Dikuasai" };
function usedLabels(doc) {
  const used = new Set();
  const add = (c) => c && c.status !== "tidak" && c.label && used.add(c.label);
  doc.quizzes.forEach((q) => q.soal.forEach((s) => add(s.cek)));
  doc.cards.forEach((c) => add(c.cek));
  doc.topik.forEach((t) => t.paket?.soal.forEach((s) => add(s.cek)));
  return used;
}
function weakTopics(doc) {
  return doc.topik.filter((t) => t.paket && ((t.skor != null && t.skor < 80) || doc.cards.some((c) => c.topikId === t.id && c.lapses > 0 && c.reps < 2)));
}

// ---------- Render utama ----------
async function render() {
  window.scrollTo(0, 0);
  if (state.view === "doc") return renderDoc();
  if (state.view === "review") return renderReview();
  return renderHome();
}

async function renderHome() {
  state.doc = null;
  const docs = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();
  const due = docs.reduce((n, d) => n + (d.cards || []).filter((c) => c.due <= now).length, 0);
  app.innerHTML = `<div class="stack">
    ${!AI.settings.key ? `<section class="card notice">
      <h2>Langkah pertama: hubungkan AI gratis</h2>
      <p>Aplikasi ini memakai Google Gemini (gratis). Kamu perlu API key sekali saja — caranya kurang dari 2 menit.</p>
      <button class="btn primary" data-act="settings">Buka Pengaturan</button></section>` : ""}

    <section class="card">
      <h2>Materi baru</h2>
      <label class="drop" id="drop">
        <input type="file" id="fileInput" multiple accept=".pdf,.docx,.txt,.md,image/*" hidden>
        <strong>Pilih atau seret file ke sini</strong>
        <span class="small muted">PDF, Word (.docx), TXT, atau foto catatan. Beberapa foto bisa dipilih sekaligus.</span>
      </label>
    </section>

    ${due ? `<section class="card spread">
      <div><h2 style="margin:0">Waktunya review</h2><span class="muted">${due} flashcard jatuh tempo hari ini</span></div>
      <button class="btn primary" data-act="reviewAll">Mulai review</button></section>` : ""}

    <section>
      <h2>Materi tersimpan</h2>
      ${docs.length ? `<div class="card list">${docs.map((d) => {
        const dueD = (d.cards || []).filter((c) => c.due <= now).length;
        const tp = d.topik || [];
        const mastered = tp.filter((t) => topicStatus({ cards: d.cards || [] }, t) === "dikuasai").length;
        return `<div class="doc-item">
          <div class="info" data-act="open" data-id="${d.id}">
            <div class="title">${esc(d.summary?.judul || d.name)}</div>
            <div class="small muted">${fmtDate(d.createdAt)}${tp.length ? ` · ${mastered}/${tp.length} topik dikuasai` : ` · ${d.pages.length} bagian`}
              ${dueD ? ` · <span class="pill accent">${dueD} kartu</span>` : ""}</div>
            ${tp.length ? `<div class="progress" style="margin-top:6px"><i style="width:${(mastered / tp.length) * 100}%"></i></div>` : ""}
          </div>
          <button class="btn sm" data-act="open" data-id="${d.id}">Buka</button>
        </div>`;
      }).join("")}</div>` : `<p class="muted">Belum ada materi. Unggah file pertamamu di atas.</p>`}
    </section>

    ${AI.settings.key ? `<section class="card">
      <h2>Pemakaian AI hari ini</h2>
      ${usageHtml()}
      <p class="small muted" style="margin-top:8px">Kuota gratis direset setiap hari sekitar pukul 14.00–15.00 WIB. Jika model utama habis, aplikasi otomatis pindah ke model cadangan.</p>
    </section>` : ""}

    <section class="card">
      <h2>Cadangan data</h2>
      <p class="small muted">Semua materi, soal, dan kemajuan belajar tersimpan di browser perangkat ini saja. Ekspor secara berkala agar tidak hilang, atau untuk memindahkan data antara laptop dan HP.</p>
      <div class="row">
        <button class="btn" data-act="export">Ekspor data</button>
        <label class="btn">Impor data<input type="file" id="importInput" accept=".json,application/json" hidden></label>
      </div>
    </section>
  </div>`;

  const drop = document.getElementById("drop");
  document.getElementById("fileInput").onchange = (e) => e.target.files.length && handleFiles(e.target.files);
  document.getElementById("importInput").onchange = (e) => e.target.files[0] && importData(e.target.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files.length && handleFiles(e.dataTransfer.files); };
}

async function handleFiles(files) {
  if (!AI.settings.key) { openSettings(); return toast("Isi API key dulu sebelum mengunggah.", "err"); }
  await run("Membaca file…", async (status) => {
    const r = await extractFiles(files, status);
    const doc = {
      id: uid(), createdAt: Date.now(),
      name: files.length > 1 ? `${files[0].name} +${files.length - 1} file` : files[0].name,
      pages: r.pages, method: r.method, truncated: r.truncated, totalPages: r.totalPages,
      summary: null, topik: [], quizzes: [], cards: [], chat: [], feynman: [],
    };
    await DB.put(doc);
    state.doc = doc;
    try {
      status("Membuat ringkasan dan peta materi…");
      const s = await AI.setup(doc, status);
      applySummary(doc, s, "sedang");
      doc.topik = sanitizeTopics(doc, s.topik);
      await save();
    } catch (e) { toast("File tersimpan, tetapi ringkasan/peta materi gagal: " + e.message, "err"); }
    await openDoc(doc.id);
  });
}

async function openDoc(id, opts = {}) {
  const d = await DB.get(id);
  Object.assign(d, { topik: d.topik || [], feynman: d.feynman || [], quizzes: d.quizzes || [], cards: d.cards || [], chat: d.chat || [] });
  state.doc = d;
  state.view = "doc";
  state.tab = opts.tab || "belajar";
  state.topicId = opts.topicId || null;
  state.quizId = d.quizzes[0]?.id || null;
  state.answers = {}; state.revealAll = false; state.tAnswers = {}; state.local = null;
  render();
}

// ---------- Halaman materi ----------
const TABS = [["belajar", "Belajar bertahap"], ["ringkasan", "Ringkasan"], ["soal", "Soal"], ["flashcard", "Flashcard"], ["tanya", "Tanya materi"], ["feynman", "Uji pemahaman"]];

function renderDoc() {
  const d = state.doc;
  const body = { belajar: tabLearn, ringkasan: tabSummary, soal: tabQuiz, flashcard: tabCards, tanya: tabChat, feynman: tabFeynman }[state.tab]();
  app.innerHTML = `
    <div class="spread" style="margin-bottom:4px">
      <button class="link small" data-act="home">← Semua materi</button>
      <button class="link small" data-act="viewText">Teks hasil baca file</button>
    </div>
    <h1>${esc(d.summary?.judul || d.name)}</h1>
    <p class="small muted">${esc(d.name)} · ${d.pages.length} bagian · dibaca dengan ${d.method === "ocr" ? "OCR AI (hasil scan/foto)" : "ekstraksi teks"}</p>
    ${d.truncated ? `<div class="card notice small">File sangat panjang: hanya ${d.pages.length} dari ${d.totalPages} bagian pertama yang dipakai. Untuk hasil lengkap, pecah file menjadi beberapa bagian.</div>` : ""}
    ${d.method === "ocr" ? `<p class="small muted">Tips: hasil OCR bisa keliru membaca tulisan. Cek lewat "Teks hasil baca file".</p>` : ""}
    <nav class="tabs" role="tablist">${TABS.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${state.tab === k}" data-act="tab" data-tab="${k}">${l}</button>`).join("")}</nav>
    <div class="stack" style="margin-top:8px">${body}</div>
    ${state.tab === "ringkasan" ? `<p style="margin-top:32px"><button class="link small" style="color:var(--bad)" data-act="docDelete">Hapus materi ini</button></p>` : ""}`;
  if (state.tab === "tanya") afterChatRender();
}

// ---- Belajar bertahap: peta materi ----
function tabLearn() {
  const d = state.doc;
  const t = d.topik.find((x) => x.id === state.topicId);
  return t ? renderTopic(t) : renderMap();
}

function renderMap() {
  const d = state.doc;
  if (!d.topik.length) return `<section class="card">
    <h2>Peta materi belum dibuat</h2>
    <p class="small muted">AI akan memecah seluruh materi menjadi topik-topik berurutan, supaya kamu bisa belajar bagian demi bagian tanpa ada yang terlewat.</p>
    <button class="btn primary" data-act="topicMapGen">Buat peta materi</button> ${calls(1)}</section>`;

  const st = d.topik.map((t) => topicStatus(d, t));
  const n = { belum: 0, sedang: 0, dikuasai: 0 };
  st.forEach((s) => n[s]++);
  const nextIdx = st.findIndex((s) => s !== "dikuasai");
  const used = usedLabels(d);
  const uncovered = d.pages.filter((p) => !used.has(p.label));
  const weak = weakTopics(d);
  const vc = AI.settings.verify ? 2 : 1;

  return `
    <section class="card">
      <div class="spread"><h2 style="margin:0">Kemajuan belajar</h2><b>${n.dikuasai}/${d.topik.length} topik dikuasai</b></div>
      <div class="progress" style="margin:10px 0"><i style="width:${(n.dikuasai / d.topik.length) * 100}%"></i></div>
      <p class="small muted">${n.belum} belum dipelajari · ${n.sedang} sedang dipelajari · ${n.dikuasai} dikuasai. Topik dianggap dikuasai jika skor soalnya minimal 80 dan semua kartunya sudah dihafal.</p>
      ${nextIdx >= 0 ? `<button class="btn primary block" data-act="topicOpen" data-id="${d.topik[nextIdx].id}">${st[nextIdx] === "belum" ? "Mulai" : "Lanjutkan"}: ${esc(d.topik[nextIdx].judul)}</button>`
        : `<p class="ok-t"><b>Semua topik sudah dikuasai.</b> Pertahankan dengan review flashcard rutin.</p>`}
    </section>

    <section class="card list">
      ${d.topik.map((t, i) => `<div class="topic-row" data-act="topicOpen" data-id="${t.id}">
        <span class="tnum s-${st[i]}">${i + 1}</span>
        <div class="info"><div class="title">${esc(t.judul)}</div>
          <div class="small muted">${esc(t.deskripsi)}</div>
          <div class="small muted">${t.lokasi.length ? esc(t.lokasi.join(", ")) : "Seluruh materi"}${t.skor != null ? ` · skor ${t.skor}` : ""}</div></div>
        <span class="pill s-${st[i]}">${STATUS_LABEL[st[i]]}</span>
      </div>`).join("")}
    </section>

    <section class="card">
      <h2>Latihan tambahan</h2>
      <h3>Topik lemah</h3>
      <p class="small muted">${weak.length ? `${weak.length} topik perlu diperkuat: ${esc(weak.map((t) => t.judul).join(", "))}.` : "Belum ada topik lemah. Topik dianggap lemah jika skor soalnya di bawah 80 atau kartunya sering lupa."}</p>
      <button class="btn" data-act="weakQuiz" ${weak.length ? "" : "disabled"}>Buat latihan topik lemah</button> ${weak.length ? calls(vc) : ""}
      <h3 style="margin-top:20px">Cakupan latihan</h3>
      <p class="small muted">${d.pages.length - uncovered.length} dari ${d.pages.length} bagian materi sudah punya soal atau flashcard.</p>
      <div class="progress" style="margin-bottom:10px"><i style="width:${((d.pages.length - uncovered.length) / d.pages.length) * 100}%"></i></div>
      ${uncovered.length ? `<p class="small">Belum tercakup: ${uncovered.slice(0, 10).map((p) => `<button class="ref" data-act="source" data-label="${esc(p.label)}">${esc(p.label)}</button>`).join(" ")}${uncovered.length > 10 ? ` dan ${uncovered.length - 10} lainnya` : ""}</p>
        <button class="btn" data-act="coverQuiz">Buat soal dari bagian yang belum tercakup</button> ${calls(vc)}` : `<p class="small ok-t">Semua bagian materi sudah tercakup.</p>`}
    </section>
    <p class="small"><button class="link" data-act="topicMapGen">Buat ulang peta materi</button> <span class="muted">(kemajuan per topik akan direset)</span></p>`;
}

// ---- Belajar bertahap: satu topik ----
function renderTopic(t) {
  const d = state.doc;
  const i = d.topik.indexOf(t);
  const status = topicStatus(d, t);
  const prev = d.topik[i - 1], next = d.topik[i + 1];
  const head = `<button class="link small" data-act="topicBack">← Peta materi</button>
    <section class="card">
      <p class="small muted" style="margin:0">Topik ${i + 1} dari ${d.topik.length}</p>
      <h2>${esc(t.judul)}</h2>
      <p class="small">${esc(t.deskripsi)}</p>
      <div class="row"><span class="pill s-${status}">${STATUS_LABEL[status]}</span>
        ${t.lokasi.map((l) => `<button class="ref" data-act="source" data-label="${esc(l)}">${esc(l)}</button>`).join(" ")}</div>
    </section>`;
  const nav = `<div class="spread">
    ${prev ? `<button class="btn sm" data-act="topicOpen" data-id="${prev.id}">← ${esc(prev.judul)}</button>` : "<span></span>"}
    ${next ? `<button class="btn sm" data-act="topicOpen" data-id="${next.id}">${esc(next.judul)} →</button>` : ""}</div>`;

  if (!t.paket) return head + `<section class="card">
    <p>Aplikasi akan membuat penjelasan, flashcard, dan soal khusus untuk topik ini, hanya dari ${t.lokasi.length ? esc(t.lokasi.join(", ")) : "materi"}.</p>
    <button class="btn primary block" data-act="topicStart">Mulai pelajari topik ini</button>
    <p style="text-align:center;margin:8px 0 0">${calls(AI.settings.verify ? 2 : 1)}</p></section>` + nav;

  const p = t.paket;
  const cards = d.cards.filter((c) => c.topikId === t.id);
  const hafal = cards.filter((c) => c.reps >= 1).length;
  const sc = scoreOf(p.soal, state.tAnswers);
  const fey = t.feynmanSkor;

  return head + `
    <section class="card"><h3 class="step"><span>1</span> Pahami</h3>
      <div class="prose">${linkRefs(md(p.penjelasan))}</div>
      ${p.poin?.length ? `<h3 style="margin-top:12px">Poin kunci</h3><ul class="fb-list">${p.poin.map((x) => `<li>${esc(x.poin)}<br>${cite(x.cek, x.kutipan)}</li>`).join("")}</ul>` : ""}
    </section>

    <section class="card"><h3 class="step"><span>2</span> Hafalkan</h3>
      <p class="small">${cards.length} kartu untuk topik ini · ${hafal} sudah dihafal.</p>
      <div class="progress" style="margin-bottom:10px"><i style="width:${cards.length ? (hafal / cards.length) * 100 : 0}%"></i></div>
      <button class="btn ${hafal < cards.length ? "primary" : ""}" data-act="reviewTopic" ${cards.length ? "" : "disabled"}>${hafal < cards.length ? "Hafalkan kartu topik ini" : "Ulangi kartu yang jatuh tempo"}</button>
    </section>

    <section class="card"><h3 class="step"><span>3</span> Uji diri</h3>
      <p class="small muted">Jawab semua soal. Untuk soal isian, lihat kunci lalu nilai sendiri jawabanmu.${t.skor != null ? ` Skor terakhir: <b>${t.skor}</b> (${t.percobaan}× mencoba).` : ""}</p>
    </section>
    ${p.soal.map((s, k) => renderQ(s, k, "topic")).join("")}
    <div class="card spread">
      <span>${sc.answered}/${sc.total} dijawab · benar ${sc.correct}</span>
      <div class="row"><button class="btn sm" data-act="topicRetry">Ulangi</button>
      <button class="btn sm" data-act="topicNewQuiz">Soal baru</button></div>
    </div>

    <section class="card"><h3 class="step"><span>4</span> Jelaskan ulang</h3>
      <p class="small">Uji pemahaman akhir: jelaskan topik ini dengan kata-katamu sendiri.${fey != null ? ` Skor penjelasan terakhir: <b>${fey}</b>.` : ""}</p>
      <button class="btn" data-act="topicFeynman">Jelaskan topik ini</button>
    </section>` + nav;
}

async function startTopic(t) {
  const d = state.doc;
  await run(`Menyiapkan topik "${t.judul}"…`, async (status) => {
    const sub = pagesFor(d, t.lokasi);
    const r = await AI.topicPack(sub, t, status);
    const { soal } = await processSoal(sub, r.soal, status, AI.settings.verify);
    const now = Date.now();
    const kartu = (r.kartu || []).filter((k) => k.depan && k.belakang).map((k) => ({
      id: uid(), topikId: t.id, depan: k.depan, belakang: k.belakang, kutipan: k.kutipan,
      cek: locateQuote(k.kutipan, d.pages), ef: 2.5, interval: 0, reps: 0, lapses: 0, due: now,
    })).filter((k) => k.cek.status !== "tidak");
    d.cards.push(...kartu);
    t.paket = {
      penjelasan: r.penjelasan, createdAt: now, soal,
      poin: (r.poin_kunci || []).map((x) => ({ ...x, cek: locateQuote(x.kutipan, d.pages) })),
    };
    state.tAnswers = {};
    await save();
    renderDoc();
  });
}

async function newTopicQuiz(t) {
  await run("Membuat soal baru untuk topik ini…", async (status) => {
    const sub = pagesFor(state.doc, t.lokasi);
    const r = await AI.quiz(sub, { jumlah: 4, tingkat: "sedang", jenis: ["pilihan_ganda", "isian"], fokus: `hanya tentang topik "${t.judul}"` }, status);
    const { soal } = await processSoal(sub, r.soal, status, AI.settings.verify);
    t.paket.soal = soal;
    state.tAnswers = {};
    await save();
    renderDoc();
  });
}

function checkTopicDone() {
  const t = state.doc.topik.find((x) => x.id === state.topicId);
  if (!t?.paket) return;
  const sc = scoreOf(t.paket.soal, state.tAnswers);
  if (sc.answered < sc.total || state.tAnswers._recorded) return;
  state.tAnswers._recorded = true;
  t.skor = Math.round((sc.correct / sc.total) * 100);
  t.percobaan = (t.percobaan || 0) + 1;
  save();
  toast(t.skor >= 80 ? `Skor ${t.skor}. Bagus! ${topicStatus(state.doc, t) === "dikuasai" ? "Topik ini dikuasai." : "Selesaikan hafalan kartunya juga."}` : `Skor ${t.skor}. Baca lagi bagian "Pahami", lalu coba ulangi.`);
}

// ---- Ringkasan ----
function tabSummary() {
  const s = state.doc.summary;
  const ctrl = `<div class="card row">
    <select id="detailSel" style="flex:1;min-width:140px" aria-label="Panjang ringkasan">
      ${["singkat", "sedang", "detail"].map((v) => `<option value="${v}" ${s?.detail === v ? "selected" : ""}>Ringkasan ${v}</option>`).join("")}
    </select>
    <button class="btn" data-act="sumRegen">${s ? "Buat ulang" : "Buat ringkasan"}</button></div>`;
  if (!s) return ctrl + `<p class="muted">Ringkasan belum dibuat.</p>`;
  return ctrl + `
    <section class="card prose">${linkRefs(md(s.ringkasan))}</section>
    ${s.istilah?.length ? `<section class="card"><h2>Istilah penting</h2>
      ${s.istilah.map((t) => `<div class="term"><b>${esc(t.istilah)}</b> — ${esc(t.arti)}<br>${cite(t.cek, t.kutipan)}</div>`).join("")}</section>` : ""}
    <p class="small muted">Klik label sumber untuk melihat teks aslinya di file kamu.</p>`;
}

// ---- Soal ----
function normalizeSoal(s) {
  const jenis = ["pilihan_ganda", "isian", "esai"].includes(s.jenis) ? s.jenis : "isian";
  const out = { jenis, pertanyaan: (s.pertanyaan || "").trim(), jawaban: (s.jawaban || "").trim(), pembahasan: s.pembahasan || "", kutipan: s.kutipan || "" };
  if (!out.pertanyaan || !out.jawaban) return null;
  if (jenis === "pilihan_ganda") {
    out.opsi = (s.opsi || []).map((o) => String(o).replace(/^\s*[A-Da-d][.)]\s+/, "").trim()).filter(Boolean);
    if (out.opsi.length !== 4) return null;
    const letter = out.jawaban.toUpperCase().match(/^\s*([A-D])\b/);
    if (letter) out.jawaban = letter[1];
    else {
      const i = out.opsi.findIndex((o) => o.toLowerCase() === out.jawaban.toLowerCase());
      if (i < 0) return null;
      out.jawaban = "ABCD"[i];
    }
    if (new Set(out.opsi.map((o) => o.toLowerCase())).size !== 4) return null; // opsi kembar
  } else out.opsi = [];
  return out;
}

// Rapikan soal → (opsional) periksa ulang oleh AI → cek kutipan di file
async function processSoal(src, raw, status, verify) {
  raw = raw || [];
  let soal = raw.map(normalizeSoal).filter(Boolean);
  const info = { dibuat: raw.length, formatRusak: raw.length - soal.length, diperbaiki: 0, dibuang: 0, diperiksa: verify };
  if (!soal.length) throw new Error("AI tidak menghasilkan soal yang valid. Coba lagi.");
  if (verify) {
    status("Memeriksa ulang setiap soal terhadap materi…");
    const v = await AI.verifyQuiz(src, soal, status);
    const keep = [];
    soal.forEach((s, i) => {
      const h = (v.hasil || []).find((x) => x.nomor === i + 1);
      if (h?.status === "buang") { info.dibuang++; return; }
      if (h?.status === "perbaiki" && h.jawaban) {
        let j = h.jawaban.trim();
        if (s.jenis === "pilihan_ganda") {
          const m = j.toUpperCase().match(/^\s*([A-D])\b/);
          if (!m) { info.dibuang++; return; }
          j = m[1];
        }
        s.jawaban = j;
        if (h.pembahasan) s.pembahasan = h.pembahasan;
        s.catatan = "Kunci diperbaiki oleh pemeriksa: " + (h.alasan || "");
        info.diperbaiki++;
      }
      keep.push(s);
    });
    soal = keep;
  }
  if (!soal.length) throw new Error("Semua soal gagal lolos pemeriksaan. Coba buat ulang.");
  soal.forEach((s) => (s.cek = locateQuote(s.kutipan, state.doc.pages)));
  soal.sort((a, b) => (a.cek.status === "tidak") - (b.cek.status === "tidak"));
  return { soal, info };
}

async function makeQuiz(src, opts, label, busyText = "Membuat soal…") {
  await run(busyText, async (status) => {
    const r = await AI.quiz(src, opts, status);
    const { soal, info } = await processSoal(src, r.soal, status, opts.periksa);
    const quiz = { id: uid(), createdAt: Date.now(), opts, soal, info, label };
    state.doc.quizzes.unshift(quiz);
    state.quizId = quiz.id; state.answers = {}; state.revealAll = false; state.local = null;
    await save();
    state.tab = "soal";
    render();
    toast(`${soal.length} soal siap.`);
  });
}

function genQuiz() {
  const jenis = [...document.querySelectorAll("input[name=jenis]:checked")].map((i) => i.value);
  if (!jenis.length) return toast("Pilih minimal satu jenis soal.", "err");
  makeQuiz(state.doc, {
    jumlah: Math.min(Math.max(parseInt(document.getElementById("qJumlah").value) || 10, 1), 30),
    tingkat: document.getElementById("qTingkat").value,
    jenis, periksa: document.getElementById("qPeriksa").checked,
  });
}

function scoreOf(soal, ans) {
  let answered = 0, correct = 0;
  soal.forEach((s, i) => {
    const a = ans[i];
    if (s.jenis === "pilihan_ganda") { if (a) { answered++; if (a === s.jawaban) correct++; } }
    else if (a === "ok" || a === "bad") { answered++; if (a === "ok") correct++; }
  });
  return { answered, correct, total: soal.length };
}

function tabQuiz() {
  const d = state.doc;
  const quiz = d.quizzes.find((q) => q.id === state.quizId) || d.quizzes[0];
  const verify = AI.settings.verify;
  const local = `<section class="card">
    <h2>Latihan tanpa kuota</h2>
    <p class="small muted">Dibuat dari soal, istilah, dan kartu yang sudah tersimpan — tidak memakai AI sama sekali.</p>
    <div class="row">
      <button class="btn sm" data-act="localShuffle">Acak ulang soal lama</button>
      <button class="btn sm" data-act="localMatch">Cocokkan istilah</button>
      <button class="btn sm" data-act="localGuess">Tebak istilah</button>
    </div></section>
    ${state.local ? renderLocal() : ""}`;
  const form = `<details class="card" ${quiz ? "" : "open"}>
    <summary>Buat set soal baru dengan AI</summary>
    <div style="margin-top:12px">
      <div class="grid2">
        <label class="field"><span>Jumlah soal</span><input type="number" id="qJumlah" min="1" max="30" value="${quiz?.opts.jumlah || 15}"></label>
        <label class="field"><span>Tingkat kesulitan</span><select id="qTingkat">
          ${["mudah", "sedang", "sulit"].map((t) => `<option ${(quiz?.opts.tingkat || "sedang") === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      </div>
      <div class="field"><span class="small" style="font-weight:600;display:block;margin-bottom:4px">Jenis soal</span><div class="checks">
        ${[["pilihan_ganda", "Pilihan ganda"], ["isian", "Isian singkat"], ["esai", "Esai"]].map(([v, l]) =>
          `<label class="check"><input type="checkbox" name="jenis" value="${v}" ${(quiz?.opts.jenis?.length ? quiz.opts.jenis : ["pilihan_ganda"]).includes(v) ? "checked" : ""}>${l}</label>`).join("")}
      </div></div>
      <label class="check" style="margin:12px 0"><input type="checkbox" id="qPeriksa" ${verify ? "checked" : ""}> Periksa ulang setiap soal (lebih akurat, +1 panggilan)</label>
      <button class="btn primary block" data-act="quizGen">Buat soal</button>
      <p class="small muted" style="margin:8px 0 0">Hemat kuota: buat banyak soal sekaligus (misalnya 20–30) daripada berkali-kali sedikit.</p>
    </div></details>`;
  if (!quiz) return local + form;

  const sc = scoreOf(quiz.soal, state.answers);
  const inf = quiz.info;
  return local + form + `
    <div class="card">
      <select id="quizSel" style="width:100%" aria-label="Pilih set soal">
        ${d.quizzes.map((q) => `<option value="${q.id}" ${q.id === quiz.id ? "selected" : ""}>${fmtDate(q.createdAt)} · ${q.soal.length} soal${q.label ? " · " + esc(q.label) : " · " + q.opts.tingkat}</option>`).join("")}
      </select>
      <p class="small muted" style="margin-top:8px">${inf.lokal ? "Disusun ulang dari soal tersimpan, tanpa AI." : `${inf.dibuat} soal dibuat${inf.formatRusak ? `, ${inf.formatRusak} dibuang karena formatnya rusak` : ""}${inf.diperiksa ?? quiz.opts.periksa ? `. Pemeriksa: ${inf.diperbaiki} diperbaiki, ${inf.dibuang} dibuang` : ""}.`}</p>
      <div class="row">
        <button class="btn sm" data-act="revealAll">${state.revealAll ? "Sembunyikan kunci" : "Tampilkan semua kunci"}</button>
        <button class="btn sm" data-act="quizReset">Ulangi</button>
        <button class="btn sm" data-act="print">Cetak / PDF</button>
        <button class="btn sm danger" data-act="quizDel">Hapus set</button>
      </div>
    </div>
    ${quiz.soal.map((s, i) => renderQ(s, i, "quiz")).join("")}
    <div class="scorebar"><span>${sc.answered}/${sc.total} dijawab</span><b>Benar ${sc.correct}</b></div>`;
}

function renderQ(s, i, ctx) {
  const ans = ctx === "topic" ? state.tAnswers : state.answers;
  const a = ans[i];
  const show = (ctx === "quiz" && state.revealAll) || a;
  const label = { pilihan_ganda: "Pilihan ganda", isian: "Isian", esai: "Esai" }[s.jenis];
  let body = "";
  if (s.jenis === "pilihan_ganda") {
    body = `<div class="opts">${s.opsi.map((o, k) => {
      const L = "ABCD"[k];
      let cls = "";
      if (show && L === s.jawaban) cls = "correct";
      else if (a === L) cls = "wrong";
      return `<button class="opt ${cls}" data-act="mcq" data-ctx="${ctx}" data-i="${i}" data-l="${L}" ${a ? "disabled" : ""}><b>${L}.</b><span>${esc(o)}</span></button>`;
    }).join("")}</div>`;
    if (show) body += `<div class="answer">
      ${a ? `<div class="verdict ${a === s.jawaban ? "ok" : "bad"}">${a === s.jawaban ? "Benar" : `Kurang tepat — jawaban: ${s.jawaban}`}</div>` : `<div class="k">Kunci: ${s.jawaban}</div>`}
      <div class="prose small">${md(s.pembahasan)}</div>${cite(s.cek, s.kutipan)}</div>`;
  } else {
    body = show ? `<div class="answer"><div class="k">${s.jenis === "esai" ? "Poin jawaban ideal:" : "Kunci:"}</div>
        <div class="prose">${md(s.jawaban)}</div>
        ${s.pembahasan ? `<div class="prose small muted">${md(s.pembahasan)}</div>` : ""}${cite(s.cek, s.kutipan)}
        ${a === "shown" ? `<div class="row" style="margin-top:10px"><span class="small">Jawabanmu tadi:</span>
          <button class="btn sm g4" data-act="selfMark" data-ctx="${ctx}" data-i="${i}" data-v="ok">Benar</button>
          <button class="btn sm g0" data-act="selfMark" data-ctx="${ctx}" data-i="${i}" data-v="bad">Salah</button></div>`
          : a === "ok" ? `<div class="verdict ok" style="margin-top:8px">Kamu menilai: benar</div>` : a === "bad" ? `<div class="verdict bad" style="margin-top:8px">Kamu menilai: salah</div>` : ""}
      </div>`
      : `<textarea placeholder="Tulis jawabanmu dulu, lalu cocokkan dengan kunci…" aria-label="Jawabanmu" ${s.jenis === "isian" ? 'style="min-height:44px"' : ""}></textarea>
         <button class="btn sm" style="margin-top:8px" data-act="reveal" data-ctx="${ctx}" data-i="${i}">Lihat kunci</button>`;
  }
  return `<article class="card q">
    <div class="q-head"><span class="q-num">${i + 1}.</span><span class="pill">${label}</span></div>
    <div class="q-text">${esc(s.pertanyaan)}</div>${body}
    ${s.catatan && show ? `<div class="flag">${esc(s.catatan)}</div>` : ""}
    ${s.cek?.status === "tidak" && !show ? `<div class="flag">Sumber soal ini tidak terverifikasi — periksa dengan teliti.</div>` : ""}
  </article>`;
}

function printQuiz() {
  const quiz = state.doc.quizzes.find((q) => q.id === state.quizId) || state.doc.quizzes[0];
  const title = esc(state.doc.summary?.judul || state.doc.name);
  const qs = quiz.soal.map((s, i) => `<div class="pq"><b>${i + 1}.</b> ${esc(s.pertanyaan)}
    ${s.jenis === "pilihan_ganda" ? `<div style="margin-left:1.4em">${s.opsi.map((o, k) => `${"ABCD"[k]}. ${esc(o)}`).join("<br>")}</div>`
      : `<div class="lines"></div>${s.jenis === "esai" ? '<div class="lines"></div><div class="lines"></div>' : ""}`}</div>`).join("");
  const keys = quiz.soal.map((s, i) => `<div class="pq"><b>${i + 1}. ${s.jenis === "pilihan_ganda" ? s.jawaban : ""}</b>
    ${s.jenis !== "pilihan_ganda" ? md(s.jawaban) : ""}<div><i>Pembahasan:</i> ${md(s.pembahasan)}</div>
    <div style="font-size:10pt;color:#555">Sumber: ${esc(s.cek?.label || "tidak terverifikasi")}</div></div>`).join("");
  document.getElementById("print").innerHTML = `<h1>${title}</h1><p>Latihan soal · ${esc(quiz.label || "tingkat " + quiz.opts.tingkat)} · ${quiz.soal.length} soal</p>${qs}
    <div class="page-break"></div><h1>Kunci Jawaban & Pembahasan</h1>${keys}`;
  window.print();
}

// ---- Latihan tanpa kuota ----
function allSoal(doc) {
  const seen = new Set(), out = [];
  for (const s of [...doc.quizzes.flatMap((q) => q.soal), ...doc.topik.flatMap((t) => t.paket?.soal || [])]) {
    const k = s.pertanyaan.toLowerCase();
    if (seen.has(k) || s.cek?.status === "tidak") continue;
    seen.add(k); out.push(s);
  }
  return out;
}
async function localShuffle() {
  const pool = allSoal(state.doc);
  if (pool.length < 3) return toast("Belum cukup soal tersimpan. Buat soal atau pelajari beberapa topik dulu.", "err");
  const soal = shuffle(pool).slice(0, 15).map((s) => {
    const c = JSON.parse(JSON.stringify(s));
    delete c.catatan;
    if (c.jenis === "pilihan_ganda") {
      const right = c.opsi["ABCD".indexOf(c.jawaban)];
      c.opsi = shuffle(c.opsi);
      c.jawaban = "ABCD"[c.opsi.indexOf(right)];
    }
    return c;
  });
  const quiz = { id: uid(), createdAt: Date.now(), soal, label: "Acak ulang (tanpa AI)", opts: { jumlah: soal.length, tingkat: "campuran", jenis: [], periksa: false }, info: { lokal: true, dibuat: soal.length } };
  state.doc.quizzes.unshift(quiz);
  state.quizId = quiz.id; state.answers = {}; state.revealAll = false; state.local = null;
  await save();
  renderDoc();
  toast(`${soal.length} soal diacak ulang tanpa memakai kuota.`);
}
function pairsPool(doc) {
  const out = (doc.summary?.istilah || []).filter((t) => t.cek?.status !== "tidak").map((t) => ({ a: t.istilah, b: t.arti }));
  doc.cards.filter((c) => c.depan.length < 60).forEach((c) => out.push({ a: c.depan, b: c.belakang }));
  const seen = new Set();
  return out.filter((p) => !seen.has(p.a.toLowerCase()) && seen.add(p.a.toLowerCase()));
}
function localMatch() {
  const items = shuffle(pairsPool(state.doc)).slice(0, 6);
  if (items.length < 3) return toast("Belum cukup istilah atau kartu tersimpan.", "err");
  state.local = { type: "match", items, order: shuffle(items.map((_, i) => i)), checked: false };
  renderDoc();
}
function localGuess() {
  const items = shuffle((state.doc.summary?.istilah || []).filter((t) => t.cek?.status !== "tidak").map((t) => ({ a: t.istilah, b: t.arti }))).slice(0, 8);
  if (items.length < 2) return toast("Belum cukup istilah tersimpan. Buat ringkasan dulu.", "err");
  state.local = { type: "guess", items, checked: false };
  renderDoc();
}
function renderLocal() {
  const L = state.local;
  if (L.type === "match") {
    return `<section class="card" id="localBox"><div class="spread"><h3 style="margin:0">Cocokkan istilah dengan artinya</h3><button class="link small" data-act="localClose">Tutup</button></div>
      ${L.items.map((it, i) => {
        const pick = L.picks?.[i];
        const ok = L.checked && +pick === i;
        return `<div class="term"><b>${esc(it.a)}</b>
          <select data-match="${i}" ${L.checked ? "disabled" : ""} style="margin-top:6px">
            <option value="">— pilih arti —</option>
            ${L.order.map((j) => `<option value="${j}" ${String(pick) === String(j) ? "selected" : ""}>${esc(L.items[j].b)}</option>`).join("")}
          </select>
          ${L.checked ? `<div class="verdict ${ok ? "ok" : "bad"} small" style="margin-top:4px">${ok ? "Benar" : "Seharusnya: " + esc(it.b)}</div>` : ""}</div>`;
      }).join("")}
      ${L.checked ? `<p><b>Skor: ${L.items.filter((_, i) => +L.picks?.[i] === i).length}/${L.items.length}</b></p><button class="btn sm" data-act="localMatch">Main lagi</button>`
        : `<button class="btn primary" data-act="localCheck">Periksa</button>`}</section>`;
  }
  return `<section class="card" id="localBox"><div class="spread"><h3 style="margin:0">Tebak istilah dari artinya</h3><button class="link small" data-act="localClose">Tutup</button></div>
    ${L.items.map((it, i) => {
      const v = L.inputs?.[i] || "";
      const ok = L.checked && guessOk(v, it.a);
      return `<div class="term"><span>${esc(it.b)}</span>
        <input type="text" data-guess="${i}" value="${esc(v)}" ${L.checked ? "disabled" : ""} placeholder="Istilahnya…" style="margin-top:6px">
        ${L.checked ? `<div class="verdict ${ok ? "ok" : "bad"} small" style="margin-top:4px">${ok ? "Benar" : "Jawaban: " + esc(it.a)}</div>` : ""}</div>`;
    }).join("")}
    ${L.checked ? `<p><b>Skor: ${L.items.filter((it, i) => guessOk(L.inputs?.[i] || "", it.a)).length}/${L.items.length}</b></p><button class="btn sm" data-act="localGuess">Main lagi</button>`
      : `<button class="btn primary" data-act="localCheck">Periksa</button>`}</section>`;
}
function guessOk(input, answer) {
  const a = norm(input), b = norm(answer);
  return a.length >= 2 && (a === b || (a.length >= 4 && (b.includes(a) || a.includes(b))));
}
function localCheck() {
  const L = state.local;
  if (L.type === "match") L.picks = Object.fromEntries([...document.querySelectorAll("[data-match]")].map((s) => [s.dataset.match, s.value]));
  else L.inputs = Object.fromEntries([...document.querySelectorAll("[data-guess]")].map((s) => [s.dataset.guess, s.value]));
  L.checked = true;
  keepScroll(renderDoc);
}

// ---- Flashcard (pengulangan berjarak / SM-2) ----
function schedule(c, q, now = Date.now()) {
  const n = { ...c, lapses: c.lapses || 0 };
  if (q < 3) { n.reps = 0; n.interval = 0; n.due = now + 10 * 60e3; n.lapses++; }
  else {
    n.reps = c.reps + 1;
    if (n.reps === 1) n.interval = q === 5 ? 3 : 1;
    else if (n.reps === 2) n.interval = q === 3 ? 3 : q === 5 ? 8 : 6;
    else n.interval = Math.max(1, Math.round(c.interval * c.ef * (q === 3 ? 0.8 : q === 5 ? 1.3 : 1)));
    n.due = now + n.interval * DAY;
  }
  n.ef = Math.max(1.3, c.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return n;
}
const intervalText = (c, q) => { const n = schedule(c, q); return n.interval ? `${n.interval} hari` : "10 mnt"; };

async function genCards() {
  const jumlah = parseInt(document.getElementById("cJumlah").value) || 15;
  await run("Membuat flashcard…", async (status) => {
    const r = await AI.flashcards(state.doc, jumlah, state.doc.cards.map((c) => c.depan), status);
    const now = Date.now();
    const seen = new Set(state.doc.cards.map((c) => c.depan.toLowerCase()));
    const semua = (r.kartu || []).filter((k) => k.depan && k.belakang && !seen.has(k.depan.toLowerCase())).map((k) => ({
      id: uid(), depan: k.depan, belakang: k.belakang, kutipan: k.kutipan,
      cek: locateQuote(k.kutipan, state.doc.pages), ef: 2.5, interval: 0, reps: 0, lapses: 0, due: now,
    }));
    // Kartu untuk hafalan harus pasti benar: buang yang sumbernya tidak ditemukan di file
    const baru = semua.filter((k) => k.cek.status !== "tidak");
    const bad = semua.length - baru.length;
    state.doc.cards.push(...baru);
    await save();
    renderDoc();
    toast(`${baru.length} kartu ditambahkan.${bad ? ` ${bad} kartu dibuang karena sumbernya tidak ditemukan di file.` : ""}`);
  });
}

function tabCards() {
  const cards = state.doc.cards, now = Date.now();
  const due = cards.filter((c) => c.due <= now).length;
  const baru = cards.filter((c) => c.reps === 0 && c.interval === 0).length;
  const topicName = (id) => state.doc.topik.find((t) => t.id === id)?.judul;
  return `
    <section class="card">
      <div class="stats">
        <div class="stat"><b>${cards.length}</b><span>Total kartu</span></div>
        <div class="stat"><b>${due}</b><span>Jatuh tempo</span></div>
        <div class="stat"><b>${baru}</b><span>Belum dipelajari</span></div>
      </div>
      <button class="btn primary block" style="margin-top:12px" data-act="reviewDoc" ${due ? "" : "disabled"}>${due ? `Mulai review (${due} kartu)` : "Tidak ada kartu jatuh tempo"}</button>
      <p class="small muted" style="margin-top:12px">Kartu yang kamu anggap sulit akan muncul lebih sering; yang mudah muncul makin jarang. Review flashcard tidak memakai kuota AI.</p>
    </section>
    <section class="card row">
      <select id="cJumlah" style="flex:1;min-width:120px" aria-label="Jumlah kartu">
        ${[10, 15, 20, 30].map((n) => `<option value="${n}" ${n === 20 ? "selected" : ""}>${n} kartu</option>`).join("")}
      </select>
      <button class="btn" data-act="cardsGen">${cards.length ? "Tambah kartu" : "Buat flashcard"}</button> ${calls(1)}
    </section>
    ${cards.length ? `<details class="card"><summary>Lihat semua kartu (${cards.length})</summary>
      ${cards.map((c, i) => `<div class="term" style="margin-top:8px"><b>${esc(c.depan)}</b><br>${esc(c.belakang)}<br>
        <span class="small muted">${topicName(c.topikId) ? esc(topicName(c.topikId)) + " · " : ""}${c.due <= now ? "Jatuh tempo" : "Review berikutnya: " + fmtDate(c.due)}</span><br>
        ${cite(c.cek, c.kutipan)} <button class="btn sm danger" style="margin-top:8px" data-act="cardDel" data-i="${i}">Hapus</button></div>`).join("")}
    </details>` : ""}`;
}

async function startReview(docId, topikId) {
  const docs = docId ? [state.doc] : await DB.all();
  const now = Date.now();
  const map = {}, queue = [];
  for (const d of docs) {
    map[d.id] = d;
    for (const c of d.cards || []) {
      if (topikId ? c.topikId === topikId && (c.reps === 0 || c.due <= now) : c.due <= now) queue.push({ docId: d.id, cardId: c.id });
    }
  }
  if (!queue.length) return toast(topikId ? "Semua kartu topik ini sudah dihafal. Kartu akan muncul lagi sesuai jadwal." : "Tidak ada kartu yang jatuh tempo.");
  state.review = { docs: map, queue: shuffle(queue), idx: 0, flipped: false, done: 0, fromDoc: docId, fromTopic: topikId, fromTab: state.tab };
  state.view = "review";
  render();
}

function renderReview() {
  const r = state.review;
  if (r.idx >= r.queue.length) {
    app.innerHTML = `<div class="card" style="text-align:center"><h1>Selesai!</h1>
      <p>Kamu sudah mereview ${r.done} kartu. Kartu berikutnya akan muncul sesuai jadwal.</p>
      <button class="btn primary" data-act="reviewExit">Kembali</button></div>`;
    return;
  }
  const { docId, cardId } = r.queue[r.idx];
  const doc = r.docs[docId], c = doc.cards.find((x) => x.id === cardId);
  app.innerHTML = `<div class="stack">
    <div class="spread"><button class="link small" data-act="reviewExit">← Berhenti</button><span class="small muted">${r.idx + 1} / ${r.queue.length}</span></div>
    <div class="progress"><i style="width:${(r.idx / r.queue.length) * 100}%"></i></div>
    <p class="small muted" style="margin:0">${esc(doc.summary?.judul || doc.name)}</p>
    <div class="card fc" data-act="flip">
      <div>${esc(c.depan)}</div>
      ${r.flipped ? `<div class="back">${esc(c.belakang)}<br>${cite(c.cek, c.kutipan)}</div>` : `<p class="small muted" style="margin-top:16px">Ingat-ingat dulu jawabannya, lalu ketuk kartu.</p>`}
    </div>
    ${r.flipped ? `<p class="small muted" style="text-align:center;margin:0">Seberapa ingat kamu?</p><div class="grades">
      ${[[0, "Lupa", "g0"], [3, "Sulit", "g3"], [4, "Bisa", "g4"], [5, "Mudah", "g5"]].map(([q, l, g]) =>
        `<button class="btn ${g}" data-act="grade" data-q="${q}">${l}<small>${intervalText(c, q)}</small></button>`).join("")}</div>`
      : `<button class="btn primary block" data-act="flip">Tampilkan jawaban</button>`}
  </div>`;
}

async function grade(q) {
  const r = state.review;
  const { docId, cardId } = r.queue[r.idx];
  const doc = r.docs[docId];
  const i = doc.cards.findIndex((x) => x.id === cardId);
  doc.cards[i] = schedule(doc.cards[i], q);
  await DB.put(doc);
  if (q < 3) r.queue.push({ docId, cardId }); // ulangi lagi di sesi ini
  else r.done++;
  r.idx++; r.flipped = false;
  renderReview();
}

// ---- Tanya materi (chat) ----
function tabChat() {
  const chat = state.doc.chat;
  const sugg = ["Apa poin paling penting dari materi ini?", "Jelaskan bagian tersulit dengan bahasa sederhana", "Buatkan analogi untuk konsep utamanya", "Apa perbedaan antar konsep yang mirip di materi ini?"];
  return `
    <p class="small muted">AI hanya menjawab berdasarkan file ini. Jika tidak ada di materi, AI akan mengatakannya. Chat memakai model ringan agar hemat kuota.</p>
    <div class="chat" id="chatBox">
      ${chat.length ? chat.map((m) => m.role === "user" ? `<div class="msg user">${esc(m.text)}</div>` : `<div class="msg model prose">${linkRefs(md(m.text))}</div>`).join("")
        : `<div class="chips">${sugg.map((s) => `<button class="chip" data-act="chatSugg">${esc(s)}</button>`).join("")}</div>`}
      ${state.chatBusy ? `<div class="msg model typing">AI sedang membaca materi…</div>` : ""}
    </div>
    <form class="chat-form" id="chatForm">
      <textarea id="chatInput" rows="1" placeholder="Tanyakan sesuatu tentang materi…" aria-label="Pertanyaan" ${state.chatBusy ? "disabled" : ""}></textarea>
      <button class="btn primary" type="submit" ${state.chatBusy ? "disabled" : ""}>Kirim</button>
    </form>
    ${chat.length ? `<button class="link small" data-act="chatClear">Hapus percakapan</button>` : ""}`;
}
function afterChatRender() {
  const f = document.getElementById("chatForm"), input = document.getElementById("chatInput");
  f.onsubmit = (e) => { e.preventDefault(); sendChat(input.value); };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); sendChat(input.value); } };
  input.oninput = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; };
  if (state.doc.chat.length || state.chatBusy) f.scrollIntoView({ block: "end" });
}
async function sendChat(text) {
  text = text.trim();
  if (!text || state.chatBusy) return;
  const d = state.doc;
  d.chat.push({ role: "user", text });
  state.chatBusy = true;
  renderDoc();
  try {
    let hist = d.chat.slice(-12);
    while (hist.length && hist[0].role !== "user") hist = hist.slice(1);
    const reply = await AI.chat(d, hist);
    d.chat.push({ role: "model", text: reply || "(AI tidak memberi jawaban)" });
    await save();
  } catch (e) {
    d.chat.pop();
    toast(e.message, "err");
    state.chatBusy = false;
    renderDoc();
    document.getElementById("chatInput").value = text;
    return;
  }
  state.chatBusy = false;
  if (state.view === "doc" && state.doc === d && state.tab === "tanya") renderDoc();
}

// ---- Uji pemahaman (metode Feynman) ----
function tabFeynman() {
  const d = state.doc;
  const konsep = [...new Set([...d.topik.map((t) => t.judul), ...(d.summary?.istilah || []).map((t) => t.istilah)])].slice(0, 16);
  const last = d.feynman[0];
  const pre = state.feyPrefill;
  state.feyPrefill = "";
  return `
    <section class="card">
      <h2>Jelaskan dengan kata-katamu sendiri</h2>
      <p class="small muted">Metode Feynman: kalau kamu bisa menjelaskan sebuah konsep dengan sederhana, berarti kamu benar-benar paham. Tulis penjelasanmu tanpa melihat materi, lalu AI akan mencocokkannya dengan isi file.</p>
      ${konsep.length ? `<div class="chips" style="margin-bottom:12px">${konsep.map((k) => `<button class="chip" data-act="feyPick">${esc(k)}</button>`).join("")}</div>` : ""}
      <label class="field"><span>Konsep</span><input type="text" id="feyKonsep" placeholder="Contoh: fotosintesis" value="${esc(pre)}"></label>
      <label class="field"><span>Penjelasanmu</span><textarea id="feyText" rows="6" placeholder="Jelaskan seolah-olah kepada teman yang belum pernah belajar ini…"></textarea></label>
      <button class="btn primary block" data-act="feySubmit">Nilai penjelasanku</button>
      <p style="text-align:center;margin:8px 0 0">${calls(1)}</p>
    </section>
    ${last ? renderFeynman(last) : ""}
    ${d.feynman.length > 1 ? `<details class="card"><summary>Riwayat (${d.feynman.length - 1})</summary>
      ${d.feynman.slice(1).map((f) => `<div class="term" style="margin-top:8px"><b>${esc(f.konsep)}</b> · skor ${f.hasil.skor} · <span class="small muted">${fmtDate(f.at)}</span></div>`).join("")}</details>` : ""}`;
}
function renderFeynman(f) {
  const h = f.hasil;
  const color = h.skor >= 80 ? "var(--ok)" : h.skor >= 50 ? "var(--warn)" : "var(--bad)";
  return `<section class="card">
    <p class="small muted" style="margin:0">Hasil untuk: <b>${esc(f.konsep)}</b></p>
    <div class="score" style="margin:8px 0 12px"><div class="score-num" style="color:${color}">${h.skor}</div>
      <div style="flex:1"><div class="progress"><i style="width:${h.skor}%;background:${color}"></i></div><p class="small" style="margin:6px 0 0">${esc(h.ringkasan_penilaian)}</p></div></div>
    ${h.sudah_benar?.length ? `<h3 style="color:var(--ok)">Sudah tepat</h3><ul class="fb-list">${h.sudah_benar.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${h.keliru?.length ? `<h3 style="color:var(--bad)">Perlu diluruskan</h3><ul class="fb-list">${h.keliru.map((x) => `<li><s>${esc(x.pernyataan)}</s><br>${esc(x.koreksi)}<br>${cite(x.cek, x.kutipan)}</li>`).join("")}</ul>` : ""}
    ${h.terlewat?.length ? `<h3 style="color:var(--warn)">Belum kamu sebut</h3><ul class="fb-list">${h.terlewat.map((x) => `<li>${esc(x.poin)}<br>${cite(x.cek, x.kutipan)}</li>`).join("")}</ul>` : ""}
    ${h.saran ? `<h3>Saran</h3><p>${esc(h.saran)}</p>` : ""}
  </section>`;
}
async function submitFeynman() {
  const konsep = document.getElementById("feyKonsep").value.trim();
  const text = document.getElementById("feyText").value.trim();
  if (!konsep) return toast("Isi konsep yang ingin kamu jelaskan.", "err");
  if (text.split(/\s+/).length < 8) return toast("Penjelasanmu terlalu singkat. Tulis minimal satu-dua kalimat.", "err");
  await run("Mencocokkan penjelasanmu dengan materi…", async (status) => {
    const d = state.doc;
    const topik = d.topik.find((t) => t.judul.toLowerCase() === konsep.toLowerCase());
    const src = topik ? pagesFor(d, topik.lokasi) : d;
    const h = await AI.feynman(src, konsep, text, status);
    h.skor = Math.max(0, Math.min(100, Math.round(h.skor || 0)));
    for (const x of [...(h.keliru || []), ...(h.terlewat || [])]) x.cek = locateQuote(x.kutipan, d.pages);
    d.feynman.unshift({ konsep, penjelasan: text, hasil: h, at: Date.now() });
    d.feynman = d.feynman.slice(0, 30);
    if (topik) topik.feynmanSkor = h.skor;
    await save();
    renderDoc();
  });
}

// ---------- Pengaturan ----------
function modelOptions(list, selected, allowNone) {
  const ids = list.map((m) => m.id);
  const extra = selected && !ids.includes(selected) ? [{ id: selected, name: selected }] : [];
  return (allowNone ? `<option value="" ${!selected ? "selected" : ""}>Tidak pakai cadangan</option>` : "") +
    [...extra, ...list].map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(m.name === m.id ? m.id : `${m.name} (${m.id})`)}</option>`).join("");
}
function openSettings() {
  const s = AI.settings;
  openModal(`
    <h2>Pengaturan AI</h2>
    <p class="small">Aplikasi memakai <b>Google Gemini</b> dengan kuota gratis. Cara mendapatkan API key:</p>
    <ol class="small">
      <li>Buka <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> dan masuk dengan akun Google.</li>
      <li>Klik <b>Create API key</b>, lalu salin key-nya.</li>
      <li>Tempel di bawah ini, lalu klik <b>Cek &amp; simpan</b>.</li>
    </ol>
    <label class="field"><span>API key Gemini</span><input type="password" id="setKey" value="${esc(s.key)}" autocomplete="off" placeholder="AIza…"></label>
    <label class="field"><span>Model utama (untuk soal, peta materi, penilaian)</span><select id="setModel">${modelOptions([], s.model)}</select></label>
    <label class="field"><span>Model cadangan / ringan (untuk chat & flashcard, dan saat kuota model utama habis)</span><select id="setLite">${modelOptions([], s.lite, true)}</select></label>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" id="setVerify" ${s.verify ? "checked" : ""}> Periksa ulang soal oleh AI (lebih akurat, +1 panggilan per set soal)</label>
    <div class="row"><button class="btn primary" data-act="saveSettings">Cek &amp; simpan</button></div>

    <h3 style="margin-top:20px">Pemakaian hari ini</h3>
    ${usageHtml()}
    <p class="small muted" style="margin-top:8px">Setiap model punya kuota gratis harian sendiri, direset sekitar pukul 14.00–15.00 WIB. Batas resminya bisa berubah sewaktu-waktu — lihat <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noopener">halaman batas kuota Gemini</a>.</p>
    <button class="link small" data-act="resetQuota">Coba lagi model yang ditandai habis</button>

    <hr style="border:0;border-top:1px solid var(--line);margin:20px 0">
    <p class="small muted"><b>Privasi:</b> key disimpan hanya di browser ini. Isi file dikirim ke Google untuk diproses. Pada kuota gratis, Google dapat memakai data untuk meningkatkan layanannya — hindari mengunggah dokumen rahasia/pribadi.</p>`);
  if (s.key) loadModelLists(true);
}
async function loadModelLists(silent) {
  try {
    const models = (await AI.listModels()).sort((a, b) => /flash/i.test(b.id) - /flash/i.test(a.id));
    const ids = models.map((m) => m.id);
    const s = AI.settings;
    if (!ids.includes(s.model)) s.model = ids.includes(AI.DEFAULT_MODEL) ? AI.DEFAULT_MODEL : ids.find((x) => /flash/i.test(x) && !/lite|preview|exp/i.test(x)) || ids[0];
    if (s.lite && !ids.includes(s.lite)) s.lite = ids.find((x) => /flash-lite/i.test(x) && !/preview|exp/i.test(x)) || "";
    const m = document.getElementById("setModel"), l = document.getElementById("setLite");
    if (m) m.innerHTML = modelOptions(models, s.model);
    if (l) l.innerHTML = modelOptions(models.filter((x) => x.id !== s.model), s.lite, true);
    return true;
  } catch (e) {
    if (!silent) throw e;
    return false;
  }
}
async function saveSettings() {
  const key = document.getElementById("setKey").value.trim();
  if (!key) return toast("API key masih kosong.", "err");
  const s = AI.settings;
  const old = s.key;
  s.key = key;
  await run("Mengecek API key…", async () => {
    try { await AI.listModels(); }
    catch (e) { s.key = old; throw new Error("API key tidak bisa dipakai: " + e.message); }
    s.model = document.getElementById("setModel").value || s.model;
    s.lite = document.getElementById("setLite").value;
    if (s.lite === s.model) s.lite = "";
    s.verify = document.getElementById("setVerify").checked;
    AI.resetQuotaFlags();
    await loadModelLists(false);
    toast(`Tersimpan. Utama: ${s.model}${s.lite ? ` · Cadangan: ${s.lite}` : ""}`);
    if (state.view === "home") renderHome();
  });
}

// ---------- Cadangan ----------
async function exportData() {
  const docs = await DB.all();
  const blob = new Blob([JSON.stringify({ app: "maker-soal", version: 2, exportedAt: Date.now(), docs })], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `maker-soal-cadangan-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importData(file) {
  await run("Mengimpor data…", async () => {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error("File cadangan tidak valid."); }
    const docs = (data.docs || []).filter((d) => d && d.id && Array.isArray(d.pages));
    if (!docs.length) throw new Error("Tidak ada materi di file cadangan.");
    for (const d of docs) {
      Object.assign(d, { topik: d.topik || [], quizzes: d.quizzes || [], cards: d.cards || [], chat: d.chat || [], feynman: d.feynman || [] });
      await DB.put(d);
    }
    toast(`${docs.length} materi diimpor.`);
    renderHome();
  });
}

function viewText() {
  openModal(`<h2>Teks hasil baca file</h2>
    <p class="small muted">Inilah satu-satunya sumber yang dipakai AI. Jika ada bagian yang salah baca, hasil soal juga bisa terpengaruh.</p>
    ${state.doc.pages.map((p) => `<h3 style="margin-top:16px">${esc(p.label)}</h3><div class="source-text">${esc(p.text)}</div>`).join("")}`);
}

// ---------- Aksi (klik) ----------
const curTopic = () => state.doc.topik.find((t) => t.id === state.topicId);
const answerSet = (el) => (el.dataset.ctx === "topic" ? state.tAnswers : state.answers);
const afterAnswer = (el) => { if (el.dataset.ctx === "topic") checkTopicDone(); keepScroll(renderDoc); };

const actions = {
  home: () => { state.view = "home"; render(); },
  settings: openSettings,
  closeModal,
  saveSettings,
  resetQuota: () => { AI.resetQuotaFlags(); toast("Status kuota direset. Model akan dicoba lagi."); openSettings(); },
  open: (el) => openDoc(el.dataset.id),
  export: exportData,
  tab: (el) => { state.tab = el.dataset.tab; if (el.dataset.tab === "belajar") state.topicId = null; renderDoc(); },
  viewText,
  source: (el) => showSource(el.dataset.label, el.dataset.quote),
  sumRegen: () => run("Membuat ringkasan…", async (s) => {
    const r = await AI.summary(state.doc, document.getElementById("detailSel").value, s);
    applySummary(state.doc, r, document.getElementById("detailSel").value);
    await save(); renderDoc();
  }),

  // Belajar bertahap
  topicMapGen: async () => {
    if (state.doc.topik.some((t) => t.paket) && !confirm("Buat ulang peta materi? Kemajuan per topik akan direset (flashcard tetap tersimpan).")) return;
    await run("Membuat peta materi…", async (s) => {
      const r = await AI.topicMap(state.doc, s);
      state.doc.cards.forEach((c) => delete c.topikId);
      state.doc.topik = sanitizeTopics(state.doc, r.topik);
      await save(); renderDoc();
    });
  },
  topicOpen: (el) => { state.topicId = el.dataset.id; state.tAnswers = {}; state.tab = "belajar"; render(); },
  topicBack: () => { state.topicId = null; render(); },
  topicStart: () => startTopic(curTopic()),
  topicRetry: () => { state.tAnswers = {}; keepScroll(renderDoc); },
  topicNewQuiz: () => newTopicQuiz(curTopic()),
  topicFeynman: () => { state.feyPrefill = curTopic().judul; state.tab = "feynman"; render(); },
  reviewTopic: () => startReview(state.doc.id, state.topicId),
  weakQuiz: () => {
    const weak = weakTopics(state.doc);
    makeQuiz(pagesFor(state.doc, weak.flatMap((t) => t.lokasi)), {
      jumlah: Math.min(15, weak.length * 4), tingkat: "sedang", jenis: ["pilihan_ganda", "isian"], periksa: AI.settings.verify,
      fokus: `topik yang masih lemah: ${weak.map((t) => t.judul).join("; ")}`,
    }, "Latihan topik lemah", "Membuat latihan topik lemah…");
  },
  coverQuiz: () => {
    const used = usedLabels(state.doc);
    const pages = state.doc.pages.filter((p) => !used.has(p.label)).slice(0, 20);
    makeQuiz({ pages }, {
      jumlah: Math.min(15, Math.max(3, pages.length * 2)), tingkat: "sedang", jenis: ["pilihan_ganda", "isian"], periksa: AI.settings.verify,
      fokus: "buat minimal satu soal dari SETIAP bagian materi yang diberikan",
    }, "Bagian belum tercakup", "Membuat soal dari bagian yang belum tercakup…");
  },

  // Soal
  quizGen: genQuiz,
  mcq: (el) => { answerSet(el)[el.dataset.i] = el.dataset.l; afterAnswer(el); },
  reveal: (el) => { answerSet(el)[el.dataset.i] = "shown"; keepScroll(renderDoc); },
  selfMark: (el) => { answerSet(el)[el.dataset.i] = el.dataset.v; afterAnswer(el); },
  revealAll: () => { state.revealAll = !state.revealAll; keepScroll(renderDoc); },
  quizReset: () => { state.answers = {}; state.revealAll = false; renderDoc(); },
  quizDel: async () => {
    if (!confirm("Hapus set soal ini?")) return;
    state.doc.quizzes = state.doc.quizzes.filter((q) => q.id !== (state.quizId || state.doc.quizzes[0]?.id));
    state.quizId = state.doc.quizzes[0]?.id || null; state.answers = {};
    await save(); renderDoc();
  },
  print: printQuiz,
  localShuffle, localMatch, localGuess, localCheck,
  localClose: () => { state.local = null; keepScroll(renderDoc); },

  // Flashcard
  cardsGen: genCards,
  cardDel: async (el) => { state.doc.cards.splice(+el.dataset.i, 1); await save(); keepScroll(renderDoc); },
  reviewDoc: () => startReview(state.doc.id),
  reviewAll: () => startReview(null),
  flip: () => { if (!state.review.flipped) { state.review.flipped = true; renderReview(); } },
  grade: (el) => grade(+el.dataset.q),
  reviewExit: async () => {
    const { fromDoc, fromTopic, fromTab } = state.review;
    state.review = null;
    if (fromDoc) await openDoc(fromDoc, { tab: fromTab, topicId: fromTopic });
    else { state.view = "home"; render(); }
  },

  // Chat & Feynman
  chatSugg: (el) => sendChat(el.textContent),
  chatClear: async () => { if (!confirm("Hapus seluruh percakapan?")) return; state.doc.chat = []; await save(); renderDoc(); },
  feyPick: (el) => { document.getElementById("feyKonsep").value = el.textContent; document.getElementById("feyText").focus(); },
  feySubmit: submitFeynman,
  docDelete: async () => {
    if (!confirm(`Hapus materi "${state.doc.name}" beserta semua soal, kartu, dan percakapannya? Tindakan ini tidak bisa dibatalkan.`)) return;
    await DB.del(state.doc.id); state.view = "home"; render();
  },
};
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "LABEL") return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "quizSel") { state.quizId = e.target.value; state.answers = {}; state.revealAll = false; renderDoc(); }
  if (e.target.id === "setModel") {
    const l = document.getElementById("setLite");
    if (l && l.value === e.target.value) l.value = "";
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
