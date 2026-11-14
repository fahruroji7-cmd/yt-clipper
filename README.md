# Potong — YouTube Clipper

Tempel tautan YouTube, tandai bagian yang diinginkan di timeline, unduh hasilnya sebagai MP4 atau MP3.

## Yang dibutuhkan

- Node.js 18+ (tanpa `npm install` — tidak ada dependensi)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): `pip install -U yt-dlp`
- [ffmpeg](https://ffmpeg.org): `sudo apt install ffmpeg` / `brew install ffmpeg` / `winget install ffmpeg`

## Menjalankan

```bash
node server.js
```

Buka http://localhost:5173

## Cara pakai

1. Tempel tautan video (`youtube.com/watch`, `youtu.be`, Shorts, atau Live yang sudah selesai).
2. Geser penanda mulai/selesai, ketik waktunya (`1:30`, `90`, `1m30s`), atau tekan `I` / `O` saat video diputar.
3. Pilih kualitas (1080p/720p/480p/MP3) dan rasio (Asli, 9:16, 1:1, 4:5), lalu **Buat klip**.

Pintasan: `Spasi` putar/jeda, `←` `→` geser 1 detik, `Shift+←/→` geser penanda aktif 0,1 detik,
`Ctrl+scroll` di timeline untuk zoom.

## Dua mode

| Mode | Kapan aktif | Yang bisa dilakukan |
| --- | --- | --- |
| **Tautan** | Halaman dibuka tanpa server (mis. di GitHub Pages) | Tandai potongan, salin tautan klip atau kode sematan. Tidak ada berkas. |
| **Unduh** | Halaman terhubung ke `server.js` | Semua di atas, ditambah unduh MP4/MP3. |

## Online lewat GitHub Pages

1. Di GitHub: **Settings → Pages → Source: GitHub Actions**. Setiap push ke `main` akan memasang isi folder `public/`.
2. Halaman tersedia di `https://NAMA-AKUN.github.io/yt-clipper/` dalam mode Tautan.
3. Untuk mode Unduh dari halaman itu, jalankan server di komputer Anda dengan izin untuk alamat Pages:

   ```bash
   ALLOW_ORIGIN=https://NAMA-AKUN.github.io node server.js
   ```

   Di PowerShell: `$env:ALLOW_ORIGIN="https://NAMA-AKUN.github.io"; node server.js`

4. Di halaman, buka **Server pengunduh** dan isi `http://localhost:5173` (dari komputer yang sama) atau alamat tunnel
   (`cloudflared tunnel --url http://localhost:5173`) agar bisa dipakai dari perangkat lain.

## Server pengunduh di cloud (tanpa komputer sendiri)

Repositori ini berisi `Dockerfile` dan `render.yaml` untuk memasang `server.js` di [Render](https://render.com):

1. Di Render: **New → Blueprint**, pilih repositori ini, lalu **Apply**.
2. Setelah selesai, salin alamat layanannya (`https://….onrender.com`) dan nilai `ACCESS_KEY` dari tab **Environment**.
3. Isi alamat itu di `public/config.js` (`window.POTONG_API`) supaya halaman GitHub Pages langsung tersambung.
4. Di halaman, buka **Server pengunduh**, isi kunci aksesnya sekali; browser akan mengingatnya.

Batasan: paket gratis tertidur setelah 15 menit tanpa pemakaian (permintaan pertama lambat), klip dihapus
otomatis setelah 60 menit, dan YouTube kadang menolak permintaan dari IP pusat data.

## Pengaturan (variabel lingkungan)

| Variabel | Bawaan | Fungsi |
| --- | --- | --- |
| `PORT` | `5173` | Port server |
| `HOST` | `127.0.0.1` | Ganti ke `0.0.0.0` agar bisa diakses dari perangkat lain |
| `CLIPS_DIR` | `./clips` | Folder hasil klip |
| `MAX_CLIP_SECONDS` | `1800` | Durasi klip maksimum |
| `MAX_PARALLEL` | `2` | Jumlah klip yang diproses bersamaan |
| `ALLOW_ORIGIN` | — | Alamat halaman lain yang boleh memakai server ini (pisahkan dengan koma) |
| `ACCESS_KEY` | — | Jika diisi, semua pemakaian wajib menyertakan kunci ini |
| `CLIP_TTL_MINUTES` | `0` | Hapus klip selesai setelah sekian menit (0 = simpan terus) |
| `YTDLP_PATH`, `FFMPEG_PATH` | — | Lokasi biner jika tidak ada di PATH |

## Catatan

- Hanya potongan yang dipilih yang diunduh, bukan seluruh video.
- Jika YouTube tiba-tiba gagal diunduh, perbarui dulu: `pip install -U yt-dlp`.
- Daftar klip disimpan di memori; setelah server dimatikan, berkasnya tetap ada di `clips/`.
- Gunakan untuk video milik sendiri, berlisensi bebas, atau yang sudah Anda dapat izinnya.
