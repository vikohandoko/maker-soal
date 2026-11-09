// Membaca isi file: PDF, DOCX, TXT/MD, dan gambar (foto catatan).
// PDF berbasis teks dibaca langsung. PDF hasil scan & gambar dibaca dengan OCR oleh AI.
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const MAX_CHARS = 300000; // batas aman untuk kuota gratis
const SECTION_CHARS = 4000; // DOCX/TXT dipecah per "Bagian"

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
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  if (total / pdf.numPages >= 80) return { pages, method: "teks" };
  // Teksnya hampir kosong → PDF hasil scan, pakai OCR
  if (file.size > 18 * 1024 * 1024) throw new Error("PDF hasil scan ini terlalu besar (>18 MB) untuk dibaca OCR. Pecah menjadi beberapa file.");
  onStatus("PDF hasil scan terdeteksi — membaca dengan OCR AI…");
  const text = await AI.ocr([{ mime: "application/pdf", data: await fileToBase64(file) }]);
  return { pages: splitOcr(text, prefix, "Halaman"), method: "ocr" };
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

  // Potong jika terlalu panjang (diberi tanda jelas di aplikasi)
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
