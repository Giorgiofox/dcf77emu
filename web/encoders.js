// Time-signal protocol encoders for the radio-clock audio sync web app.
//
// Every supported station is carried on a square tone at carrier/k (k=4 by
// default) played at very low amplitude, AM-modulated per second. The k-th
// harmonic produced by the phone speaker/amp nonlinearity lands on the real
// longwave carrier.
//
// Each encoder turns a wall-clock minute into a 60-entry array. Entry s is the
// modulation plan for second s: a list of {ms, level} segments (level 0..1 gain
// multiplier on the carrier), summing to 1000 ms. The audio engine schedules
// gain changes from these.

(function (root) {
  'use strict';

  // ---- zoned time -------------------------------------------------------

  // Break a Date into wall-clock parts for an IANA zone, plus DST flag.
  function zonedParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const parts = {
      year: +p.year, month: +p.month, day: +p.day,
      hour: +p.hour, minute: +p.minute, second: +p.second,
      dow: wdMap[p.weekday],            // 0=Sun .. 6=Sat
      offsetMin: zoneOffsetMin(date, timeZone),
    };
    // DST = current offset greater than this zone's January offset. This treats
    // January as standard time, which holds for all stations here (all northern
    // hemisphere); it would be inverted for a southern-hemisphere zone.
    const jan = new Date(Date.UTC(parts.year, 0, 1, 12, 0, 0));
    parts.isDST = parts.offsetMin > zoneOffsetMin(jan, timeZone);
    parts.doy = dayOfYear(parts.year, parts.month, parts.day);
    return parts;
  }

  function zoneOffsetMin(date, timeZone) {
    // offset = (wall time in zone) - UTC, in minutes
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  }

  function dayOfYear(y, m, d) {
    const a = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let n = d;
    for (let i = 0; i < m - 1; i++) n += a[i];
    return n;
  }
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

  // ---- bit helpers ------------------------------------------------------

  function evenParity(bits) { return bits.reduce((a, b) => a + b, 0) & 1; }

  // ---- DCF77 (Germany, 77.5 kHz, CET/CEST) ------------------------------
  // bit 0 -> carrier reduced 100 ms, bit 1 -> 200 ms, second 59 -> no pulse.
  function encodeDCF77(parts) {
    const bits = new Array(60).fill(0);
    bits[16] = 0; // DST change announce (simplified: off)
    bits[17] = parts.isDST ? 1 : 0; // CEST
    bits[18] = parts.isDST ? 0 : 1; // CET
    bits[20] = 1; // start of time

    const min = bcdLSB(parts.minute, 7);
    setSlot(bits, 21, min);
    bits[28] = evenParity(min);

    const hr = bcdLSB(parts.hour, 6);
    setSlot(bits, 29, hr);
    bits[35] = evenParity(hr);

    const day = bcdLSB(parts.day, 6);
    setSlot(bits, 36, day);
    const iso = parts.dow === 0 ? 7 : parts.dow; // 1=Mon..7=Sun
    setSlot(bits, 42, bcdLSB(iso, 3));
    setSlot(bits, 45, bcdLSB(parts.month, 5));
    setSlot(bits, 50, bcdLSB(parts.year % 100, 8));
    bits[58] = evenParity(bits.slice(36, 58));

    const REDUCED = 0.15;
    return bits.map((b, s) => {
      if (s === 59) return [{ ms: 1000, level: 1.0 }];
      const pulse = b ? 200 : 100;
      return [{ ms: pulse, level: REDUCED }, { ms: 1000 - pulse, level: 1.0 }];
    });
  }

  // classic LSB-first BCD over n bits (DCF77 style)
  function bcdLSB(value, n) {
    const digits = [];
    let v = value;
    do { digits.push(v % 10); v = Math.floor(v / 10); } while (v > 0);
    const bits = [];
    for (const d of digits) for (let i = 0; i < 4; i++) bits.push((d >> i) & 1);
    while (bits.length < n) bits.push(0);
    return bits.slice(0, n);
  }

  function setSlot(arr, start, bits) {
    for (let i = 0; i < bits.length; i++) arr[start + i] = bits[i];
  }

  // ---- JJY (Japan, 40 & 60 kHz, JST) ------------------------------------
  // symbol per second: 'M' marker, or bit 0/1. MSB-first weighted BCD.
  function encodeJJY(parts) {
    const sym = new Array(60).fill(0);
    const M = 'M';
    sym[0] = M; sym[9] = M; sym[19] = M; sym[29] = M; sym[39] = M; sym[49] = M; sym[59] = M;

    const min = parts.minute, hr = parts.hour, doy = parts.doy;
    const yr = parts.year % 100;

    // minutes  (tens 40,20,10 | units 8,4,2,1)
    putWeighted(sym, [1, 2, 3], Math.floor(min / 10), [4, 2, 1]);
    putWeighted(sym, [5, 6, 7, 8], min % 10, [8, 4, 2, 1]);

    // hours (20,10 | 8,4,2,1)
    putWeighted(sym, [12, 13], Math.floor(hr / 10), [2, 1]);
    putWeighted(sym, [15, 16, 17, 18], hr % 10, [8, 4, 2, 1]);

    // day of year (100s | 10s | 1s)
    putWeighted(sym, [22, 23], Math.floor(doy / 100), [2, 1]);
    putWeighted(sym, [25, 26, 27, 28], Math.floor((doy % 100) / 10), [8, 4, 2, 1]);
    putWeighted(sym, [30, 31, 32, 33], doy % 10, [8, 4, 2, 1]);

    // parity: PA1 hours (36), PA2 minutes (37)
    sym[36] = parityOf(sym, [12, 13, 15, 16, 17, 18]);
    sym[37] = parityOf(sym, [1, 2, 3, 5, 6, 7, 8]);

    // year last two digits (41..48)
    putWeighted(sym, [41, 42, 43, 44], Math.floor(yr / 10), [8, 4, 2, 1]);
    putWeighted(sym, [45, 46, 47, 48], yr % 10, [8, 4, 2, 1]);

    // weekday (50,51,52) 0=Sun..6=Sat
    putWeighted(sym, [50, 51, 52], parts.dow, [4, 2, 1]);

    return sym.map((s) => jjySeg(s));
  }

  function jjySeg(s) {
    if (s === 'M') return [{ ms: 200, level: 1.0 }, { ms: 800, level: 0.1 }];
    if (s === 1) return [{ ms: 500, level: 1.0 }, { ms: 500, level: 0.1 }];
    return [{ ms: 800, level: 1.0 }, { ms: 200, level: 0.1 }]; // bit 0
  }

  // ---- WWVB (USA, 60 kHz, UTC) ------------------------------------------
  // reduced power at START of second: 0->200ms, 1->500ms, marker->800ms.
  function encodeWWVB(parts) {
    const sym = new Array(60).fill(0);
    sym[0] = 'M'; [9, 19, 29, 39, 49, 59].forEach((i) => (sym[i] = 'M'));

    const min = parts.minute, hr = parts.hour, doy = parts.doy, yr = parts.year % 100;
    putWeighted(sym, [1, 2, 3], Math.floor(min / 10), [4, 2, 1]);
    putWeighted(sym, [5, 6, 7, 8], min % 10, [8, 4, 2, 1]);
    putWeighted(sym, [12, 13], Math.floor(hr / 10), [2, 1]);
    putWeighted(sym, [15, 16, 17, 18], hr % 10, [8, 4, 2, 1]);
    putWeighted(sym, [22, 23], Math.floor(doy / 100), [2, 1]);
    putWeighted(sym, [25, 26, 27, 28], Math.floor((doy % 100) / 10), [8, 4, 2, 1]);
    putWeighted(sym, [30, 31, 32, 33], doy % 10, [8, 4, 2, 1]);
    putWeighted(sym, [45, 46, 47, 48], Math.floor(yr / 10), [8, 4, 2, 1]);
    putWeighted(sym, [50, 51, 52, 53], yr % 10, [8, 4, 2, 1]);
    sym[55] = isLeap(parts.year) ? 1 : 0;          // leap-year indicator
    // DST status bits 57/58. Steady state: both 0 = standard, both 1 = DST.
    // Transition days (one bit differing) are not modelled.
    sym[57] = parts.isDST ? 1 : 0;
    sym[58] = parts.isDST ? 1 : 0;

    return sym.map((s) => wwvbSeg(s));
  }

  function wwvbSeg(s) {
    const R = 0.15;
    if (s === 'M') return [{ ms: 800, level: R }, { ms: 200, level: 1.0 }];
    if (s === 1) return [{ ms: 500, level: R }, { ms: 500, level: 1.0 }];
    return [{ ms: 200, level: R }, { ms: 800, level: 1.0 }]; // bit 0
  }

  // ---- weighted-BCD helpers (MSB-first slots) ---------------------------
  function weighted(value, weights) {
    const out = new Array(weights.length).fill(0);
    let v = value;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] <= v) { out[i] = 1; v -= weights[i]; }
    }
    return out;
  }
  function putWeighted(sym, idxs, value, weights) {
    const bits = weighted(value, weights);
    for (let i = 0; i < idxs.length; i++) sym[idxs[i]] = bits[i];
  }
  function parityOf(sym, idxs) {
    let n = 0;
    for (const i of idxs) if (sym[i] === 1) n++;
    return n & 1;
  }
  function oddParity(bits) { return (bits.reduce((a, b) => a + b, 0) & 1) ? 0 : 1; }

  // ---- MSF (England, 60 kHz, UTC + summer-time flag) --------------------
  // 100% OOK. Every second: 100 ms carrier OFF, then bit A (100-200 ms) and
  // bit B (200-300 ms) keyed off when set, then carrier ON. Second 0 = 500 ms
  // off minute marker. Layout per NPL MSF time-and-date code.
  function encodeMSF(parts) {
    const A = new Array(60).fill(0), B = new Array(60).fill(0);
    const yr = parts.year % 100, mo = parts.month, day = parts.day;
    const dow = parts.dow, hr = parts.hour, min = parts.minute;

    putWeighted(A, [17, 18, 19, 20], Math.floor(yr / 10), [8, 4, 2, 1]);
    putWeighted(A, [21, 22, 23, 24], yr % 10, [8, 4, 2, 1]);
    A[25] = Math.floor(mo / 10);
    putWeighted(A, [26, 27, 28, 29], mo % 10, [8, 4, 2, 1]);
    putWeighted(A, [30, 31], Math.floor(day / 10), [2, 1]);
    putWeighted(A, [32, 33, 34, 35], day % 10, [8, 4, 2, 1]);
    putWeighted(A, [36, 37, 38], dow, [4, 2, 1]);          // 0=Sun..6=Sat
    putWeighted(A, [39, 40], Math.floor(hr / 10), [2, 1]);
    putWeighted(A, [41, 42, 43, 44], hr % 10, [8, 4, 2, 1]);
    putWeighted(A, [45, 46, 47], Math.floor(min / 10), [4, 2, 1]);
    putWeighted(A, [48, 49, 50, 51], min % 10, [8, 4, 2, 1]);
    // minute boundary marker 01111110 in A 52..59
    [0, 1, 1, 1, 1, 1, 1, 0].forEach((b, i) => (A[52 + i] = b));

    // odd parity bits in B
    B[54] = oddParity(A.slice(17, 25));     // year
    B[55] = oddParity(A.slice(25, 36));     // month + day
    B[56] = oddParity(A.slice(36, 39));     // day of week
    B[57] = oddParity(A.slice(39, 52));     // hour + minute
    B[58] = parts.isDST ? 1 : 0;            // summer time in effect

    const OFF = 0.0;
    return A.map((a, s) => {
      if (s === 0) return [{ ms: 500, level: OFF }, { ms: 500, level: 1.0 }];
      const segs = [{ ms: 100, level: OFF }];
      segs.push({ ms: 100, level: a ? OFF : 1.0 });
      segs.push({ ms: 100, level: B[s] ? OFF : 1.0 });
      segs.push({ ms: 700, level: 1.0 });
      return segs;
    });
  }

  // ---- BPC (China, 68.5 kHz, CST) --- EXPERIMENTAL ----------------------
  // Pulse-width AM: carrier reduced at start of each second for (v+1)*100 ms
  // encoding a 2-bit symbol v (0..3); second 0/20/40 = no reduction (marker).
  // 20-second frame repeated 3x/minute. The public field layout is partly
  // proprietary; this is a best-effort reconstruction from open decoders and
  // is unverified against a real BPC clock.
  function encodeBPC(parts) {
    const h12 = parts.hour % 12;
    const ampm = parts.hour >= 12 ? 1 : 0;
    const iso = parts.dow === 0 ? 7 : parts.dow;   // 1=Mon..7=Sun
    const yr = parts.year % 100;
    const out = new Array(60);
    for (let s = 0; s < 60; s++) {
      const frame = Math.floor(s / 20);            // 0,1,2
      const pos = s % 20;
      let v;
      switch (pos) {
        case 0: v = 'M'; break;                    // frame marker, no reduction
        case 1: v = frame; break;                  // P1 frame number
        case 2: v = ampm << 1; break;              // P2 am/pm (parity omitted)
        case 3: v = (h12 >> 2) & 3; break;
        case 4: v = h12 & 3; break;
        case 5: v = (iso >> 2) & 3; break;
        case 6: v = iso & 3; break;
        case 7: v = 0; break;                       // P3 parity (omitted)
        case 8: v = (parts.minute >> 4) & 3; break;
        case 9: v = (parts.minute >> 2) & 3; break;
        case 10: v = parts.minute & 3; break;
        case 11: v = (parts.day >> 4) & 3; break;
        case 12: v = (parts.day >> 2) & 3; break;
        case 13: v = parts.day & 3; break;
        case 14: v = (parts.month >> 2) & 3; break;
        case 15: v = parts.month & 3; break;
        case 16: v = (yr >> 4) & 3; break;
        case 17: v = (yr >> 2) & 3; break;
        case 18: v = yr & 3; break;
        default: v = 0;                             // P4 parity (omitted)
      }
      out[s] = bpcSeg(v);
    }
    return out;
  }
  function bpcSeg(v) {
    if (v === 'M') return [{ ms: 1000, level: 1.0 }];
    const off = (v + 1) * 100;
    return [{ ms: off, level: 0.1 }, { ms: 1000 - off, level: 1.0 }];
  }

  // ---- station table ----------------------------------------------------
  // announceNext: DCF77 and MSF frames describe the minute that begins at the
  // NEXT minute marker, so the frame encodes current_minute + 1. WWVB and JJY
  // encode the current minute (on-time marker at second 0).
  const STATIONS = {
    dcf77: { label: 'DCF77 / Mainflingen (Germany)', carrier: 77500, tz: 'Europe/Berlin', encode: encodeDCF77, announceNext: true },
    bpc:   { label: 'BPC / Shangqiu (China)',         carrier: 68500, tz: 'Asia/Shanghai', encode: encodeBPC, note: 'experimental: BPC frame layout is partly proprietary and unverified' },
    wwvb:  { label: 'WWVB / Fort Collins (USA)',       carrier: 60000, tz: 'UTC', dstZone: 'America/New_York', encode: encodeWWVB },
    jjy60: { label: 'JJY60 / Fukuoka-Saga (Japan)',    carrier: 60000, tz: 'Asia/Tokyo',    encode: encodeJJY },
    jjy40: { label: 'JJY40 / Fukushima (Japan)',       carrier: 40000, tz: 'Asia/Tokyo',    encode: encodeJJY },
    msf:   { label: 'MSF / Anthorn (England)',         carrier: 60000, tz: 'UTC', dstZone: 'Europe/London', encode: encodeMSF, announceNext: true },
  };

  const api = { STATIONS, zonedParts, encodeDCF77, encodeJJY, encodeWWVB, encodeMSF, encodeBPC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Encoders = api;
})(typeof window !== 'undefined' ? window : globalThis);
