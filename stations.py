"""Time-signal protocol encoders for all supported radio stations.

Ported from the verified web implementation (web/encoders.js). Each encoder
turns the local time of a minute into a 60-entry list. Entry s is the
modulation plan for second s: a list of (ms, level) segments where level is a
0..1 gain multiplier on the carrier, summing to 1000 ms. The audio engine
renders these into the amplitude envelope.

Stations:
    dcf77  Germany   77.5 kHz  CET/CEST   AM, carrier reduced 100/200 ms
    wwvb   USA       60   kHz  UTC        AM, reduced at start 200/500/800 ms
    jjy40  Japan     40   kHz  JST        AM, reduced at end
    jjy60  Japan     60   kHz  JST        AM, reduced at end
    msf    England   60   kHz  UTC+dst    100% OOK, dual bit A/B per second
    bpc    China     68.5 kHz  CST        pulse-width AM, 2 bits/second (EXPERIMENTAL)

The carrier itself is generated at carrier/k (k=4 default) so the k-th harmonic
produced by speaker/amp nonlinearity lands on the real longwave carrier.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from dcf77 import encode_minute  # trusted DCF77 bit encoder


@dataclass(frozen=True)
class Parts:
    year: int
    month: int
    day: int
    hour: int
    minute: int
    dow: int        # 0=Sun .. 6=Sat
    doy: int        # day of year, 1-based
    is_dst: bool


def parts_from(dt_local: datetime, is_dst: bool) -> Parts:
    """Build Parts from a tz-aware datetime (in the field timezone)."""
    return Parts(
        year=dt_local.year, month=dt_local.month, day=dt_local.day,
        hour=dt_local.hour, minute=dt_local.minute,
        dow=(dt_local.weekday() + 1) % 7,        # Mon=0..Sun=6 -> Sun=0..Sat=6
        doy=dt_local.timetuple().tm_yday,
        is_dst=is_dst,
    )


# ---- bit helpers ---------------------------------------------------------

def _weighted(value: int, weights: list[int]) -> list[int]:
    out = [0] * len(weights)
    v = value
    for i, w in enumerate(weights):
        if w <= v:
            out[i] = 1
            v -= w
    return out


def _odd_parity(bits: list[int]) -> int:
    return 0 if (sum(bits) & 1) else 1


# ---- DCF77 (reuse trusted encoder) --------------------------------------

def encode_dcf77(p: Parts, tz) -> list[list[tuple[int, float]]]:
    dt = datetime(p.year, p.month, p.day, p.hour, p.minute, 0, tzinfo=tz)
    bits = encode_minute(dt, tz)
    REDUCED = 0.15
    out = []
    for s, b in enumerate(bits):
        if s == 59:
            out.append([(1000, 1.0)])
        else:
            pulse = 200 if b else 100
            out.append([(pulse, REDUCED), (1000 - pulse, 1.0)])
    return out


# ---- WWVB (reduced power at start) --------------------------------------

def encode_wwvb(p: Parts) -> list[list[tuple[int, float]]]:
    sym = [0] * 60
    for i in (0, 9, 19, 29, 39, 49, 59):
        sym[i] = 'M'
    yr = p.year % 100
    _put(sym, [1, 2, 3], p.minute // 10, [4, 2, 1])
    _put(sym, [5, 6, 7, 8], p.minute % 10, [8, 4, 2, 1])
    _put(sym, [12, 13], p.hour // 10, [2, 1])
    _put(sym, [15, 16, 17, 18], p.hour % 10, [8, 4, 2, 1])
    _put(sym, [22, 23], p.doy // 100, [2, 1])
    _put(sym, [25, 26, 27, 28], (p.doy % 100) // 10, [8, 4, 2, 1])
    _put(sym, [30, 31, 32, 33], p.doy % 10, [8, 4, 2, 1])
    _put(sym, [45, 46, 47, 48], yr // 10, [8, 4, 2, 1])
    _put(sym, [50, 51, 52, 53], yr % 10, [8, 4, 2, 1])
    sym[55] = 1 if _is_leap(p.year) else 0          # leap-year indicator
    # DST status bits (57, 58). Steady state: both 0 = standard, both 1 = DST.
    # Transition days (one bit differing) are not modelled.
    sym[57] = 1 if p.is_dst else 0
    sym[58] = 1 if p.is_dst else 0
    return [_wwvb_seg(s) for s in sym]


def _wwvb_seg(s):
    R = 0.15
    if s == 'M':
        return [(800, R), (200, 1.0)]
    if s == 1:
        return [(500, R), (500, 1.0)]
    return [(200, R), (800, 1.0)]


# ---- JJY 40/60 (reduced power at end) -----------------------------------

def encode_jjy(p: Parts) -> list[list[tuple[int, float]]]:
    sym = [0] * 60
    for i in (0, 9, 19, 29, 39, 49, 59):
        sym[i] = 'M'
    _put(sym, [1, 2, 3], p.minute // 10, [4, 2, 1])
    _put(sym, [5, 6, 7, 8], p.minute % 10, [8, 4, 2, 1])
    _put(sym, [12, 13], p.hour // 10, [2, 1])
    _put(sym, [15, 16, 17, 18], p.hour % 10, [8, 4, 2, 1])
    _put(sym, [22, 23], p.doy // 100, [2, 1])
    _put(sym, [25, 26, 27, 28], (p.doy % 100) // 10, [8, 4, 2, 1])
    _put(sym, [30, 31, 32, 33], p.doy % 10, [8, 4, 2, 1])
    sym[36] = _parity_of(sym, [12, 13, 15, 16, 17, 18])   # PA1 hours
    sym[37] = _parity_of(sym, [1, 2, 3, 5, 6, 7, 8])       # PA2 minutes
    yr = p.year % 100
    _put(sym, [41, 42, 43, 44], yr // 10, [8, 4, 2, 1])
    _put(sym, [45, 46, 47, 48], yr % 10, [8, 4, 2, 1])
    _put(sym, [50, 51, 52], p.dow, [4, 2, 1])
    return [_jjy_seg(s) for s in sym]


def _jjy_seg(s):
    if s == 'M':
        return [(200, 1.0), (800, 0.1)]
    if s == 1:
        return [(500, 1.0), (500, 0.1)]
    return [(800, 1.0), (200, 0.1)]


# ---- MSF (100% OOK, dual bit A/B) ---------------------------------------

def encode_msf(p: Parts) -> list[list[tuple[int, float]]]:
    A = [0] * 60
    B = [0] * 60
    yr = p.year % 100
    _put(A, [17, 18, 19, 20], yr // 10, [8, 4, 2, 1])
    _put(A, [21, 22, 23, 24], yr % 10, [8, 4, 2, 1])
    A[25] = p.month // 10
    _put(A, [26, 27, 28, 29], p.month % 10, [8, 4, 2, 1])
    _put(A, [30, 31], p.day // 10, [2, 1])
    _put(A, [32, 33, 34, 35], p.day % 10, [8, 4, 2, 1])
    _put(A, [36, 37, 38], p.dow, [4, 2, 1])
    _put(A, [39, 40], p.hour // 10, [2, 1])
    _put(A, [41, 42, 43, 44], p.hour % 10, [8, 4, 2, 1])
    _put(A, [45, 46, 47], p.minute // 10, [4, 2, 1])
    _put(A, [48, 49, 50, 51], p.minute % 10, [8, 4, 2, 1])
    for i, b in enumerate([0, 1, 1, 1, 1, 1, 1, 0]):
        A[52 + i] = b
    B[54] = _odd_parity(A[17:25])     # year
    B[55] = _odd_parity(A[25:36])     # month + day
    B[56] = _odd_parity(A[36:39])     # day of week
    B[57] = _odd_parity(A[39:52])     # hour + minute
    B[58] = 1 if p.is_dst else 0      # summer time in effect

    OFF = 0.0
    out = []
    for s in range(60):
        if s == 0:
            out.append([(500, OFF), (500, 1.0)])
        else:
            out.append([
                (100, OFF),
                (100, OFF if A[s] else 1.0),
                (100, OFF if B[s] else 1.0),
                (700, 1.0),
            ])
    return out


# ---- BPC (pulse-width AM) --- EXPERIMENTAL ------------------------------

def encode_bpc(p: Parts) -> list[list[tuple[int, float]]]:
    h12 = p.hour % 12
    ampm = 1 if p.hour >= 12 else 0
    iso = 7 if p.dow == 0 else p.dow      # 1=Mon..7=Sun
    yr = p.year % 100
    out = []
    for s in range(60):
        frame = s // 20
        pos = s % 20
        if pos == 0:
            v = 'M'
        elif pos == 1:
            v = frame
        elif pos == 2:
            v = ampm << 1
        elif pos == 3:
            v = (h12 >> 2) & 3
        elif pos == 4:
            v = h12 & 3
        elif pos == 5:
            v = (iso >> 2) & 3
        elif pos == 6:
            v = iso & 3
        elif pos == 8:
            v = (p.minute >> 4) & 3
        elif pos == 9:
            v = (p.minute >> 2) & 3
        elif pos == 10:
            v = p.minute & 3
        elif pos == 11:
            v = (p.day >> 4) & 3
        elif pos == 12:
            v = (p.day >> 2) & 3
        elif pos == 13:
            v = p.day & 3
        elif pos == 14:
            v = (p.month >> 2) & 3
        elif pos == 15:
            v = p.month & 3
        elif pos == 16:
            v = (yr >> 4) & 3
        elif pos == 17:
            v = (yr >> 2) & 3
        elif pos == 18:
            v = yr & 3
        else:
            v = 0
        out.append(_bpc_seg(v))
    return out


def _bpc_seg(v):
    if v == 'M':
        return [(1000, 1.0)]
    off = (v + 1) * 100
    return [(off, 0.1), (1000 - off, 1.0)]


# ---- shared helpers ------------------------------------------------------

def _put(sym, idxs, value, weights):
    bits = _weighted(value, weights)
    for i, idx in enumerate(idxs):
        sym[idx] = bits[i]


def _parity_of(sym, idxs):
    return sum(1 for i in idxs if sym[i] == 1) & 1


def _is_leap(y):
    return (y % 4 == 0 and y % 100 != 0) or y % 400 == 0


# ---- station table -------------------------------------------------------

@dataclass(frozen=True)
class Station:
    key: str
    label: str
    carrier_hz: float
    tz: str
    encode: object
    dst_zone: str | None = None
    announce_next: bool = False     # frame describes the FOLLOWING minute
    note: str | None = None


# announce_next: DCF77 and MSF transmit the time of the minute that begins at
# the NEXT minute marker, so the frame must encode current_minute + 1. WWVB and
# JJY encode the current minute (on-time marker at second 0).
STATIONS: dict[str, Station] = {
    "dcf77": Station("dcf77", "DCF77 / Mainflingen (Germany)", 77500.0, "Europe/Berlin",
                     lambda p, tz: encode_dcf77(p, tz), announce_next=True),
    "wwvb": Station("wwvb", "WWVB / Fort Collins (USA)", 60000.0, "UTC",
                    lambda p, tz: encode_wwvb(p), dst_zone="America/New_York"),
    "jjy60": Station("jjy60", "JJY60 / Fukuoka-Saga (Japan)", 60000.0, "Asia/Tokyo",
                     lambda p, tz: encode_jjy(p)),
    "jjy40": Station("jjy40", "JJY40 / Fukushima (Japan)", 40000.0, "Asia/Tokyo",
                     lambda p, tz: encode_jjy(p)),
    "msf": Station("msf", "MSF / Anthorn (England)", 60000.0, "UTC",
                   lambda p, tz: encode_msf(p), dst_zone="Europe/London",
                   announce_next=True),
    "bpc": Station("bpc", "BPC / Shangqiu (China)", 68500.0, "Asia/Shanghai",
                   lambda p, tz: encode_bpc(p),
                   note="experimental: BPC frame layout is partly proprietary and unverified"),
}
