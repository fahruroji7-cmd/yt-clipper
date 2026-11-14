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

## Pengaturan (variabel lingkungan)

| Variabel | Bawaan | Fungsi |
| --- | --- | --- |
| `PORT` | `5173` | Port server |
| `HOST` | `127.0.0.1` | Ganti ke `0.0.0.0` agar bisa diakses dari perangkat lain |
| `CLIPS_DIR` | `./clips` | Folder hasil klip |
| `MAX_CLIP_SECONDS` | `1800` | Durasi klip maksimum |
| `MAX_PARALLEL` | `2` | Jumlah klip yang diproses bersamaan |
| `YTDLP_PATH`, `FFMPEG_PATH` | — | Lokasi biner jika tidak ada di PATH |

## Catatan

- Hanya potongan yang dipilih yang diunduh, bukan seluruh video.
- Jika YouTube tiba-tiba gagal diunduh, perbarui dulu: `pip install -U yt-dlp`.
- Daftar klip disimpan di memori; setelah server dimatikan, berkasnya tetap ada di `clips/`.
- Gunakan untuk video milik sendiri, berlisensi bebas, atau yang sudah Anda dapat izinnya.
