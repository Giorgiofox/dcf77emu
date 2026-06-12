// Radio-clock audio sync engine + UI.
//
// Method: emit a square tone at carrier/k (default k=4) at LOW amplitude. The
// phone speaker/amp nonlinearity generates the k-th harmonic, which lands on
// the longwave carrier the radio clock listens for. The tone is AM-keyed each
// second to transmit the time frame in the selected station protocol.

(function () {
  'use strict';
  const E = window.Encoders;
  const el = (id) => document.getElementById(id);
  const ui = {
    station: el('station'), k: el('k'), wave: el('wave'),
    gain: el('gain'), gainVal: el('gainVal'), offset: el('offset'),
    beast: el('beast'), calib: el('calib'),
    start: el('start'), stop: el('stop'),
    fund: el('fund'), carrier: el('carrier'), nyq: el('nyq'), sr: el('sr'),
    clock: el('clock'), zone: el('zone'), syncstat: el('syncstat'),
    secinfo: el('secinfo'), warn: el('warn'),
    minbar: el('minbar'), txdot: el('txdot'), txstat: el('txstat'),
    spectrum: el('spectrum'), spectip: el('spectip'),
    frame: el('frame'), legend: el('legend'), decoded: el('decoded'),
  };

  const STORE = 'rcsync.v1';
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let ctx = null, osc = null, amGain = null, master = null, analyser = null;
  let running = false, schedTimer = null, uiTimer = null, rafId = 0;
  let t0ctx = 0, t0wall = 0, scheduledUntil = 0;
  let curMod = null, curMinKey = -1, stripData = null;

  // ---- settings persistence --------------------------------------------
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) {}
    if (s.station && E.STATIONS[s.station]) ui.station.value = s.station;
    if (s.wave) ui.wave.value = s.wave;
    if (s.gain != null) ui.gain.value = s.gain;
    if (s.offset != null) ui.offset.value = s.offset;
    ui.beast.checked = !!s.beast;
    return s;
  }
  function saveSettings() {
    const s = {
      station: ui.station.value, k: ui.k.value, wave: ui.wave.value,
      gain: ui.gain.value, offset: ui.offset.value, beast: ui.beast.checked,
    };
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) {}
  }

  // ---- helpers ----------------------------------------------------------
  const offsetMs = () => +ui.offset.value || 0;
  const nowWall = () => Date.now() + offsetMs();
  const station = () => E.STATIONS[ui.station.value];
  const fundamental = () => station().carrier / (+ui.k.value);

  function partsNow() {
    const st = station();
    const d = new Date(nowWall());
    const p = E.zonedParts(d, st.tz);
    if (st.dstZone) p.isDST = E.zonedParts(d, st.dstZone).isDST;
    return p;
  }

  // Parts for the frame transmitted during minute `minKey` (epoch minutes).
  // DCF77/MSF announce the next minute, so the frame encodes minKey+1.
  function framePartsFor(st, minKey) {
    const sec = (minKey + (st.announceNext ? 1 : 0)) * 60;
    const d = new Date(sec * 1000);
    const p = E.zonedParts(d, st.tz);
    if (st.dstZone) p.isDST = E.zonedParts(d, st.dstZone).isDST;
    return p;
  }

  // ---- info / warnings --------------------------------------------------
  function refreshInfo() {
    const st = station();
    const sr = ctx ? ctx.sampleRate : 48000;
    const f = fundamental();
    ui.carrier.textContent = (st.carrier / 1000).toFixed(1) + ' kHz';
    ui.fund.textContent = f.toFixed(0) + ' Hz fundamental';
    ui.sr.textContent = sr + ' Hz';
    ui.nyq.textContent = (sr / 2 / 1000).toFixed(1) + ' kHz';
    ui.zone.textContent = st.tz;
    ui.spectip.textContent = `(k=${ui.k.value}, ${(+ui.k.value)}x = ${(st.carrier / 1000).toFixed(1)} kHz)`;
    if (f >= sr / 2) {
      ui.warn.textContent = 'fundamental ' + f.toFixed(0) + ' Hz is above Nyquist. pick a higher k.';
      ui.start.disabled = true;
    } else {
      ui.warn.textContent = st.note || '';
      ui.start.disabled = running;
    }
    drawLegend();
  }

  // ---- periodic wave shapes --------------------------------------------
  function makeWave(kind) {
    const N = 64;
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      if (kind === 'square') imag[n] = (n % 2) ? 4 / (Math.PI * n) : 0;
      else if (kind === 'sawtooth') imag[n] = (2 / (Math.PI * n)) * (n % 2 ? 1 : -1);
      else if (kind === 'pulse') imag[n] = 0.5;
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // ---- start / stop -----------------------------------------------------
  function start() {
    if (running) return;
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const f = fundamental(), sr = ctx.sampleRate;
    if (f >= sr / 2) { refreshInfo(); return; }

    osc = ctx.createOscillator();
    if (ui.wave.value === 'sine') osc.type = 'sine';
    else osc.setPeriodicWave(makeWave(ui.wave.value));
    osc.frequency.value = f;

    amGain = ctx.createGain(); amGain.gain.value = 0;
    master = ctx.createGain(); master.gain.value = effGain();
    analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.5;

    osc.connect(amGain);
    amGain.connect(master);
    amGain.connect(analyser);     // tap post-AM, pre-master so view is volume-independent
    master.connect(ctx.destination);
    osc.start();

    running = true;
    ui.start.disabled = true; ui.stop.disabled = false;
    ui.txdot.className = 'dot tx'; ui.txstat.textContent = 'transmitting';

    const nowMs = nowWall(), nextSec = Math.ceil(nowMs / 1000);
    t0wall = nextSec * 1000;
    t0ctx = ctx.currentTime + (t0wall - nowMs) / 1000;
    scheduledUntil = nextSec; curMinKey = -1;

    scheduleLoop();
    schedTimer = setInterval(scheduleLoop, 250);
    uiTimer = setInterval(tick, 100);
    drawSpectrum();
    refreshInfo();
  }

  function stop() {
    running = false;
    clearInterval(schedTimer); clearInterval(uiTimer); cancelAnimationFrame(rafId);
    if (amGain) amGain.gain.cancelScheduledValues(ctx.currentTime);
    if (osc) { try { osc.stop(); } catch (e) {} osc.disconnect(); }
    osc = null; analyser = null;
    ui.start.disabled = false; ui.stop.disabled = true;
    ui.txdot.className = 'dot off'; ui.txstat.textContent = 'idle';
    ui.secinfo.textContent = '';
    clearSpectrum();
    refreshInfo();
  }

  function effGain() {
    let g = +ui.gain.value;
    if (ui.beast.checked) g = Math.min(0.5, g * 3);
    return g;
  }

  // ---- AM scheduler (verified) -----------------------------------------
  function scheduleLoop() {
    if (!running) return;
    const horizon = nowWall() / 1000 + 1.2;
    const st = station();
    while (scheduledUntil < horizon) {
      const epoch = scheduledUntil;
      const date = new Date(epoch * 1000);
      const parts = E.zonedParts(date, st.tz);   // current second, used for index
      const minKey = Math.floor(epoch / 60);
      if (minKey !== curMinKey) { curMod = st.encode(framePartsFor(st, minKey)); curMinKey = minKey; buildStrip(); }
      const segs = curMod[parts.second];
      const ctxStart = t0ctx + (epoch * 1000 - t0wall) / 1000;
      let cursor = ctxStart;
      for (const seg of segs) {
        const at = Math.max(cursor, ctx.currentTime);
        if (cursor + seg.ms / 1000 > ctx.currentTime) amGain.gain.setValueAtTime(seg.level, at);
        cursor += seg.ms / 1000;
      }
      scheduledUntil += 1;
    }
  }

  // ---- per-100ms UI tick ------------------------------------------------
  function tick() {
    const st = station();
    const ms = nowWall();
    const d = new Date(ms);
    const p = E.zonedParts(d, st.tz);
    if (st.dstZone) p.isDST = E.zonedParts(d, st.dstZone).isDST;
    const pad = (n) => String(n).padStart(2, '0');
    ui.clock.textContent = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    ui.minbar.style.width = ((p.second + (ms % 1000) / 1000) / 60 * 100) + '%';
    renderDecoded(p);

    if (running && curMod) {
      const segs = curMod[p.second];
      const lvl = segs[0].level;
      const kind = lvl === 0 ? 'OFF' : (lvl < 0.9 ? 'reduced' : 'full');
      ui.secinfo.textContent = `sec ${pad(p.second)}/59  ${kind} ${segs[0].ms}ms`;
      ui.txdot.className = lvl < 0.9 ? 'dot red' : 'dot tx';
      drawFrame(p.second);
    } else {
      drawFrame(-1);
    }
  }

  function renderDecoded(p) {
    const st = station();
    const pad = (n) => String(n).padStart(2, '0');
    const fields = [
      ['date', `${p.year}-${pad(p.month)}-${pad(p.day)}`],
      ['time', `${pad(p.hour)}:${pad(p.minute)}`],
      ['weekday', DOW[p.dow]],
      ['zone', st.tz.split('/').pop()],
      ['dst', p.isDST ? 'on' : 'off'],
      ['day of year', String(p.doy)],
    ];
    ui.decoded.innerHTML = fields.map(([k, v]) =>
      `<div class="f"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  }

  // ---- frame strip ------------------------------------------------------
  function buildStrip() {
    stripData = curMod.map((segs) => {
      let reduced = 0, off = false, marker = true;
      for (const s of segs) {
        if (s.level < 0.9) { reduced += s.ms; marker = false; if (s.level === 0) off = true; }
      }
      return { frac: reduced / 1000, off, marker };
    });
  }

  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function drawFrame(curSec) {
    if (!stripData) return;
    const { g, w, h } = fitCanvas(ui.frame);
    g.clearRect(0, 0, w, h);
    const n = 60, gap = 2, cw = (w - gap * (n - 1)) / n;
    for (let s = 0; s < n; s++) {
      const x = s * (cw + gap);
      const d = stripData[s];
      g.fillStyle = '#16241a';
      g.fillRect(x, 0, cw, h);
      const bh = Math.max(2, d.frac * h);
      g.fillStyle = d.marker ? '#21d421' : (d.off ? '#d44' : '#f0c050');
      g.fillRect(x, h - bh, cw, bh);
      if (s === curSec) { g.strokeStyle = '#9bf09b'; g.lineWidth = 1.5; g.strokeRect(x + 0.5, 0.5, cw - 1, h - 1); }
    }
  }

  function drawLegend() {
    const st = station();
    const items = [['#21d421', 'minute / frame marker'], ['#f0c050', 'reduced carrier (bit)']];
    if (station().encode === E.encodeMSF) items.push(['#d44', 'carrier off (OOK)']);
    ui.legend.innerHTML = items.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
  }

  // ---- spectrum ---------------------------------------------------------
  function drawSpectrum() {
    if (!running || !analyser) return;
    const { g, w, h } = fitCanvas(ui.spectrum);
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    analyser.getByteFrequencyData(data);
    const sr = ctx.sampleRate, nyq = sr / 2;
    const maxHz = Math.min(nyq, 24000);
    g.clearRect(0, 0, w, h);
    // bars
    const cols = 128;
    for (let i = 0; i < cols; i++) {
      const f0 = (i / cols) * maxHz;
      const bin = Math.round(f0 / nyq * bins);
      const v = data[bin] / 255;
      const x = (i / cols) * w, bw = w / cols;
      g.fillStyle = `rgba(33,212,33,${0.25 + v * 0.75})`;
      g.fillRect(x, h - v * h, bw - 0.5, v * h);
    }
    // fundamental marker
    const f = fundamental();
    if (f < maxHz) {
      const mx = f / maxHz * w;
      g.strokeStyle = '#9bf09b'; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(mx, 0); g.lineTo(mx, h); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#9bf09b'; g.font = '10px monospace';
      g.fillText((f / 1000).toFixed(1) + 'k', Math.min(mx + 3, w - 28), 11);
    }
    rafId = requestAnimationFrame(drawSpectrum);
  }
  function clearSpectrum() {
    const { g, w, h } = fitCanvas(ui.spectrum);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#2a3a2a'; g.font = '11px monospace';
    g.fillText('idle', 8, h / 2);
  }

  // ---- online clock calibration ----------------------------------------
  async function calibrate() {
    ui.calib.disabled = true; ui.syncstat.textContent = 'calibrating...';
    const endpoints = [
      { url: 'https://worldtimeapi.org/api/timezone/Etc/UTC', get: (j) => Date.parse(j.utc_datetime) },
      { url: 'https://timeapi.io/api/Time/current/zone?timeZone=UTC', get: (j) => Date.parse(j.dateTime + 'Z') },
    ];
    for (const ep of endpoints) {
      try {
        const t0 = Date.now();
        const r = await fetch(ep.url, { cache: 'no-store' });
        const j = await r.json();
        const t1 = Date.now();
        const server = ep.get(j);
        if (!server || isNaN(server)) continue;
        const trueNow = server + (t1 - t0) / 2;   // server stamp ~ request midpoint
        const off = Math.round(trueNow - t1);
        ui.offset.value = off;
        ui.syncstat.textContent = `synced ${off >= 0 ? '+' : ''}${off} ms`;
        ui.syncstat.className = '';
        saveSettings();
        ui.calib.disabled = false;
        return;
      } catch (e) { /* try next */ }
    }
    ui.syncstat.textContent = 'calibration failed, using local clock';
    ui.calib.disabled = false;
  }

  // ---- k options --------------------------------------------------------
  function populateK(preferred) {
    const st = station();
    const sr = ctx ? ctx.sampleRate : 48000;
    const prev = preferred || +ui.k.value;
    ui.k.innerHTML = '';
    let firstValid = null;
    for (let k = 3; k <= 7; k++) {
      const f = st.carrier / k, ok = f < sr / 2;
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `k=${k}  (${f.toFixed(0)} Hz)` + (ok ? '' : '  [> Nyquist]');
      o.disabled = !ok;
      if (ok && firstValid === null) firstValid = k;
      ui.k.appendChild(o);
    }
    const want = [prev, 4, firstValid].find((k) => k && st.carrier / k < sr / 2);
    ui.k.value = want || firstValid;
  }

  // ---- wiring -----------------------------------------------------------
  ui.station.addEventListener('change', () => {
    populateK(); refreshInfo(); buildStripIfRunning(); saveSettings();
    if (running && osc) {
      const f = fundamental();
      if (f < ctx.sampleRate / 2) osc.frequency.setValueAtTime(f, ctx.currentTime);
    }
  });
  ui.k.addEventListener('change', () => { if (running && osc) osc.frequency.setValueAtTime(fundamental(), ctx.currentTime); refreshInfo(); saveSettings(); });
  ui.wave.addEventListener('change', () => {
    if (running && osc) { if (ui.wave.value === 'sine') osc.type = 'sine'; else osc.setPeriodicWave(makeWave(ui.wave.value)); }
    saveSettings();
  });
  ui.gain.addEventListener('input', () => {
    ui.gainVal.textContent = (+ui.gain.value).toFixed(3) + (ui.beast.checked ? ' x3' : '');
    if (master) master.gain.setTargetAtTime(effGain(), ctx.currentTime, 0.02);
    saveSettings();
  });
  ui.beast.addEventListener('change', () => {
    ui.gainVal.textContent = (+ui.gain.value).toFixed(3) + (ui.beast.checked ? ' x3' : '');
    if (master) master.gain.setTargetAtTime(effGain(), ctx.currentTime, 0.02);
    saveSettings();
  });
  ui.offset.addEventListener('change', saveSettings);
  ui.calib.addEventListener('click', calibrate);
  ui.start.addEventListener('click', start);
  ui.stop.addEventListener('click', stop);
  window.addEventListener('resize', () => { drawFrame(running ? -2 : -1); if (!running) clearSpectrum(); });

  function buildStripIfRunning() { curMinKey = -1; } // force strip rebuild next schedule
  // also rebuild strip immediately for idle preview
  function previewStrip() {
    const st = station();
    if (!st.encode) return;
    const p = partsNow();
    const minKey = Math.floor(nowWall() / 60000);
    curMod = st.encode(framePartsFor(st, minKey));
    buildStrip(); drawFrame(p.second);
  }

  // ---- boot -------------------------------------------------------------
  const saved = loadSettings();
  populateK(saved.k);
  ui.gainVal.textContent = (+ui.gain.value).toFixed(3) + (ui.beast.checked ? ' x3' : '');
  refreshInfo();
  clearSpectrum();
  previewStrip();
  tick();
  setInterval(() => { if (!running) { tick(); previewStrip(); } }, 250);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
