// Membaca isi file: PDF, DOCX, TXT/MD, dan gambar (foto catatan).
// PDF berbasis teks dibaca langsung. PDF hasil scan & gambar dibaca dengan OCR oleh AI.
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const MAX_CHARS = 4000000; // ±1.500 halaman — batas memori browser, bukan batas AI
const SECTION_CHARS = 4000; // DOCX/TXT dipecah per "Bagian"
const OCR_BATCH = 8; // halaman scan per panggilan OCR

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function splitSections(text, prefix) {
  const paras = text.replace(/\r/g, "").split(/\n{2,}|\n(?=\S)/);
  const out = [];
  let cur = "";
  for (const p of paras) {
    if (cur.length + p.length > SECTION_CHARS && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += p + "\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((t, i) => ({ label: `${prefix}Bagian ${i + 1}`, text: t }));
}

async function readPdf(file, prefix, onStatus) {
  const buf = await file.arrayBuffer();
  // isEvalSupported:false menutup celah keamanan font pada pdf.js 3.x
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onStatus(`Membaca halaman ${i}/${pdf.numPages}…`);
    const content = await (await pdf.getPage(i)).getTextContent();
    const text = content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("")
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    pages.push({ label: `${prefix}Halaman ${i}`, text });
  }
  // Halaman yang hampir tanpa teks = hasil scan/gambar → dibaca dengan OCR AI.
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  const scanned = pages.map((p, i) => (p.text.length < 40 ? i : -1)).filter((i) => i >= 0);
  const mostlyScanned = total / pdf.numPages < 80;
  if (!scanned.length || (!mostlyScanned && scanned.length <= pdf.numPages * 0.1)) return { pages, method: "teks" };

  const nCalls = Math.ceil(scanned.length / OCR_BATCH);
  for (let b = 0; b < scanned.length; b += OCR_BATCH) {
    const batch = scanned.slice(b, b + OCR_BATCH);
    const imgs = [];
    for (const i of batch) {
      onStatus(`Menyiapkan halaman scan ${i + 1}…`);
      imgs.push({ mime: "image/jpeg", data: await renderPage(pdf, i + 1) });
    }
    onStatus(`OCR halaman ${batch[0] + 1}–${batch[batch.length - 1] + 1} (${b / OCR_BATCH + 1}/${nCalls} panggilan AI)…`);
    const got = splitOcr(await AI.ocr(imgs, onStatus), "", "Halaman");
    // Penanda OCR bernomor 1..n untuk gambar dalam kelompok ini → petakan ke nomor halaman asli
    got.forEach((g) => {
      const k = parseInt(g.label.replace(/\D+/g, "")) - 1;
      if (batch[k] != null) pages[batch[k]].text = g.text;
    });
  }
  return { pages, method: "ocr" };
}

async function renderPage(pdf, n) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 1600 / Math.max(base.width, base.height)); // ±1600 px sisi terpanjang
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const data = c.toDataURL("image/jpeg", 0.82).split(",")[1];
  c.width = c.height = 0;
  return data;
}

// ---------- Materi panjang: pecah per bagian & ambil halaman relevan ----------
const CHUNK_CHARS = 200000; // ±55 ribu token per panggilan — aman untuk kuota gratis
const CHAT_CHARS = 100000; // chat & Feynman: cukup halaman relevan saja
const docChars = (pages) => pages.reduce((n, p) => n + p.text.length, 0);

