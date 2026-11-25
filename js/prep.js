// "Siapkan semua modul": satu folder mata kuliah disiapkan otomatis —
// ringkasan + peta materi tiap modul, lalu penjelasan, flashcard, dan soal untuk SEMUA topik.
// Bisa dihentikan & dilanjutkan; yang sudah siap tidak diulang.

const normDoc = (d) => Object.assign(d, { topik: d.topik || [], feynman: d.feynman || [], quizzes: d.quizzes || [], cards: d.cards || [], chat: d.chat || [] });

// Perkiraan pekerjaan yang tersisa di folder
function prepNeeds(docs) {
  const k = AI.settings.verify ? 2 : 1;
  let setup = 0, todo = 0, calls = 0;
  for (const d of docs) {
    const tp = d.topik || [];
    if (!d.summary || !tp.length) {
      setup++;
      calls += setupCalls(d);
      const n = tp.length || nTopics(docChars(d.pages));
      todo += n; calls += Math.ceil(n / TOPIC_BATCH) * k;
    } else {
      const u = tp.filter((t) => !t.paket).length;
      todo += u; calls += Math.ceil(u / TOPIC_BATCH) * k;
    }
  }
  return { setup, todo, calls };
}

// Ambil versi terbaru sebuah modul; jika sedang dibuka, pakai yang di layar agar kemajuan belajar tidak tertimpa
async function latestDoc(id) {
  if (state.doc?.id === id) return state.doc;
  const d = await DB.get(id);
  return d && normDoc(d);
}
async function commitDoc(id, mutate) {
  const d = await latestDoc(id);
  if (!d) return null;
  mutate(d);
  await DB.put(d);
  if (state.view === "doc" && state.doc?.id === id && !state.topicId && state.tab === "belajar") renderDoc();
  return d;
}

function prepCard(name, docs) {
  const P = state.prep?.kursus === name ? state.prep : null;
  if (P?.phase === "running") {
    return `<section class="card">
      <h2>Menyiapkan semua modul…</h2>
      <div class="progress" style="margin:10px 0"><i id="prepBar" style="width:${Math.min(100, (P.done / P.total) * 100)}%"></i></div>
      <p id="prepStatus" class="small">${esc(P.status)}</p>
      <p class="small muted">Modul yang sudah siap bisa langsung dibuka. Biarkan aplikasi tetap terbuka sampai selesai.</p>
      <button class="btn sm" data-act="prepStop">Hentikan</button>
    </section>`;
  }
  const need = prepNeeds(docs);
  if (!need.setup && !need.todo) {
    return P?.phase === "done" ? `<section class="card"><h2>Semua modul siap ✓</h2>
      <p class="small">Ringkasan, peta materi, penjelasan, flashcard, dan soal untuk setiap topik sudah dibuat. Buka modul mana saja untuk mulai membaca atau mengerjakan soal.</p></section>` : "";
  }
  const paused = P?.phase === "paused";
  return `<section class="card ${paused ? "notice" : ""}">
    <h2>${paused ? "Persiapan terhenti" : "Siapkan semua modul otomatis"}</h2>
    ${paused ? `<p>${esc(P.error)}</p>` : ""}
    <p class="small">Ringkasan, peta materi, penjelasan tiap topik, flashcard, dan soal dibuat sekaligus untuk ${need.setup ? `${need.setup} modul baru (±${need.todo} topik)` : `${need.todo} topik yang belum disiapkan`}. Setelah itu tinggal dibaca dan dikerjakan.</p>
    <p class="small muted">Memakai ±${need.calls} panggilan AI. Jika kuota habis di tengah jalan, klik lagi nanti/besok — yang sudah siap tidak diulang.</p>
    <button class="btn primary block" data-act="prepStart" data-name="${esc(name)}">${paused ? "Lanjutkan" : "Siapkan semua"}</button>
  </section>`;
}

