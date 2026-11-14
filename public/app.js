(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MIN_LEN = 0.5;

  const S = {
    url: '', videoId: null, title: '', dur: 0,
    in: 0, out: 0,
    view: { a: 0, b: 0 },      // visible window of the timeline, seconds
    active: 'in',              // which grip keyboard nudges move
    previewing: false,
    player: null, playerReady: false, apiLoading: false,
    clips: new Map(), pollTimer: null, server: false,
  };

  /* ---------- helpers ---------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function parseId(raw) {
    let u;
    try { u = new URL(raw.trim()); } catch { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else { const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/); if (m) id = m[2]; }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  function fmt(t, tenths = true) {
    t = Math.max(0, t);
    if (tenths) t = Math.round(t * 10) / 10; else t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
    const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** Accepts 90, 1:30, 1:02:03.5, 1m30s, 1h2m. Returns seconds or NaN. */
  function parseTime(str) {
    str = String(str).trim().toLowerCase().replace(',', '.');
    if (!str) return NaN;
    if (/[hms]/.test(str)) {
      const m = str.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/);
      if (!m || !m[0]) return NaN;
      return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    }
    const parts = str.split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  function fmtSize(b) {
    return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  }

  function say(el, text, ok = false) {
    el.textContent = text || '';
    el.hidden = !text;
    el.classList.toggle('ok', ok);
  }

  /* Address of the download server. Empty = same origin as this page. */
  const store = {
    get() { try { return localStorage.getItem('potong.api') || ''; } catch { return ''; } },
    set(v) { try { v ? localStorage.setItem('potong.api', v) : localStorage.removeItem('potong.api'); } catch { /* private mode */ } },
  };
  const cleanBase = (v) => String(v || '').trim().replace(/\/+$/, '');
  let API = cleanBase(new URLSearchParams(location.search).get('api') || store.get());

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Gagal (${res.status})`);
    return data;
  }

  /* ---------- selection + timeline ---------- */

  function setRange(a, b, keep) {
    const dur = S.dur || Math.max(b, a + MIN_LEN);
    if (keep === 'in') { a = clamp(a, 0, dur - MIN_LEN); b = Math.max(b, a + MIN_LEN); }
    else if (keep === 'out') { b = clamp(b, MIN_LEN, dur); a = Math.min(a, b - MIN_LEN); }
    S.in = clamp(a, 0, dur - MIN_LEN);
    S.out = clamp(b, S.in + MIN_LEN, dur);
    render();
  }

  function setIn(t) {
    const len = S.out - S.in;
    if (t > S.out - MIN_LEN) setRange(t, Math.min(S.dur, t + len), 'in');
    else setRange(t, S.out, 'in');
    S.active = 'in';
  }
  function setOut(t) {
    const len = S.out - S.in;
    if (t < S.in + MIN_LEN) setRange(Math.max(0, t - len), t, 'out');
    else setRange(S.in, t, 'out');
    S.active = 'out';
  }

  function setView(a, b) {
    const minSpan = Math.min(S.dur, 5);
    let span = clamp(b - a, minSpan, S.dur);
    a = clamp(a, 0, S.dur - span);
    S.view = { a, b: a + span };
    drawRuler();
    render();
  }

  function zoom(factor) {
    const mid = (S.in + S.out) / 2;
    const span = (S.view.b - S.view.a) * factor;
    setView(mid - span / 2, mid + span / 2);
  }

  const pct = (t) => ((t - S.view.a) / (S.view.b - S.view.a)) * 100;

  function drawRuler() {
    const ruler = $('ruler');
    ruler.textContent = '';
    const span = S.view.b - S.view.a;
    if (!(span > 0)) return;
    const target = span / Math.max(3, Math.floor(ruler.clientWidth / 90));
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    const step = steps.find((s) => s >= target) || 14400;
    for (let t = Math.ceil(S.view.a / step) * step; t < S.view.b; t += step) {
      const el = document.createElement('span');
      el.style.left = `${pct(t)}%`;
      el.textContent = step < 1 ? fmt(t) : fmt(t, false);
      ruler.appendChild(el);
    }
  }

  function render() {
    if (!S.dur) return;
    $('sel').style.left = `${pct(S.in)}%`;
    $('sel').style.width = `${pct(S.out) - pct(S.in)}%`;
    $('gripIn').style.left = `${pct(S.in)}%`;
    $('gripOut').style.left = `${pct(S.out)}%`;
    $('gripIn').classList.toggle('active', S.active === 'in');
    $('gripOut').classList.toggle('active', S.active === 'out');
    if (document.activeElement !== $('inT')) { $('inT').value = fmt(S.in); $('inT').classList.remove('bad'); }
    if (document.activeElement !== $('outT')) { $('outT').value = fmt(S.out); $('outT').classList.remove('bad'); }
    $('len').textContent = fmt(S.out - S.in);
    $('total').textContent = ` / ${fmt(S.dur, false)}`;
  }

  function timeAt(clientX) {
    const r = $('lane').getBoundingClientRect();
    const f = clamp((clientX - r.left) / r.width, 0, 1);
    return S.view.a + f * (S.view.b - S.view.a);
  }

  function bindGrip(el, which) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      S.active = which;
      stopPreview();
      const move = (ev) => {
        const t = timeAt(ev.clientX);
        if (which === 'in') setRange(Math.min(t, S.out - MIN_LEN), S.out, 'in');
        else setRange(S.in, Math.max(t, S.in + MIN_LEN), 'out');
        seek(which === 'in' ? S.in : S.out);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      render();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopPropagation();
      S.active = which;
      nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 1));
    });
  }

  function nudge(d) {
    if (S.active === 'in') { setRange(Math.min(S.in + d, S.out - MIN_LEN), S.out, 'in'); seek(S.in); }
    else { setRange(S.in, Math.max(S.out + d, S.in + MIN_LEN), 'out'); seek(S.out); }
  }

  /* ---------- player ---------- */

  function loadApi() {
    if (window.YT && window.YT.Player) return createPlayer();
    if (S.apiLoading) return;
    S.apiLoading = true;
    window.onYouTubeIframeAPIReady = createPlayer;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }

  function createPlayer() {
    if (S.player) return;
    S.player = new YT.Player('player', {
      videoId: S.videoId,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => { S.playerReady = true; adoptPlayerMeta(); },
        onStateChange: (e) => {
          adoptPlayerMeta();
          const playing = e.data === YT.PlayerState.PLAYING;
          $('playIcon').setAttribute('d', playing ? 'M7 5h4v14H7zM14 5h4v14h-4z' : 'M7 4.5v15l13-7.5z');
          if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) S.previewing = false;
        },
      },
    });
  }

  function adoptPlayerMeta() {
    if (!S.playerReady) return;
    const d = S.player.getDuration();
    if (d > 0 && Math.abs(d - S.dur) > 0.5) setDuration(d);
    const data = S.player.getVideoData && S.player.getVideoData();
    if (data && data.title && !S.title) { S.title = data.title; $('title').textContent = data.title; }
  }

  function setDuration(d) {
    const first = !S.dur;
    S.dur = d;
    if (first) { S.in = 0; S.out = Math.min(30, d); S.view = { a: 0, b: d }; }
    else { S.out = Math.min(S.out, d); S.in = Math.min(S.in, S.out - MIN_LEN); S.view = { a: 0, b: d }; }
    drawRuler();
    render();
  }

  const now = () => (S.playerReady && S.player.getCurrentTime ? S.player.getCurrentTime() : 0);
  function seek(t) { if (S.playerReady) S.player.seekTo(t, true); }
  function isPlaying() { return S.playerReady && S.player.getPlayerState() === YT.PlayerState.PLAYING; }
  function togglePlay() { if (!S.playerReady) return; isPlaying() ? S.player.pauseVideo() : S.player.playVideo(); }
  function stopPreview() { S.previewing = false; }
  function preview() {
    if (!S.playerReady) return;
    seek(S.in);
    S.player.playVideo();
    S.previewing = true;
  }

  setInterval(() => {
    if (!S.dur) return;
    const t = now();
    $('now').textContent = fmt(t);
    const x = pct(t);
    $('head').style.left = `${x}%`;
    $('head').style.visibility = x < 0 || x > 100 ? 'hidden' : 'visible';
    if (S.previewing && t >= S.out) {
      if ($('loop').checked) seek(S.in);
      else { S.player.pauseVideo(); seek(S.out); }
    }
  }, 80);

  /* ---------- loading a video ---------- */

  async function loadVideo(raw) {
    const id = parseId(raw);
    if (!id) return say($('urlMsg'), 'Itu bukan tautan video YouTube. Contoh: https://www.youtube.com/watch?v=… atau https://youtu.be/…');
    say($('urlMsg'), '');
    say($('cutMsg'), '');
    Object.assign(S, { url: raw.trim(), videoId: id, title: '', dur: 0, previewing: false });
    $('title').textContent = 'Memuat…';
    $('uploader').textContent = '';
    $('empty').hidden = true;
    $('desk').hidden = false;

    if (S.player && S.playerReady) S.player.cueVideoById(id);
    else loadApi();

    await booted;
    if (!S.server || S.videoId !== id) return;
    try {
      const info = await api(`/api/info?url=${encodeURIComponent(S.url)}`);
      if (S.videoId !== id) return;
      S.title = info.title || S.title;
      $('title').textContent = S.title || id;
      $('uploader').textContent = info.uploader || '';
      if (info.isLive) say($('urlMsg'), 'Ini siaran langsung — klip hanya bisa dibuat setelah siaran selesai.');
      if (info.duration > 0 && !S.dur) setDuration(info.duration);
    } catch (err) {
      if (S.videoId !== id) return;
      if (!S.title) $('title').textContent = 'Video YouTube';
      say($('urlMsg'), `Info video tidak terbaca: ${err.message}`);
    }
  }

  /* ---------- clips ---------- */

  async function createClip() {
    if (!S.videoId || !S.dur) return say($('cutMsg'), 'Durasi video belum diketahui. Tunggu video termuat dulu.');
    const quality = document.querySelector('input[name=q]:checked').value;
    const aspect = document.querySelector('input[name=a]:checked').value;
    const btn = $('cutBtn');
    btn.disabled = true;
    try {
      const job = await api('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: S.url, title: S.title || S.videoId,
          start: Math.round(S.in * 10) / 10, end: Math.round(S.out * 10) / 10, quality, aspect,
        }),
      });
      S.clips.set(job.id, job);
      renderClips();
      poll();
      say($('cutMsg'), 'Klip masuk antrean — lihat di bawah.', true);
      setTimeout(() => say($('cutMsg'), ''), 4000);
    } catch (err) {
      say($('cutMsg'), err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function clipNode(job) {
    const li = document.createElement('li');
    li.id = `clip-${job.id}`;
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('off'));
    img.src = `https://i.ytimg.com/vi/${job.videoId}/mqdefault.jpg`;
    const body = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = job.title;
    const spec = document.createElement('div'); spec.className = 'spec';
    const state = document.createElement('div'); state.className = 'state';
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.appendChild(document.createElement('i'));
    body.append(h3, spec, state, bar);
    const acts = document.createElement('div'); acts.className = 'acts';
    li.append(img, body, acts);
    return li;
  }

  function renderClips() {
    const list = $('clips');
    const jobs = [...S.clips.values()].sort((a, b) => b.createdAt - a.createdAt);
    $('shelf').hidden = !jobs.length;
    $('count').textContent = jobs.length ? `(${jobs.length})` : '';
    for (const el of [...list.children]) if (!S.clips.has(el.id.slice(5))) el.remove();

    jobs.forEach((job, i) => {
      let li = $(`clip-${job.id}`);
      if (!li) li = clipNode(job);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
      if (li.dataset.sig === `${job.status}|${job.stage}|${job.progress}`) return;
      li.dataset.sig = `${job.status}|${job.stage}|${job.progress}`;
      li.className = `clip ${job.status}`;

      const spec = li.querySelector('.spec');
      spec.textContent = '';
      const range = document.createElement('em');
      range.textContent = `${fmt(job.start)} → ${fmt(job.end)}`;
      const bits = [fmt(job.end - job.start), job.quality === 'audio' ? 'MP3' : `${job.quality}p`];
      if (job.aspect !== 'original') bits.push(job.aspect);
      if (job.size) bits.push(fmtSize(job.size));
      spec.append(range, ...bits.map((b) => Object.assign(document.createElement('span'), { textContent: b })));

      const active = job.status === 'queued' || job.status === 'running';
      const state = li.querySelector('.state');
      const bar = li.querySelector('.bar');
      state.hidden = job.status === 'done';
      bar.hidden = !active;
      if (job.status === 'error') state.textContent = job.error || 'Gagal.';
      else if (active) state.textContent = job.progress > 0 ? `${job.stage} · ${Math.round(job.progress * 100)}%` : `${job.stage}…`;
      bar.classList.toggle('wait', active && !(job.progress > 0));
      bar.firstChild.style.width = `${Math.round(job.progress * 100)}%`;

      const acts = li.querySelector('.acts');
      acts.textContent = '';
      if (job.status === 'done') {
        const open = Object.assign(document.createElement('a'), { textContent: 'Buka', href: `${API}/api/clips/${job.id}/file?inline`, target: '_blank', rel: 'noopener' });
        const dl = Object.assign(document.createElement('a'), { textContent: 'Unduh', href: `${API}/api/clips/${job.id}/file`, className: 'dl' });
        dl.setAttribute('download', job.filename || '');
        acts.append(open, dl);
      }
      const rm = Object.assign(document.createElement('button'), { type: 'button', textContent: active ? 'Batal' : 'Hapus' });
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        try { await api(`/api/clips/${job.id}`, { method: 'DELETE' }); } catch { /* already gone */ }
        S.clips.delete(job.id);
        renderClips();
      });
      acts.append(rm);
    });
  }

  function poll() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(async () => {
      const active = [...S.clips.values()].filter((j) => j.status === 'queued' || j.status === 'running');
      if (!active.length) { clearInterval(S.pollTimer); S.pollTimer = null; return; }
      await Promise.all(active.map(async (j) => {
        try {
          const fresh = await api(`/api/clips/${j.id}`);
          if (S.clips.has(j.id)) S.clips.set(j.id, fresh);
        } catch (err) {
          if (S.clips.has(j.id)) S.clips.set(j.id, { ...j, status: 'error', error: err.message });
        }
      }));
      renderClips();
    }, 900);
  }

  /* ---------- wiring ---------- */

  $('urlForm').addEventListener('submit', (e) => { e.preventDefault(); loadVideo($('url').value); });
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { $('url').value = text.trim(); loadVideo(text); }
    } catch {
      $('url').focus();
      say($('urlMsg'), 'Browser tidak mengizinkan akses papan klip — tempel manual dengan Ctrl+V.');
    }
  });
  $('url').addEventListener('paste', () => setTimeout(() => { if (parseId($('url').value)) loadVideo($('url').value); }, 0));

  bindGrip($('gripIn'), 'in');
  bindGrip($('gripOut'), 'out');
  $('track').addEventListener('pointerdown', (e) => { if (S.dur) { stopPreview(); seek(timeAt(e.clientX)); } });
  $('track').addEventListener('wheel', (e) => {
    if (!S.dur || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const t = timeAt(e.clientX), f = e.deltaY > 0 ? 1.25 : 0.8;
    setView(t - (t - S.view.a) * f, t + (S.view.b - t) * f);
  }, { passive: false });

  $('playBtn').addEventListener('click', togglePlay);
  $('previewBtn').addEventListener('click', preview);
  $('setIn').addEventListener('click', () => setIn(now()));
  $('setOut').addEventListener('click', () => setOut(now()));
  $('zoomIn').addEventListener('click', () => zoom(0.5));
  $('zoomOut').addEventListener('click', () => zoom(2));
  $('zoomFit').addEventListener('click', () => setView(0, S.dur));
  $('zoomSel').addEventListener('click', () => {
    const pad = Math.max(2, (S.out - S.in) * 0.25);
    setView(S.in - pad, S.out + pad);
  });
  $('cutBtn').addEventListener('click', createClip);

  for (const [id, which] of [['inT', 'in'], ['outT', 'out']]) {
    const el = $(id);
    const commit = () => {
      const t = parseTime(el.value);
      if (!Number.isFinite(t) || t > S.dur + 0.05) { el.classList.add('bad'); return false; }
      el.classList.remove('bad');
      which === 'in' ? setIn(t) : setOut(t);
      seek(which === 'in' ? S.in : S.out);
      return true;
    };
    el.addEventListener('change', commit);
    el.addEventListener('blur', () => render());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { if (commit()) el.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        S.active = which;
        nudge((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 1));
        el.value = fmt(which === 'in' ? S.in : S.out);
      }
    });
  }

  document.querySelectorAll('.quick button').forEach((b) => b.addEventListener('click', () => {
    if (!S.dur) return;
    const len = Number(b.dataset.len);
    setRange(S.in, Math.min(S.dur, S.in + len), 'in');
  }));

  const NOTES = {
    original: 'Seluruh bingkai video.',
    '9:16': 'Dipotong tegak dari tengah — untuk Shorts, Reels, TikTok.',
    '1:1': 'Persegi dari tengah bingkai.',
    '4:5': 'Potret dari tengah — untuk feed Instagram.',
  };
  function syncAspect() {
    const audio = document.querySelector('input[name=q]:checked').value === 'audio';
    const a = document.querySelector('input[name=a]:checked').value;
    $('aspectSet').disabled = audio;
    $('aspectNote').textContent = audio ? 'Tidak berlaku untuk audio.' : NOTES[a];
    const show = !audio && a !== 'original';
    $('guide').hidden = !show;
    if (show) $('guide').style.setProperty('--ar', a.replace(':', ' / '));
  }
  document.querySelectorAll('input[name=q], input[name=a]').forEach((r) => r.addEventListener('change', syncAspect));

  document.addEventListener('keydown', (e) => {
    if (!S.dur || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' && e.target.type !== 'radio' && e.target.type !== 'checkbox') return;
    const k = e.key.toLowerCase();
    if (k === ' ' && tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); togglePlay(); }
    else if (k === 'i') setIn(now());
    else if (k === 'o') setOut(now());
    else if ((k === 'arrowleft' || k === 'arrowright') && tag !== 'INPUT') {
      e.preventDefault();
      const dir = k === 'arrowleft' ? -1 : 1;
      if (e.shiftKey) nudge(dir * 0.1);
      else seek(clamp(now() + dir, 0, S.dur));
    }
  });

  window.addEventListener('resize', () => { if (S.dur) drawRuler(); });

  /* ---------- boot ---------- */

  async function connect() {
    const el = $('health');
    let h = null;
    try { h = await api('/api/health'); } catch { /* no server reachable */ }
    S.server = !!(h && 'ytdlp' in h);
    const missing = S.server ? [!h.ytdlp && 'yt-dlp', !h.ffmpeg && 'ffmpeg'].filter(Boolean) : [];
    el.hidden = false;
    el.classList.toggle('bad', missing.length > 0);
    el.textContent = !S.server ? 'mode tautan' : missing.length ? `${missing.join(' & ')} belum terpasang` : `yt-dlp ${h.ytdlp} · siap`;
    $('dlBox').hidden = !S.server;
    $('srvBox').classList.toggle('on', S.server);
    $('srvState').textContent = S.server ? 'terhubung' : 'tidak terhubung';
    $('srvUrl').value = API;
    if (!S.server) { $('guide').hidden = true; S.clips.clear(); renderClips(); return; }
    syncAspect();
    try {
      const { clips } = await api('/api/clips');
      S.clips.clear();
      clips.forEach((c) => S.clips.set(c.id, c));
      renderClips();
      poll();
    } catch { /* list stays empty */ }
  }

  $('srvForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    API = cleanBase($('srvUrl').value);
    store.set(API);
    $('srvState').textContent = 'memeriksa…';
    await connect();
    if (S.server && S.videoId && !S.title) loadVideo(S.url);
  });

  /* ---------- share links ---------- */

  function embedUrl() {
    const a = Math.floor(S.in), b = Math.max(a + 1, Math.ceil(S.out));
    return `https://www.youtube.com/embed/${S.videoId}?start=${a}&end=${b}&autoplay=1&rel=0`;
  }
  async function copy(btn, text) {
    if (!S.videoId || !S.dur) return;
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Tersalin ✓';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1600);
    } catch {
      window.prompt('Salin teks ini:', text);
    }
  }
  $('copyLink').addEventListener('click', (e) => copy(e.currentTarget, embedUrl()));
  $('copyEmbed').addEventListener('click', (e) => copy(e.currentTarget,
    `<iframe width="560" height="315" src="${embedUrl().replace('&autoplay=1', '').replace(/&/g, '&amp;')}" title="${(S.title || 'Klip YouTube').replace(/"/g, '&quot;')}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>`));

  const booted = connect();

  const preset = new URLSearchParams(location.search).get('url');
  if (preset) { $('url').value = preset; loadVideo(preset); }

  window.__potong = { S, parseTime, fmt, parseId }; // handy for debugging in the console
})();
