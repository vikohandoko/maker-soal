// Alat "Gambar → PDF": folder screenshot modul → OCR → 1 PDF bisa dicari (bookmark per modul) + materi belajar.
// Struktur yang didukung:  Hukum Adat/Modul 1/*.png, Hukum Adat/Modul 2/*.png, ...
const BLANK_RE = /^\s*\[halaman kosong\]\s*$/i;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Gagal memuat " + src));
    document.head.appendChild(s);
  });
}

// Kelompokkan file dari "Pilih folder" berdasarkan subfolder → modul
function groupFolder(files) {
  const imgs = [...files].filter(isImageFile);
  const skipped = files.length - imgs.length;
  let root = "";
  const groups = new Map();
  for (const f of imgs) {
    const parts = (f.webkitRelativePath || f.name).split("/");
    root ||= parts.length > 1 ? parts[0] : "";
    const name = parts.length > 2 ? parts.slice(1, -1).join(" / ") : "Gambar di folder utama";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  }
  const modules = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }))
    .map(([name, fs]) => ({ name, files: naturalSort(fs), texts: [], done: false, docId: null, reused: false }));
  return { root, modules, skipped };
}

function startImgJob(files, single) {
  const g = single
    ? { root: "", modules: [{ name: "Modul", files: naturalSort([...files].filter(isImageFile)), texts: [], done: false, docId: null, reused: false }], skipped: 0 }
    : groupFolder(files);
  if (!g.modules.length || !g.modules.some((m) => m.files.length)) return toast("Tidak ada gambar (PNG/JPG/WEBP) di folder itu.", "err");
  state.imgJob = {
    phase: "preview", kursus: g.root || "Materi", modules: g.modules, skipped: g.skipped,
    ocr: true, simpan: true, error: null, status: "", built: false,
  };
  renderImgTool();
}

const jobPages = (J) => J.modules.reduce((n, m) => n + m.files.length, 0);
const jobDone = (J) => J.modules.reduce((n, m) => n + (m.done ? m.files.length : m.texts.length), 0);