async function runPrep(kursus) {
  if (state.prep?.phase === "running") return toast("Persiapan folder lain masih berjalan. Tunggu atau hentikan dulu.", "err");
  if (!AI.settings.key) { openSettings(); return toast("Isi API key dulu.", "err"); }
  const docs0 = (await DB.all()).filter((d) => d.kursus === kursus).sort((a, b) => byName(modName(a), modName(b)));
  const k = AI.settings.verify ? 2 : 1;
  const P = state.prep = { kursus, phase: "running", status: "Memulai…", error: null, stopReq: false, done: 0, total: Math.max(1, prepNeeds(docs0).calls), failed: 0 };
  const refresh = () => {
    if (state.view === "folder" && state.folder === kursus) { const y = scrollY; renderFolder().then(() => scrollTo(0, y)); }
  };
  const status = (s) => {
    P.status = s;
    const el = document.getElementById("prepStatus"); if (el) el.textContent = s;
    const bar = document.getElementById("prepBar"); if (bar) bar.style.width = Math.min(100, (P.done / P.total) * 100) + "%";
  };
  const stopCheck = () => { if (P.stopReq) throw new Error("stop"); };
  window.onbeforeunload = () => "Persiapan materi masih berjalan.";
  refresh();
  const tried = new Set();
  try {
    for (const d0 of docs0) {
      const name = modName(d0);
      let d = await latestDoc(d0.id);
      if (!d) continue;
      if (!d.summary || !d.topik.length) {
        stopCheck();
        status(`${name}: membuat ringkasan & peta materi…`);
        const s = await buildSetup(d, (x) => status(`${name}: ${x}`));
        d = await commitDoc(d.id, (doc) => {
          applySummary(doc, s, "sedang");
          if (!doc.topik.length) doc.topik = sanitizeTopics(doc, s.topik);
        });
        P.done += setupCalls(d);
        refresh();
      }
      for (;;) {
        const t = d.topik.find((x) => !x.paket && !tried.has(x.id));
        if (!t) break;
        stopCheck();
        const batch = topicBatch(d, t).filter((x) => !tried.has(x.id));
        batch.forEach((x) => tried.add(x.id));
        const nums = batch.map((x) => d.topik.indexOf(x) + 1);
        status(`${name}: menyiapkan topik ${nums.join(", ")} dari ${d.topik.length}…`);
        const res = await prepareTopics(d, batch, (x) => status(`${name}: ${x}`));
        // Topik yang belum berhasil (selain yang pertama) diberi kesempatan lagi di kelompok berikutnya
        batch.forEach((x) => { if (x !== t && !res.some((r) => r.topikId === x.id)) tried.delete(x.id); });
        d = await commitDoc(d.id, (doc) => applyPacks(doc, res));
        P.done += k;
        refresh();
      }
    }
    const after = (await DB.all()).filter((d) => d.kursus === kursus);
    P.failed = after.reduce((n, d) => n + (d.topik || []).filter((t) => !t.paket).length, 0);
    P.phase = "done";
    toast(P.failed ? `Folder "${kursus}" hampir siap: ${P.failed} topik gagal disiapkan (bisa dibuka manual).` : `Semua modul "${kursus}" sudah siap dipelajari.`);
  } catch (e) {
    console.error(e);
    P.phase = "paused";
    P.error = P.stopReq ? "Dihentikan. Klik Lanjutkan untuk meneruskan — yang sudah siap tidak diulang." : e.message || String(e);
    if (!P.stopReq) toast("Persiapan terhenti: " + P.error, "err");
  } finally {
    window.onbeforeunload = null;
    P.stopReq = false;
    status(P.phase === "done" ? "Selesai." : P.error);
    refresh();
  }
}

Object.assign(actions, {
  prepStart: (el) => runPrep(el.dataset.name || state.folder),
  prepStop: (el) => {
    if (!state.prep) return;
    state.prep.stopReq = true;
    el.disabled = true; el.textContent = "Menghentikan…";
    AI.cancel();
  },
});
