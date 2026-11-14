#!/usr/bin/env node
/**
 * Potong — YouTube clipper.
 * Server tanpa dependensi npm: hanya butuh Node 18+, yt-dlp, dan ffmpeg.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const CLIPS_DIR = path.resolve(process.env.CLIPS_DIR || path.join(__dirname, 'clips'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS) || 30 * 60;
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL) || 2;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// Origins (comma separated, or *) of pages hosted elsewhere that may call this API.
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

fs.mkdirSync(CLIPS_DIR, { recursive: true });

/* ---------- yt-dlp discovery ---------- */

function findYtDlp() {
  const candidates = [];
  if (process.env.YTDLP_PATH) candidates.push([process.env.YTDLP_PATH, []]);
  candidates.push(['yt-dlp', []], ['python3', ['-m', 'yt_dlp']], ['python', ['-m', 'yt_dlp']]);
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}
const YTDLP = findYtDlp();
const HAS_FFMPEG = spawnSync(FFMPEG, ['-version']).status === 0;

function ytdlp(args) {
  return spawn(YTDLP.cmd, [...YTDLP.pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/* ---------- validation ---------- */

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
]);

/** Returns the 11-char video id, or null when the URL is not a YouTube video. */
function videoIdFrom(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !YT_HOSTS.has(u.hostname)) return null;
  let id = null;
  if (u.hostname === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else {
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
    if (m) id = m[2];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

const QUALITIES = { '1080': 1080, '720': 720, '480': 480, '360': 360, audio: 0 };
const ASPECTS = {
  original: null,
  '9:16': 'crop=trunc(ih*9/16/2)*2:ih',
  '1:1': 'crop=ih:ih',
  '4:5': 'crop=trunc(ih*4/5/2)*2:ih',
};

function safeName(s) {
  return String(s || 'klip')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'klip';
}

function stamp(sec) {
  const s = Math.floor(sec);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}${p(Math.floor((s % 3600) / 60))}${p(s % 60)}`;
}

/* ---------- jobs ---------- */

const jobs = new Map();
const queue = [];
let running = 0;

function publicJob(j) {
  return {
    id: j.id, videoId: j.videoId, title: j.title, start: j.start, end: j.end,
    quality: j.quality, aspect: j.aspect, status: j.status, stage: j.stage,
    progress: j.progress, error: j.error, filename: j.filename, size: j.size,
    createdAt: j.createdAt,
  };
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running++;
    runJob(job)
      .catch((err) => {
        if (job.status !== 'canceled') {
          job.status = 'error';
          job.error = friendlyError(err.message);
        }
      })
      .finally(() => { job.proc = null; running--; pump(); });
  }
}

function friendlyError(msg) {
  const m = String(msg || '');
  if (/Sign in to confirm|not a bot/i.test(m)) return 'YouTube meminta verifikasi (anti-bot). Coba lagi nanti atau jalankan dari jaringan lain.';
  if (/Private video|members-only|This video is private/i.test(m)) return 'Video privat atau khusus member — tidak bisa diakses.';
  if (/Video unavailable|removed|not available/i.test(m)) return 'Video tidak tersedia.';
  if (/age/i.test(m) && /confirm|restricted/i.test(m)) return 'Video dibatasi usia — butuh login.';
  if (/Unable to connect|timed out|getaddrinfo|Network/i.test(m)) return 'Tidak bisa terhubung ke YouTube. Periksa koneksi internet.';
  const line = m.split('\n').filter((l) => /ERROR/.test(l)).pop() || m.split('\n').filter(Boolean).pop() || 'Gagal memproses klip.';
  return line.replace(/^ERROR:\s*/, '').slice(0, 300);
}

/** Runs a process, feeding ffmpeg-style `time=` progress to onTime. */
function run(job, proc, onTime) {
  job.proc = proc;
  return new Promise((resolve, reject) => {
    let tail = '';
    const onData = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      const all = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      if (all.length && onTime) {
        const m = all[all.length - 1];
        onTime(+m[1] * 3600 + +m[2] * 60 + +m[3]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (job.status === 'canceled') return reject(new Error('canceled'));
      code === 0 ? resolve() : reject(new Error(tail));
    });
  });
}

async function runJob(job) {
  const dur = job.end - job.start;
  const audio = job.quality === 'audio';
  const crop = audio ? null : ASPECTS[job.aspect];
  const ext = audio ? 'mp3' : 'mp4';
  const finalPath = path.join(CLIPS_DIR, `${job.id}.${ext}`);
  const rawBase = path.join(CLIPS_DIR, `${job.id}.raw`);
  const rawPath = `${rawBase}.${ext}`;
  const share = crop ? 0.7 : 1; // portion of the bar given to the download pass

  job.status = 'running';
  job.stage = 'Mengunduh potongan';

  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--force-overwrites',
    '--download-sections', `*${job.start.toFixed(3)}-${job.end.toFixed(3)}`,
    '--force-keyframes-at-cuts',
    '-o', `${rawBase}.%(ext)s`,
  ];
  if (audio) {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '2');
  } else {
    const h = QUALITIES[job.quality];
    args.push(
      '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
      '-S', 'vcodec:h264,res,acodec:m4a',
      '--merge-output-format', 'mp4',
    );
  }
  args.push('--', `https://www.youtube.com/watch?v=${job.videoId}`);

  try {
    await run(job, ytdlp(args), (t) => {
      job.progress = Math.max(job.progress, Math.min(0.99, t / dur) * share);
    });
    if (!fs.existsSync(rawPath)) throw new Error('ERROR: yt-dlp selesai tanpa menghasilkan berkas.');

    if (crop) {
      job.stage = `Memotong rasio ${job.aspect}`;
      const ff = spawn(FFMPEG, [
        '-y', '-hide_banner', '-i', rawPath, '-vf', crop,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy', '-movflags', '+faststart', finalPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      await run(job, ff, (t) => {
        job.progress = Math.max(job.progress, share + Math.min(0.99, t / dur) * (1 - share));
      });
    } else {
      fs.renameSync(rawPath, finalPath);
    }

    job.file = finalPath;
    job.size = fs.statSync(finalPath).size;
    job.filename = `${safeName(job.title)}_${stamp(job.start)}-${stamp(job.end)}${crop ? '_' + job.aspect.replace(':', 'x') : ''}.${ext}`;
    job.progress = 1;
    job.stage = 'Selesai';
    job.status = 'done';
  } finally {
    // Remove leftovers (raw pass, .part files) but never the finished clip.
    for (const f of fs.readdirSync(CLIPS_DIR)) {
      if (f.startsWith(`${job.id}.`) && path.join(CLIPS_DIR, f) !== job.file) {
        fs.rmSync(path.join(CLIPS_DIR, f), { force: true });
      }
    }
  }
}

/* ---------- http helpers ---------- */

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Dilarang.' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Tidak ditemukan.' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

function serveClip(req, res, job, inline) {
  const st = fs.statSync(job.file);
  const type = job.file.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
  const head = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${job.filename}"`,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(job.file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  fs.createReadStream(job.file).pipe(res);
}

/* ---------- routes ---------- */

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Metode tidak didukung.' });
    return serveStatic(req, res, p);
  }

  const origin = req.headers.origin;
  if (origin && (ALLOW_ORIGIN.includes('*') || ALLOW_ORIGIN.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/api/health' && req.method === 'GET') {
    return send(res, 200, {
      ytdlp: YTDLP ? YTDLP.version : null, ffmpeg: HAS_FFMPEG, maxClipSeconds: MAX_CLIP_SECONDS,
    });
  }

  if (p === '/api/info' && req.method === 'GET') {
    const id = videoIdFrom(url.searchParams.get('url'));
    if (!id) return send(res, 400, { error: 'Itu bukan tautan video YouTube yang valid.' });
    if (!YTDLP) return send(res, 503, { error: 'yt-dlp belum terpasang di server.' });
    const proc = ytdlp(['--no-playlist', '--no-warnings', '--skip-download',
      '--print', '%(.{title,duration,uploader,is_live})j', '--', `https://www.youtube.com/watch?v=${id}`]);
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', () => send(res, 500, { error: 'Gagal menjalankan yt-dlp.' }));
    proc.on('close', (code) => {
      if (res.writableEnded) return;
      if (code !== 0) return send(res, 502, { error: friendlyError(err) });
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        send(res, 200, { id, title: j.title, duration: j.duration, uploader: j.uploader, isLive: !!j.is_live });
      } catch { send(res, 502, { error: 'Jawaban yt-dlp tidak terbaca.' }); }
    });
    return;
  }

  if (p === '/api/clips' && req.method === 'GET') {
    return send(res, 200, { clips: [...jobs.values()].map(publicJob).reverse() });
  }

  if (p === '/api/clips' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: 'Permintaan tidak valid.' }); }
    const videoId = videoIdFrom(body.url);
    const start = Number(body.start);
    const end = Number(body.end);
    const quality = String(body.quality || '720');
    const aspect = String(body.aspect || 'original');
    if (!videoId) return send(res, 400, { error: 'Itu bukan tautan video YouTube yang valid.' });
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return send(res, 400, { error: 'Waktu mulai/selesai tidak valid.' });
    if (end - start < 0.5) return send(res, 400, { error: 'Klip minimal 0,5 detik.' });
    if (end - start > MAX_CLIP_SECONDS) return send(res, 400, { error: `Klip maksimal ${Math.round(MAX_CLIP_SECONDS / 60)} menit.` });
    if (!(quality in QUALITIES)) return send(res, 400, { error: 'Kualitas tidak dikenal.' });
    if (!(aspect in ASPECTS)) return send(res, 400, { error: 'Rasio tidak dikenal.' });
    if (!YTDLP) return send(res, 503, { error: 'yt-dlp belum terpasang. Lihat README.' });
    if (!HAS_FFMPEG) return send(res, 503, { error: 'ffmpeg belum terpasang. Lihat README.' });

    const job = {
      id: crypto.randomBytes(8).toString('hex'), videoId,
      title: String(body.title || videoId).slice(0, 200),
      start, end, quality, aspect: quality === 'audio' ? 'original' : aspect,
      status: 'queued', stage: 'Menunggu antrean', progress: 0, error: null,
      filename: null, size: null, file: null, proc: null, createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return send(res, 201, publicJob(job));
  }

  const m = p.match(/^\/api\/clips\/([a-f0-9]{16})(\/file)?$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'Klip tidak ditemukan.' });
    if (m[2] && req.method === 'GET') {
      if (job.status !== 'done' || !fs.existsSync(job.file)) return send(res, 409, { error: 'Klip belum siap.' });
      return serveClip(req, res, job, url.searchParams.has('inline'));
    }
    if (!m[2] && req.method === 'GET') return send(res, 200, publicJob(job));
    if (!m[2] && req.method === 'DELETE') {
      const wasActive = job.status === 'running' || job.status === 'queued';
      if (wasActive) job.status = 'canceled';
      if (job.proc) job.proc.kill('SIGKILL');
      if (job.file) fs.rmSync(job.file, { force: true });
      jobs.delete(job.id);
      return send(res, 200, { ok: true });
    }
  }

  send(res, 404, { error: 'Tidak ditemukan.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Kesalahan server.' });
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Potong — YouTube clipper\n  → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    console.log(`  yt-dlp : ${YTDLP ? YTDLP.version : 'TIDAK DITEMUKAN (pip install -U yt-dlp)'}`);
    console.log(`  ffmpeg : ${HAS_FFMPEG ? 'ok' : 'TIDAK DITEMUKAN'}`);
    console.log(`  klip   : ${CLIPS_DIR}`);
    console.log(`  origin : ${ALLOW_ORIGIN.length ? ALLOW_ORIGIN.join(', ') : 'hanya halaman ini sendiri'}\n`);
  });
}

module.exports = { videoIdFrom, safeName, server };