// ---------- Tampilan ----------
function renderImgTool() {
  const J = state.imgJob;
  state.view = "images";
  if (!J) {
    app.innerHTML = `<div class="stack">
      <button class="link small" data-act="home">← Beranda</button>
      <section class="card">
        <h1>Gambar → PDF</h1>
        <p>Ubah screenshot halaman modul menjadi <b>satu PDF yang bisa dicari</b> (Ctrl+F), dengan penanda (bookmark) per modul. Tulisan di setiap gambar dibaca dengan OCR AI dan bisa langsung disimpan sebagai materi belajar.</p>
        <p class="small muted">Contoh susunan folder:<br><code>Hukum Adat / Modul 1 / Screenshot (1).png …</code><br><code>Hukum Adat / Modul 2 / …</code><br>Pilih folder utamanya (<b>Hukum Adat</b>). Setiap subfolder dianggap satu modul, dan gambar diurutkan menurut nama file.</p>
        <label class="btn primary block">Pilih folder utama<input type="file" id="imgFolder" webkitdirectory directory multiple hidden></label>
        <p class="small muted" style="text-align:center;margin:10px 0 4px">atau, untuk satu modul saja:</p>
        <label class="btn block">Pilih beberapa gambar<input type="file" id="imgFiles" accept="image/*" multiple hidden></label>
      </section></div>`;
    document.getElementById("imgFolder").onchange = (e) => e.target.files.length && startImgJob(e.target.files, false);
    document.getElementById("imgFiles").onchange = (e) => e.target.files.length && startImgJob(e.target.files, true);
    return;
  }

  const total = jobPages(J), done = jobDone(J);
  const calls = J.modules.reduce((n, m) => n + (m.done ? 0 : Math.ceil((m.files.length - m.texts.length) / OCR_BATCH)), 0);
  const running = J.phase === "running";
  const modList = `<div class="card list">${J.modules.map((m, i) => {
    const st = m.reused ? "sudah dibaca sebelumnya" : m.done ? "selesai" : m.texts.length ? `${m.texts.length}/${m.files.length} halaman` : "menunggu";
    const cls = m.done ? "s-dikuasai" : m.texts.length ? "s-sedang" : "";
    return `<div class="topic-row" style="cursor:default">
      <span class="tnum ${cls}">${i + 1}</span>
      <div class="info"><div class="title">${esc(m.name)}</div>
        <div class="small muted">${m.files.length} gambar · ${esc(m.files[0]?.name || "")}${m.files.length > 1 ? " … " + esc(m.files[m.files.length - 1].name) : ""}</div></div>
      <span class="pill ${cls}">${st}</span>
      ${m.done && m.docId ? `<button class="btn sm" data-act="open" data-id="${m.docId}" ${running ? "disabled" : ""}>Buka</button>` : ""}
    </div>`;
  }).join("")}</div>`;

  let main = "";
  if (J.phase === "preview") {
    main = `<section class="card">
      <label class="field"><span>Nama mata kuliah / judul PDF</span><input type="text" id="imgKursus" value="${esc(J.kursus)}"></label>
      <p class="small">${J.modules.length} modul · ${total} gambar${J.skipped ? ` · ${J.skipped} file bukan gambar diabaikan` : ""}.</p>
      <label class="check" style="margin-bottom:8px"><input type="checkbox" id="imgOcr" ${J.ocr ? "checked" : ""}> Baca tulisan (OCR) — PDF bisa dicari &amp; bisa dipelajari di aplikasi</label>
      <label class="check" style="margin-bottom:12px"><input type="checkbox" id="imgSimpan" ${J.simpan ? "checked" : ""}> Simpan tiap modul sebagai materi belajar</label>
      <p class="small muted">OCR memakai ±${calls} panggilan AI (8 gambar per panggilan). Modul yang sudah pernah dibaca dengan nama yang sama akan dilewati. Tanpa OCR, PDF dibuat gratis tanpa AI.</p>
      <div class="row"><button class="btn primary" data-act="imgStart">Mulai</button><button class="btn" data-act="imgReset">Batal</button></div>
    </section>`;
  } else if (running || J.phase === "building") {
    main = `<section class="card">
      <h2>${J.phase === "building" ? "Membuat PDF…" : "Membaca tulisan…"}</h2>
      <div class="progress" style="margin:10px 0"><i id="imgBar" style="width:${(done / total) * 100}%"></i></div>
      <p id="imgStatus" class="small">${esc(J.status)}</p>
      <p id="imgSub" class="small muted"></p>
      <p class="small muted">Biarkan halaman ini tetap terbuka. Satu kelompok 8 gambar biasanya selesai dalam 15–60 detik. Modul yang sudah selesai langsung tersimpan, jadi kalau terhenti kamu bisa melanjutkan.</p>
      ${running ? `<button class="btn sm" data-act="imgStop">Hentikan</button>` : ""}
    </section>`;
  } else if (J.phase === "paused") {
    main = `<section class="card notice">
      <h2>Terhenti</h2>
      <p>${esc(J.error)}</p>
      <p class="small">${done} dari ${total} halaman sudah terbaca. Modul yang selesai sudah tersimpan.</p>
      <div class="row"><button class="btn primary" data-act="imgStart">Lanjutkan</button>
      <button class="btn" data-act="imgPdf">Buat PDF dari yang sudah ada</button></div>
      <p class="small muted" style="margin-top:8px">Jika kuota harian habis: lanjutkan besok. Pilih folder yang sama lagi — modul yang sudah selesai akan dilewati otomatis.</p>
    </section>`;
  } else if (J.phase === "done") {
    const saved = J.modules.filter((m) => m.docId).length;
    main = `<section class="card">
      <h2>Selesai</h2>
      <p>${total} halaman dari ${J.modules.length} modul${J.ocr ? " sudah dibaca" : ""}.${saved ? ` ${saved} modul tersimpan sebagai materi belajar.` : ""}</p>
      <div class="stack-sm">
        <button class="btn primary block" data-act="imgPdf">Unduh PDF “${esc(J.kursus)}.pdf”</button>
        ${J.ocr ? `<button class="btn block" data-act="imgTxt">Unduh teks hasil OCR (.txt)</button>` : ""}
        <button class="btn block" data-act="imgReset">Proses folder lain</button>
      </div>
      ${J.ocr ? `<p class="small muted" style="margin-top:10px">Cek hasil bacaan tiap modul lewat tombol <b>Buka</b> → "Teks hasil baca file". Ringkasan & peta materi tiap modul dibuat saat kamu membuka tab Belajar bertahap.</p>` : ""}
    </section>`;
  }

  app.innerHTML = `<div class="stack">
    ${running || J.phase === "building" ? "" : `<button class="link small" data-act="home">← Beranda</button>`}
    <h1>${esc(J.kursus)}</h1>
    ${main}
    <h2>Modul</h2>${modList}
  </div>`;
}

