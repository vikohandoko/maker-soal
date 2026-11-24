// Simulasi Ujian per folder mata kuliah: soal campuran dari beberapa modul, dibagi rata,
// tanpa kunci selama ujian, pengatur waktu opsional, hasil dirinci per modul.
const EXAM_MODS_PER_CALL = 4; // satu panggilan AI melayani hingga 4 modul (hemat kuota)

// ---------- Kartu di halaman folder ----------
async function examCard(kursus, docs) {
  const exams = (await DB.exams.all()).filter((e) => e.kursus === kursus).sort((a, b) => b.createdAt - a.createdAt);
  return `<section class="card">
    <div class="spread"><h2 style="margin:0">Simulasi Ujian</h2><button class="btn primary sm" data-act="examSetup">Buat simulasi</button></div>
    <p class="small muted" style="margin-top:8px">Soal campuran dari ${docs.length} modul, dibagi rata per modul. Kunci jawaban baru terlihat setelah selesai — seperti ujian sungguhan.</p>
    ${exams.length ? `<div class="list" style="margin-top:8px">${exams.slice(0, 10).map((e) => {
      const r = e.finishedAt ? examScore(e) : null;
      const pct = r ? Math.round((r.correct / r.total) * 100) : null;
      return `<div class="doc-item" style="padding:10px 0">
        <div class="info" data-act="examOpen" data-id="${e.id}">
          <div class="title">${e.label ? esc(e.label) : `${e.soal.length} soal · ${new Set(e.soal.map((s) => s.docId)).size} modul`}</div>
          <div class="small muted">${fmtDate(e.createdAt)} · ${r ? `nilai <b class="${pct >= 80 ? "ok-t" : pct >= 60 ? "warn-t" : ""}" ${pct < 60 ? 'style="color:var(--bad)"' : ""}>${pct}</b>` : `<span class="warn-t">belum selesai — ${Object.keys(e.answers || {}).length}/${e.soal.length} dijawab</span>`}</div>
        </div>
        <button class="btn sm" data-act="examOpen" data-id="${e.id}">${r ? "Lihat" : "Lanjutkan"}</button>
      </div>`;
    }).join("")}</div>` : ""}
  </section>`;
}