function chunkPages(pages, max = CHUNK_CHARS) {
  // Bagi rata: 403rb karakter → 3 bagian @±135rb, bukan 200rb + 200rb + 3rb
  const total = docChars(pages);
  const size = total <= max ? max : Math.ceil(total / Math.ceil(total / max)) + 2000;
  const out = [];
  let cur = [], acc = 0;
  for (const p of pages) {
    if (acc + p.text.length > size && cur.length) { out.push(cur); cur = []; acc = 0; }
    cur.push(p); acc += p.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

const STOP = new Set("yang dan di ke dari untuk dengan adalah ini itu pada dalam apa bagaimana mengapa kenapa jelaskan tidak atau juga akan oleh sebagai karena saya kamu aku bisa ada para serta tersebut dapat lebih secara antara seperti hal agar maka jika the of and to in is are a an what how why".split(" "));

// Pilih halaman paling relevan dengan pertanyaan (pencarian kata kunci sederhana, tanpa AI)
function retrievePages(pages, query, budget) {
  if (docChars(pages) <= budget) return pages;
  const words = [...new Set(norm(query).split(" ").filter((w) => w.length > 2 && !STOP.has(w)))];
  const N = pages.length;
  const df = Object.fromEntries(words.map((w) => [w, pages.filter((p) => pageIndex(p).n.includes(w)).length]));
  const scored = pages.map((p, i) => {
    const n = pageIndex(p).n;
    let s = 0;
    for (const w of words) {
      const c = n.split(w).length - 1;
      if (c) s += (1 + Math.log(c)) * Math.log(1 + N / (df[w] || 1));
    }
    return { i, s };
  }).sort((a, b) => b.s - a.s);
  const pick = new Set();
  let acc = 0;
  for (const { i, s } of scored) {
    if (s <= 0 && pick.size) break;
    // ambil juga halaman sesudahnya, karena penjelasan sering bersambung
    for (const j of [i, i + 1]) {
      if (j >= N || pick.has(j) || acc + pages[j].text.length > budget) continue;
      pick.add(j); acc += pages[j].text.length;
    }
    if (acc >= budget * 0.95) break;
  }
  return [...pick].sort((a, b) => a - b).map((i) => pages[i]);
}

// Pilih halaman untuk membuat soal/kartu dari materi panjang: utamakan yang belum tercakup, lalu tersebar merata
function samplePages(pages, budget, used = new Set()) {
  if (docChars(pages) <= budget) return pages;
  const idx = pages.map((_, i) => i);
  const fresh = idx.filter((i) => !used.has(pages[i].label));
  const old = idx.filter((i) => used.has(pages[i].label));
  const evenly = (list) => {
    const k = Math.max(1, Math.floor(budget / (docChars(pages) / pages.length))); // perkiraan jumlah halaman yang muat
    if (list.length <= k) return list;
    const step = list.length / k;
    return Array.from({ length: k }, (_, j) => list[Math.floor(j * step)]);
  };
  const pick = new Set();
  let acc = 0;
  for (const i of [...evenly(fresh), ...fresh, ...evenly(old)]) {
    if (pick.has(i) || acc + pages[i].text.length > budget) continue;
    pick.add(i); acc += pages[i].text.length;
    if (acc >= budget * 0.95) break;
  }
  return [...pick].sort((a, b) => a - b).map((i) => pages[i]);
}

function splitOcr(text, prefix, word) {
  const parts = text.split(/===\s*HALAMAN\s*(\d+)\s*===/i);
  const pages = [];
  for (let i = 1; i < parts.length; i += 2) {
    const t = parts[i + 1].trim();
    if (t) pages.push({ label: `${prefix}${word} ${parts[i]}`, text: t });
  }
  if (!pages.length && text.trim()) pages.push({ label: `${prefix}${word} 1`, text: text.trim() });
  return pages;
}

// Mengembalikan { pages:[{label,text}], method, truncated }
async function extractFiles(files, onStatus) {
  files = [...files];
  const multi = files.length > 1;
  const images = files.filter((f) => f.type.startsWith("image/"));
  const others = files.filter((f) => !f.type.startsWith("image/"));
  let pages = [];
  const methods = new Set();

  for (const f of others) {
    const ext = f.name.split(".").pop().toLowerCase();
    const prefix = multi ? `${f.name} · ` : "";
    if (ext === "pdf") {
      const r = await readPdf(f, prefix, onStatus);
      pages.push(...r.pages);
      methods.add(r.method);
    } else if (ext === "docx") {
      onStatus(`Membaca ${f.name}…`);
      const { value } = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
      pages.push(...splitSections(value, prefix));
      methods.add("teks");
    } else if (ext === "txt" || ext === "md") {
      pages.push(...splitSections(await f.text(), prefix));
      methods.add("teks");
    } else {
      throw new Error(`Format "${f.name}" belum didukung. Gunakan PDF, DOCX, TXT, MD, atau gambar (JPG/PNG).`);
    }
  }

  if (images.length) {
    const size = images.reduce((n, f) => n + f.size, 0);
    if (size > 18 * 1024 * 1024) throw new Error("Total ukuran gambar terlalu besar (>18 MB). Kirim lebih sedikit foto sekaligus.");
    onStatus(`Membaca ${images.length} gambar dengan OCR AI…`);
    const parts = await Promise.all(images.map(async (f) => ({ mime: f.type, data: await fileToBase64(f) })));
    pages.push(...splitOcr(await AI.ocr(parts), "", "Gambar"));
    methods.add("ocr");
  }

  pages = pages.filter((p) => p.text.trim());
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  if (total < 50) throw new Error("Teks di file tidak terbaca atau terlalu sedikit.");

  // Batas memori browser (sangat besar). Materi panjang diproses per bagian, bukan dipotong.
  let truncated = false, acc = 0;
  const kept = [];
  for (const p of pages) {
    if (acc + p.text.length > MAX_CHARS) { truncated = true; break; }
    kept.push(p);
    acc += p.text.length;
  }
  return { pages: kept, method: methods.has("ocr") ? "ocr" : "teks", truncated, totalPages: pages.length };
}

// ---------- Pengecek kutipan: memastikan kutipan benar-benar ada di file ----------
function norm(s) {
  return (s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function shingles(words, n = 3) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}
// Cache di memori saja (tidak ikut tersimpan ke database)
const _normCache = new WeakMap();
function pageIndex(p) {
  let c = _normCache.get(p);
  if (!c) {
    const n = norm(p.text);
    c = { n, s: shingles(n.split(" ")) };
    _normCache.set(p, c);
  }
  return c;
}
// status: "ok" (persis ada), "mirip" (hampir sama), "tidak" (tidak ditemukan)
function locateQuote(quote, pages) {
  const q = norm(quote);
  if (q.split(" ").length < 3) return { status: "tidak", label: null };
  for (const p of pages) {
    if (pageIndex(p).n.includes(q)) return { status: "ok", label: p.label };
  }
  const qs = shingles(q.split(" "));
  let best = { ratio: 0, label: null };
  for (const p of pages) {
    const ps = pageIndex(p).s;
    let hit = 0;
    for (const s of qs) if (ps.has(s)) hit++;
    const ratio = qs.size ? hit / qs.size : 0;
    if (ratio > best.ratio) best = { ratio, label: p.label };
  }
  return best.ratio >= 0.75 ? { status: "mirip", label: best.label } : { status: "tidak", label: null };
}