function setImgStatus(s) {
  const J = state.imgJob;
  J.status = s;
  const el = document.getElementById("imgStatus");
  if (el) el.textContent = s;
  const bar = document.getElementById("imgBar");
  if (bar) bar.style.width = (jobDone(J) / jobPages(J)) * 100 + "%";
}

// ---------- Proses OCR (bisa dilanjutkan) ----------
async function runImgJob() {
  const J = state.imgJob;
  if (J.phase === "preview") {
    J.kursus = document.getElementById("imgKursus").value.trim() || J.kursus;
    J.ocr = document.getElementById("imgOcr").checked;
    J.simpan = J.ocr && document.getElementById("imgSimpan").checked;
  }
  if (!J.ocr) { J.phase = "done"; renderImgTool(); return buildImgPdf(); }
  if (!AI.settings.key) { openSettings(); return toast("Isi API key dulu untuk membaca tulisan (OCR).", "err"); }

  // Lewati modul yang sudah pernah dibaca (nama mata kuliah + modul + jumlah gambar sama)
  const docs = await DB.all();
  for (const m of J.modules) {
    if (m.done) continue;
    const d = docs.find((x) => x.kursus === J.kursus && x.modul === m.name && x.nGambar === m.files.length);
    if (d) {
      const byLabel = Object.fromEntries(d.pages.map((p) => [p.label, p.text]));
      m.texts = m.files.map((_, i) => byLabel[`Halaman ${i + 1}`] || "");
      m.done = true; m.reused = true; m.docId = d.id;
    }
  }

  J.phase = "running"; J.error = null;
  renderImgTool();
  window.onbeforeunload = () => "Proses masih berjalan.";
  try {
    for (const m of J.modules) {
      if (m.done) continue;
      if (J.simpan) m.docId ||= uid();
      while (m.texts.length < m.files.length) {
        const start = m.texts.length;
        const batch = m.files.slice(start, start + OCR_BATCH);
        setImgStatus(`${m.name}: menyiapkan halaman ${start + 1}–${start + batch.length}…`);
        const imgs = [];
        for (const f of batch) imgs.push(await prepImage(f));
        // Simpan gambar halaman agar bisa dilihat di materi (tabel/diagram tampil utuh)
        if (J.simpan) await saveBlobs(m.docId, imgs.map((g, k) => ({ key: `img|Halaman ${start + k + 1}`, blob: b64ToBlob(g.data) })));
        if (J.stopReq) throw new Error("stop");
        setImgStatus(`${m.name}: membaca halaman ${start + 1}–${start + batch.length} dari ${m.files.length}…`);
        // Tampilkan detik berjalan + kabar dari AI (pindah model, menunggu batas per menit) agar tidak terlihat macet
        const t0 = Date.now();
        let sub = "";
        const showSub = () => { const el = document.getElementById("imgSub"); if (el) el.textContent = `Menunggu jawaban AI… ${Math.round((Date.now() - t0) / 1000)} detik${sub ? " · " + sub : ""}`; };
        const tick = setInterval(showSub, 1000);
        try { m.texts.push(...(await ocrBatch(imgs, (s) => { sub = s; showSub(); }))); }
        finally { clearInterval(tick); const el = document.getElementById("imgSub"); if (el) el.textContent = ""; }
        setImgStatus(`${m.name}: ${m.texts.length}/${m.files.length} halaman terbaca`);
      }
      m.done = true;
      if (J.simpan) await saveModuleDoc(J, m);
      renderImgTool();
    }
    J.phase = "done";
  } catch (e) {
    console.error(e);
    J.phase = "paused";
    J.error = J.stopReq ? "Dihentikan. Klik Lanjutkan untuk meneruskan dari halaman terakhir." : e.message || String(e);
  } finally {
    window.onbeforeunload = null;
    J.stopReq = false;
  }
  renderImgTool();
}