// ---------- Pengaturan ----------
async function openExamSetup(prev) {
  const docs = (await DB.all()).filter((d) => d.kursus === state.folder).sort((a, b) => byName(modName(a), modName(b)));
  const o = prev || {};
  const chosen = new Set(o.docIds || docs.map((d) => d.id));
  const jenis = o.jenis || ["pilihan_ganda"];
  const verify = AI.settings.verify;
  openModal(`<h2>Simulasi Ujian</h2>
    <div class="field"><span class="small" style="font-weight:600;display:block;margin-bottom:6px">Modul yang diujikan</span>
      <div class="row" style="margin-bottom:6px"><button class="link small" data-act="exAll" data-v="1">Pilih semua</button><button class="link small" data-act="exAll" data-v="0">Kosongkan</button></div>
      <div class="checks">${docs.map((d) => `<label class="check"><input type="checkbox" name="exMod" value="${d.id}" ${chosen.has(d.id) ? "checked" : ""}>${esc(modName(d))}</label>`).join("")}</div>
      <p class="small muted" style="margin-top:6px">Contoh: centang Modul 1–6 untuk latihan UTS.</p></div>
    <div class="grid2">
      <label class="field"><span>Jumlah soal</span><select id="exJumlah">${[10, 20, 30, 40, 50, 60].map((n) => `<option ${n === (o.jumlah || 30) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="field"><span>Tingkat kesulitan</span><select id="exTingkat">${["mudah", "sedang", "sulit"].map((t) => `<option ${(o.tingkat || "sedang") === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    </div>
    <div class="field"><span class="small" style="font-weight:600;display:block;margin-bottom:4px">Jenis soal</span><div class="checks">
      <label class="check"><input type="checkbox" name="exJenis" value="pilihan_ganda" ${jenis.includes("pilihan_ganda") ? "checked" : ""}>Pilihan ganda</label>
      <label class="check"><input type="checkbox" name="exJenis" value="isian" ${jenis.includes("isian") ? "checked" : ""}>Isian singkat</label></div></div>
    <label class="check" style="margin:4px 0 8px"><input type="checkbox" id="exTimer" ${o.menit !== 0 ? "checked" : ""}> Pakai pengatur waktu</label>
    <label class="field" id="exMenitWrap" ${o.menit === 0 ? "hidden" : ""}><span>Waktu (menit)</span><input type="number" id="exMenit" min="5" max="240" value="${o.menit || 45}"></label>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" id="exPeriksa" ${verify ? "checked" : ""}> Periksa ulang setiap soal (lebih akurat)</label>
    <p class="small muted" id="exCalls"></p>
    <button class="btn primary block" data-act="examCreate">Buat &amp; mulai simulasi</button>`);
  updateExamCalls();
}
function readExamSetup() {
  return {
    docIds: [...document.querySelectorAll("input[name=exMod]:checked")].map((i) => i.value),
    jumlah: +document.getElementById("exJumlah").value,
    tingkat: document.getElementById("exTingkat").value,
    jenis: [...document.querySelectorAll("input[name=exJenis]:checked")].map((i) => i.value),
    menit: document.getElementById("exTimer").checked ? Math.max(5, +document.getElementById("exMenit").value || 45) : 0,
    periksa: document.getElementById("exPeriksa").checked,
  };
}
function updateExamCalls() {
  const el = document.getElementById("exCalls");
  if (!el) return;
  const o = readExamSetup();
  const g = Math.ceil(Math.min(o.docIds.length, o.jumlah) / EXAM_MODS_PER_CALL);
  el.textContent = o.docIds.length ? `${o.docIds.length} modul → sekitar ${Math.floor(o.jumlah / o.docIds.length) || 1} soal per modul. Memakai ±${g * (o.periksa ? 2 : 1)} panggilan AI.` : "Pilih minimal satu modul.";
}

// ---------- Membuat soal ----------
async function createExam(o) {
  if (!o.docIds.length) return toast("Pilih minimal satu modul.", "err");
  if (!o.jenis.length) return toast("Pilih minimal satu jenis soal.", "err");
  closeModal();
  await run("Menyiapkan simulasi ujian…", async (status) => {
    const all = await DB.all();
    const docs = all.filter((d) => o.docIds.includes(d.id)).sort((a, b) => byName(modName(a), modName(b)));
    const n = docs.length;
    // Bagi rata: sisa soal diberikan ke modul-modul awal
    const dist = docs.map((d, i) => ({ d, k: Math.floor(o.jumlah / n) + (i < o.jumlah % n ? 1 : 0) })).filter((x) => x.k > 0);
    const prevExams = (await DB.exams.all()).filter((e) => e.kursus === state.folder);
    const hindari = [...docs.flatMap((d) => allSoal(d)), ...prevExams.flatMap((e) => e.soal)].map((s) => s.pertanyaan);
    const hindariPick = shuffle([...new Set(hindari)]).slice(0, 80);
    const groups = [];
    for (let i = 0; i < dist.length; i += EXAM_MODS_PER_CALL) groups.push(dist.slice(i, i + EXAM_MODS_PER_CALL));

    const soal = [];
    let dropped = 0;
    for (const [gi, g] of groups.entries()) {
      const names = g.map((x) => modName(x.d));
      status(`Membuat soal ${names[0]}${g.length > 1 ? "–" + names[names.length - 1] : ""} (${gi + 1}/${groups.length})…`);
      const budget = Math.min(60000, Math.floor(CHUNK_CHARS / g.length));
      const src = { pages: g.flatMap((x) => samplePages(x.d.pages, budget, usedLabels(x.d)).map((p) => ({ label: `${modName(x.d)} · ${p.label}`, text: p.text }))) };
      const r = await AI.exam(src, g.map((x) => ({ name: modName(x.d), k: x.k })), o, hindariPick, status);
      // Tentukan modul asal tiap soal dari letak kutipannya di file (bukan sekadar klaim AI)
      const locate = (s) => {
        let d = g.find((x) => modName(x.d) === s.modul)?.d;
        let c = d ? locateQuote(s.kutipan, d.pages) : { status: "tidak", label: null };
        if (c.status === "tidak") for (const x of g) { const c2 = locateQuote(s.kutipan, x.d.pages); if (c2.status !== "tidak") { d = x.d; c = c2; break; } }
        if (d) { s.docId = d.id; s.modul = modName(d); }
        return c;
      };
      const res = await processSoal(src, r.soal, status, o.periksa, locate);
      // Ujian harus pasti benar: buang soal yang sumbernya tidak ditemukan di file
      const ok = res.soal.filter((s) => s.cek.status !== "tidak" && s.docId);
      dropped += res.soal.length - ok.length + res.info.dibuang + res.info.formatRusak;
      soal.push(...ok);
    }
    if (!soal.length) throw new Error("Tidak ada soal yang lolos pemeriksaan. Coba lagi.");
    const exam = { id: uid(), kursus: state.folder, createdAt: Date.now(), opts: o, soal: shuffleSoal(soal), answers: {}, marks: {}, startedAt: Date.now(), finishedAt: null, info: { diminta: o.jumlah, dibuang: dropped } };
    await DB.exams.put(exam);
    await openExam(exam.id);
    if (soal.length < o.jumlah) toast(`${soal.length} soal siap (${o.jumlah - soal.length} soal dibuang karena tidak lolos pemeriksaan).`);
  });
}

// Simulasi tanpa AI dari soal yang sudah ada (ulang / soal salah)
async function createLocalExam(src, soal, label, menit) {
  const exam = { id: uid(), kursus: src.kursus, createdAt: Date.now(), opts: { ...src.opts, menit }, soal: shuffleSoal(soal).map((s) => { delete s.catatan; return s; }), answers: {}, marks: {}, startedAt: Date.now(), finishedAt: null, label, info: { lokal: true } };
  await DB.exams.put(exam);
  await openExam(exam.id);
}

// ---------- Mengerjakan ----------
async function openExam(id) {
  const e = await DB.exams.get(id);
  if (!e) return toast("Simulasi tidak ditemukan.", "err");
  const ids = new Set(e.soal.map((s) => s.docId));
  state.examDocs = Object.fromEntries((await DB.all()).filter((d) => ids.has(d.id)).map((d) => [d.id, d]));
  state.exam = e; state.folder = e.kursus; state.view = "exam";
  render();
}
const saveExam = () => DB.exams.put(state.exam);
const examRemaining = (e) => (e.opts.menit ? e.startedAt + e.opts.menit * 60e3 - Date.now() : null);
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function stopExamTimer() { clearInterval(state.examTimer); state.examTimer = null; }
function startExamTimer() {
  stopExamTimer();
  const e = state.exam;
  if (!e.opts.menit || e.finishedAt) return;
  const tick = () => {
    const left = examRemaining(e);
    const el = document.getElementById("exTime");
    if (el) { el.textContent = mmss(left); el.classList.toggle("urgent", left < 5 * 60e3); }
    if (left <= 0) { stopExamTimer(); finishExam(true); }
  };
  tick();
  state.examTimer = setInterval(tick, 1000);
}

function renderExam() {
  const e = state.exam;
  if (e.finishedAt) return renderExamResult();
  if (e.opts.menit && examRemaining(e) <= 0) return finishExam(true);
  const answered = e.soal.filter((_, i) => (e.answers[i] || "").toString().trim()).length;
  app.innerHTML = `<div class="stack">
    <div class="exam-bar">
      <div><b>Simulasi Ujian</b><div class="small">${esc(e.kursus)} · ${answered}/${e.soal.length} dijawab</div></div>
      ${e.opts.menit ? `<div class="exam-time" id="exTime">--:--</div>` : ""}
    </div>
    <p class="small muted">Kunci jawaban & pembahasan baru muncul setelah kamu menekan "Selesai". Jawaban tersimpan otomatis — boleh ditinggal dan dilanjutkan nanti${e.opts.menit ? " (waktu tetap berjalan)" : ""}.</p>
    ${e.soal.map((s, i) => `<article class="card q" id="exq${i}">
      <div class="q-head"><span class="q-num">${i + 1}.</span><span class="pill">${s.jenis === "pilihan_ganda" ? "Pilihan ganda" : "Isian"}</span></div>
      <div class="q-text">${esc(s.pertanyaan)}</div>
      ${s.jenis === "pilihan_ganda"
        ? `<div class="opts">${s.opsi.map((o, k) => { const L = "ABCD"[k]; return `<button class="opt ${e.answers[i] === L ? "chosen" : ""}" data-act="exAns" data-i="${i}" data-l="${L}"><b>${L}.</b><span>${esc(o)}</span></button>`; }).join("")}</div>`
        : `<input type="text" data-exin="${i}" value="${esc(e.answers[i] || "")}" placeholder="Jawabanmu…" aria-label="Jawaban soal ${i + 1}">`}
    </article>`).join("")}
    <button class="btn primary block" data-act="examFinish">Selesai &amp; lihat nilai</button>
    <button class="link small" data-act="examLeave">Tinggalkan dulu (lanjutkan nanti)</button>
  </div>`;
  startExamTimer();
}

async function finishExam(auto) {
  const e = state.exam;
  if (!e || e.finishedAt) return;
  if (!auto) {
    const empty = e.soal.filter((_, i) => !(e.answers[i] || "").toString().trim()).length;
    if (empty && !confirm(`${empty} soal belum dijawab dan akan dihitung salah. Selesaikan sekarang?`)) return;
  }
  // Isian dinilai otomatis (kecocokan kata), bisa dikoreksi manual di halaman hasil
  e.soal.forEach((s, i) => { if (s.jenis !== "pilihan_ganda") e.marks[i] = guessOk(e.answers[i] || "", s.jawaban) ? "ok" : "bad"; });
  e.finishedAt = Date.now();
  stopExamTimer();
  await saveExam();
  render();
  scrollTo(0, 0);
  if (auto) toast("Waktu habis — jawaban dinilai otomatis.");
}

// ---------- Hasil ----------
function examScore(e) {
  const per = {};
  let correct = 0;
  e.soal.forEach((s, i) => {
    const ok = s.jenis === "pilihan_ganda" ? e.answers[i] === s.jawaban : e.marks?.[i] === "ok";
    if (ok) correct++;
    const p = (per[s.docId] ||= { modul: s.modul, n: 0, c: 0 });
    p.n++; if (ok) p.c++;
  });
  return { total: e.soal.length, correct, per };
}

function renderExamResult() {
  const e = state.exam;
  const r = examScore(e);
  const pct = Math.round((r.correct / r.total) * 100);
  const color = pct >= 80 ? "var(--ok)" : pct >= 60 ? "var(--warn)" : "var(--bad)";
  const mods = Object.entries(r.per).sort((a, b) => byName(a[1].modul || "", b[1].modul || ""));
  const wrong = e.soal.filter((s, i) => (s.jenis === "pilihan_ganda" ? e.answers[i] !== s.jawaban : e.marks[i] !== "ok"));
  const dur = Math.round((e.finishedAt - e.startedAt) / 60e3);
  app.innerHTML = `<div class="stack">
    <button class="link small" data-act="folder" data-name="${esc(e.kursus)}">← ${esc(e.kursus)}</button>
    <section class="card">
      <p class="small muted" style="margin:0">Hasil simulasi ujian${e.label ? " · " + esc(e.label) : ""}</p>
      <div class="score" style="margin:8px 0"><div class="score-num" style="color:${color}">${pct}</div>
        <div style="flex:1"><div class="progress"><i style="width:${pct}%;background:${color}"></i></div>
        <p class="small" style="margin:6px 0 0">${r.correct} dari ${r.total} benar${dur ? ` · ${dur} menit` : ""}</p></div></div>
    </section>

    <section class="card">
      <h2>Nilai per modul</h2>
      ${mods.map(([docId, m]) => {
        const p = Math.round((m.c / m.n) * 100);
        const st = p >= 80 ? ["Kuat", "ok-t"] : p >= 60 ? ["Cukup", "warn-t"] : ["Perlu diulang", ""];
        return `<div class="term">
          <div class="spread"><b>${esc(m.modul || "Modul")}</b><span class="small"><span class="${st[1]}" ${!st[1] ? 'style="color:var(--bad)"' : ""}>${st[0]}</span> · ${m.c}/${m.n}</span></div>
          <div class="progress" style="margin:6px 0"><i style="width:${p}%;background:${p >= 80 ? "var(--ok)" : p >= 60 ? "var(--warn)" : "var(--bad)"}"></i></div>
          ${p < 80 && state.examDocs[docId] ? `<button class="btn sm" data-act="open" data-id="${docId}">Pelajari ${esc(m.modul || "modul")}</button>` : ""}
        </div>`;
      }).join("")}
    </section>

    <section class="card">
      <h2>Latihan berikutnya</h2>
      <div class="stack-sm">
        <button class="btn primary block" data-act="examNew">Simulasi baru (soal baru dengan AI)</button>
        ${wrong.length ? `<button class="btn block" data-act="examWrong">Latih ulang ${wrong.length} soal yang salah (tanpa AI)</button>` : ""}
        <button class="btn block" data-act="examRetry">Acak &amp; ulangi simulasi ini (tanpa AI)</button>
      </div>
    </section>

    <h2>Pembahasan</h2>
    ${e.soal.map((s, i) => {
      const a = e.answers[i] || "";
      const ok = s.jenis === "pilihan_ganda" ? a === s.jawaban : e.marks[i] === "ok";
      return `<article class="card q">
        <div class="q-head"><span class="q-num">${i + 1}.</span><span class="pill">${esc(s.modul || "")}</span>
          <span class="verdict ${ok ? "ok" : "bad"}" style="margin:0 0 0 auto">${ok ? "Benar" : a ? "Salah" : "Tidak dijawab"}</span></div>
        <div class="q-text">${esc(s.pertanyaan)}</div>
        ${s.jenis === "pilihan_ganda"
          ? `<div class="opts">${s.opsi.map((o, k) => { const L = "ABCD"[k]; return `<div class="opt ${L === s.jawaban ? "correct" : a === L ? "wrong" : ""}"><b>${L}.</b><span>${esc(o)}</span></div>`; }).join("")}</div>`
          : `<p class="small">Jawabanmu: <b>${esc(a || "—")}</b></p>`}
        <div class="answer">
          ${s.jenis !== "pilihan_ganda" ? `<div class="k">Kunci: ${esc(s.jawaban)}</div>
            <div class="row" style="margin:6px 0"><span class="small muted">Penilaian otomatis bisa keliru —</span>
            <button class="btn sm ${e.marks[i] === "ok" ? "g4" : ""}" data-act="exMark" data-i="${i}" data-v="ok">Benar</button>
            <button class="btn sm ${e.marks[i] === "bad" ? "g0" : ""}" data-act="exMark" data-i="${i}" data-v="bad">Salah</button></div>` : ""}
          <div class="prose small">${md(s.pembahasan)}</div>${cite(s.cek, s.kutipan, s.docId)}
        </div>
      </article>`;
    }).join("")}
  </div>`;
}

// ---------- Aksi ----------
Object.assign(actions, {
  examSetup: () => openExamSetup(),
  exAll: (el) => { document.querySelectorAll("input[name=exMod]").forEach((c) => (c.checked = el.dataset.v === "1")); updateExamCalls(); },
  examCreate: () => createExam(readExamSetup()),
  examOpen: (el) => openExam(el.dataset.id),
  exAns: async (el) => {
    state.exam.answers[el.dataset.i] = el.dataset.l;
    el.closest(".opts").querySelectorAll(".opt").forEach((b) => b.classList.toggle("chosen", b === el));
    const bar = document.querySelector(".exam-bar .small");
    if (bar) bar.textContent = `${state.exam.kursus} · ${state.exam.soal.filter((_, i) => (state.exam.answers[i] || "").toString().trim()).length}/${state.exam.soal.length} dijawab`;
    await saveExam();
  },
  examFinish: () => finishExam(false),
  examLeave: () => { state.view = "folder"; state.folder = state.exam.kursus; render(); },
  exMark: async (el) => { state.exam.marks[el.dataset.i] = el.dataset.v; await saveExam(); keepScroll(renderExamResult); },
  examNew: () => { state.view = "folder"; state.folder = state.exam.kursus; render().then(() => openExamSetup(state.exam.opts)); },
  examWrong: () => {
    const e = state.exam;
    const wrong = e.soal.filter((s, i) => (s.jenis === "pilihan_ganda" ? e.answers[i] !== s.jawaban : e.marks[i] !== "ok"));
    createLocalExam(e, wrong, "Soal yang salah", 0);
  },
  examRetry: () => createLocalExam(state.exam, state.exam.soal, "Ulangan (diacak)", state.exam.opts.menit),
});

// Simpan jawaban isian saat diketik
document.addEventListener("input", (ev) => {
  const i = ev.target.dataset?.exin;
  if (i == null || !state.exam) return;
  state.exam.answers[i] = ev.target.value;
  clearTimeout(state.exSaveT);
  state.exSaveT = setTimeout(saveExam, 400);
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "exTimer") document.getElementById("exMenitWrap").hidden = !ev.target.checked;
  if (["exMod", "exJenis"].includes(ev.target.name) || ["exJumlah", "exPeriksa"].includes(ev.target.id)) updateExamCalls();
});
