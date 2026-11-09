# Maker Soal

Aplikasi belajar pribadi: unggah materi (PDF, Word, TXT, atau foto catatan), lalu dapatkan:

1. **Belajar bertahap**: materi dipecah menjadi peta topik. Setiap topik punya alur *Pahami → Hafalkan → Uji diri → Jelaskan ulang*, dengan status per topik (belum dipelajari, sedang dipelajari, dikuasai). Supaya tidak ada bagian yang terlewat, tersedia juga:
   - **Latihan topik lemah**: soal khusus dari topik yang skornya di bawah 80 atau kartunya sering lupa.
   - **Cek cakupan**: menunjukkan bagian materi yang belum punya soal atau kartu, lalu bisa membuatkan soal khusus untuk bagian itu.
2. **Ringkasan** + daftar istilah penting
3. **Soal latihan** (pilihan ganda, isian, esai) + kunci jawaban + pembahasan. Bisa dikerjakan langsung atau dicetak.
4. **Flashcard** dengan pengulangan berjarak (kartu sulit muncul lebih sering)
5. **Tanya materi**: chat yang hanya menjawab dari isi file
6. **Uji pemahaman (metode Feynman)**: jelaskan dengan kata-katamu, lalu AI menilai berdasarkan materi
7. **Latihan tanpa kuota**: acak ulang soal lama, cocokkan istilah, dan tebak istilah, tanpa memakai AI sama sekali

## Hemat kuota gratis

- **Model cadangan otomatis.** Setiap model Gemini punya kuota harian sendiri. Jika kuota model utama (Flash) habis, aplikasi otomatis pindah ke model cadangan (Flash-Lite).
- **Tugas ringan memakai model ringan.** Chat dan pembuatan flashcard memakai Flash-Lite. Soal, peta materi, dan penilaian memakai model utama yang lebih teliti.
- **Panggilan digabung.** Saat unggah, ringkasan dan peta materi dibuat dalam 1 panggilan. Setiap topik (penjelasan, kartu, dan soal) juga dibuat dalam 1 panggilan, dan baru dibuat saat topik itu dibuka.
- **Penghitung pemakaian.** Jumlah permintaan per model hari ini terlihat di halaman utama dan Pengaturan. Kuota direset sekitar pukul 14.00–15.00 WIB.
- **Mode hemat.** Pemeriksaan ulang soal bisa dimatikan di Pengaturan, menghemat 1 panggilan per set soal (ketelitian sedikit turun).
- Review flashcard, mengerjakan ulang soal, dan latihan tanpa kuota **tidak memakai AI**.

## Bagaimana aplikasi menjaga hasil tetap benar

- AI diperintahkan **hanya memakai isi file**, tanpa pengetahuan luar.
- Setiap soal, kartu, dan istilah wajib menyertakan **kutipan persis** dari file. Aplikasi lalu **mengecek sendiri** apakah kutipan itu benar-benar ada:
  - hijau = terverifikasi (klik untuk melihat teks aslinya dengan sorotan)
  - kuning = hampir sama
  - merah = tidak ditemukan, cek manual
- Soal melewati **pemeriksaan ulang** oleh AI kedua. Soal yang ambigu atau memakai info luar dibuang, dan kunci yang salah diperbaiki.
- Flashcard yang sumbernya tidak ditemukan di file langsung dibuang.
- Menu "Teks hasil baca file" menampilkan persis teks yang dibaca AI, untuk memeriksa hasil OCR.

AI tetap bisa keliru, jadi tetap pakai nalar saat belajar. Label sumber memudahkan pengecekan.

---

## 1. Ambil API key Gemini (gratis, sekali saja)

1. Buka https://aistudio.google.com/apikey dan masuk dengan akun Google.
2. Klik **Create API key**, lalu salin key-nya.
3. Di aplikasi, klik ikon roda gigi, tempel key-nya, lalu klik **Cek & simpan**.

Kuota gratis Gemini (model Flash) cukup untuk pemakaian pribadi sehari-hari. Kalau muncul pesan "kuota habis", tunggu sebentar atau coba besok.
**Privasi:** pada kuota gratis, Google dapat memakai data yang dikirim untuk meningkatkan layanannya. Jangan unggah dokumen rahasia.

## 2. Online gratis permanen dengan GitHub Pages (bisa dibuka dari HP di mana saja)

1. Buat akun di https://github.com (gratis).
2. Klik **New repository**, beri nama `maker-soal`, pilih **Public**, lalu klik **Create repository**.
3. Klik **uploading an existing file**, seret **semua isi folder ini** (`index.html`, `style.css`, `sw.js`, `manifest.webmanifest`, `icon.svg`, folder `js` dan `vendor`), lalu klik **Commit changes**.
4. Buka **Settings → Pages**. Di "Branch" pilih `main` dan folder `/ (root)`, lalu klik **Save**.
5. Tunggu 1–2 menit. Aplikasi bisa dibuka di `https://NAMA-AKUN-KAMU.github.io/maker-soal/`.

Di HP, buka alamat itu di Chrome, lalu pilih menu **⋮ → Tambahkan ke layar utama** supaya tampil seperti aplikasi biasa.

> Kode aplikasi bersifat publik, tetapi **API key dan materimu tidak ikut tersimpan di GitHub**. Keduanya hanya ada di browser perangkatmu.

## 3. Menjalankan di komputer sendiri (opsional)

Buka terminal di folder ini, lalu jalankan:

```bash
python -m http.server 8080
```

Buka http://localhost:8080 di browser.

## Catatan penting soal data

- Materi, soal, dan kemajuan flashcard tersimpan **di browser masing-masing perangkat**. Data di laptop dan HP terpisah.
- Pakai **Ekspor data** secara berkala sebagai cadangan, dan **Impor data** untuk memindahkan data ke perangkat lain.
- Menghapus data/riwayat browser akan menghapus data aplikasi, jadi ekspor dulu.

## Batasan

- Paling optimal untuk file hingga sekitar 300.000 karakter (kira-kira 100–150 halaman). File yang lebih panjang otomatis dipotong, dengan pemberitahuan.
- PDF hasil scan dan foto dibaca dengan OCR AI, maksimal 18 MB per unggahan.
- Butuh internet saat membuat ringkasan, soal, kartu, dan chat. Review flashcard dan membaca hasil yang sudah tersimpan tetap bisa saat sinyal lemah.