async function saveModuleDoc(J, m) {
  const pages = m.texts.map((t, i) => ({ label: `Halaman ${i + 1}`, text: BLANK_RE.test(t) ? "" : t })).filter((p) => p.text.trim());
  if (!pages.length) return;
  const doc = {
    id: m.docId || uid(), createdAt: Date.now(),
    name: `${J.kursus} – ${m.name}`, kursus: J.kursus, modul: m.name, nGambar: m.files.length,
    pages, method: "ocr", truncated: false, totalPages: pages.length,
    summary: null, topik: [], quizzes: [], cards: [], chat: [], feynman: [],
  };
  await DB.put(doc);
  m.docId = doc.id;
}

// ---------- PDF ----------
// Font standar PDF hanya mendukung huruf Latin (Windows-1252); karakter lain dibuang dari lapisan teks
const pdfSafe = (s) => s.normalize("NFKC").replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, " ");

async function buildImgPdf() {
  const J = state.imgJob;
  const prev = J.phase;
  J.phase = "building";
  renderImgTool();
  window.onbeforeunload = () => "PDF sedang dibuat.";
  try {
    await loadScript("vendor/jspdf.umd.min.js");
    const { jsPDF } = window.jspdf;
    let pdf = null, pageNo = 0, n = 0;
    const total = jobPages(J);
    for (const m of J.modules) {
      for (let i = 0; i < m.files.length; i++) {
        setImgStatus(`Menyusun halaman ${++n} dari ${total} (${m.name})…`);
        const img = await prepImage(m.files[i], 1800, 0.85);
        const w = 595, h = Math.round((595 * img.h) / img.w);
        const orient = h >= w ? "p" : "l";
        if (!pdf) pdf = new jsPDF({ unit: "pt", format: [w, h], orientation: orient, compress: true });
        else pdf.addPage([w, h], orient);
        pageNo++;
        if (i === 0) pdf.outline.add(null, pdfSafe(m.name), { pageNumber: pageNo });
        pdf.addImage("data:image/jpeg;base64," + img.data, "JPEG", 0, 0, w, h, undefined, "FAST");
        const text = m.texts[i] && !BLANK_RE.test(m.texts[i]) ? pdfSafe(m.texts[i]) : "";
        if (text.trim()) {
          // Lapisan teks tak terlihat di atas gambar → bisa dicari (Ctrl+F) & disalin
          pdf.setFont("helvetica");
          let fs = 9, lines;
          for (; fs >= 2; fs -= 0.5) {
            pdf.setFontSize(fs);
            lines = pdf.splitTextToSize(text, w - 24);
            if (lines.length * fs * 1.15 <= h - 24) break;
          }
          pdf.text(lines, 12, 12 + fs, { renderingMode: "invisible", lineHeightFactor: 1.15 });
        }
        if (n % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // beri jeda agar layar tetap responsif
      }
    }
    setImgStatus("Menyimpan file PDF…");
    pdf.save(`${J.kursus.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`);
    J.built = true;
    toast("PDF diunduh. Cek folder Unduhan (Downloads).");
  } catch (e) {
    console.error(e);
    toast("Gagal membuat PDF: " + (e.message || e), "err");
  } finally {
    window.onbeforeunload = null;
    J.phase = prev === "paused" ? "paused" : "done";
    renderImgTool();
  }
}

function downloadImgText() {
  const J = state.imgJob;
  const txt = J.modules.map((m) => `===== ${m.name} =====\n\n` +
    m.texts.map((t, i) => `--- Halaman ${i + 1} (${m.files[i]?.name || ""}) ---\n${BLANK_RE.test(t) ? "" : t}`).join("\n\n")).join("\n\n\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain;charset=utf-8" }));
  a.download = `${J.kursus.replace(/[\\/:*?"<>|]+/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

Object.assign(actions, {
  imgTool: () => { renderImgTool(); scrollTo(0, 0); },
  imgStart: () => runImgJob(),
  imgStop: (el) => {
    if (!state.imgJob) return;
    state.imgJob.stopReq = true;
    el.disabled = true; el.textContent = "Menghentikan…";
    AI.cancel();
  },
  imgReset: () => { state.imgJob = null; renderImgTool(); },
  imgPdf: () => buildImgPdf(),
  imgTxt: downloadImgText,
});
