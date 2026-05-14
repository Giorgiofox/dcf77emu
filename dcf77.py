"""DCF77 protocol encoder.

DCF77 transmits one bit per second. A minute frame is 59 bits (seconds 0-58);
second 59 has no amplitude reduction and marks the minute boundary.

Bit encoding (amplitude reduction of the 77.5 kHz carrier):
    0  ->  carrier reduced for 100 ms at the start of the second
    1  ->  carrier reduced for 200 ms at the start of the second

Frame layout (seconds 0-58):
    0       start of minute marker (always 0)
    1-14    weather/civil warning bits (unused here, set to 0)
    15      call bit (0)
    16      summer-time announcement (set if DST changes in next hour)
    17      CEST in effect (1 = summer time)
    18      CET in effect (1 = winter time)
    19      leap second announcement (0)
    20      start of time info (always 1)
    21-27   minutes  (BCD, low nibble seconds 21-24, high nibble 25-27)
    28      even parity over bits 21-27
    29-34   hours    (BCD, low nibble 29-32, high nibble 33-34)
    35      even parity over bits 29-34
    36-41   day of month (BCD)
    42-44   day of week  (1=Mon ... 7=Sun)
    45-49   month        (BCD)
    50-57   year         (BCD, 00-99)
    58      even parity over bits 36-57
    59      minute marker (no pulse)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def _bcd_bits(value: int, n_bits: int) -> list[int]:
    """Return BCD-encoded value as a list of LSB-first bits of length n_bits."""
    digits = []
    v = value
    while v > 0 or not digits:
        digits.append(v % 10)
        v //= 10
    bits: list[int] = []
    for digit in digits:
        for i in range(4):
            bits.append((digit >> i) & 1)
    if len(bits) < n_bits:
        bits.extend([0] * (n_bits - len(bits)))
    return bits[:n_bits]


def _even_parity(bits: list[int]) -> int:
    return sum(bits) & 1


def _is_dst(dt_local: datetime) -> bool:
    return bool(dt_local.dst()) and dt_local.dst() != timedelta(0)


def _dst_changes_within(dt_local: datetime, tz: ZoneInfo, hours: int = 1) -> bool:
    now_dst = _is_dst(dt_local)
    future = dt_local + timedelta(hours=hours)
    future = future.replace(tzinfo=tz) if future.tzinfo is None else future.astimezone(tz)
    return _is_dst(future) != now_dst


def encode_minute(dt_local: datetime, tz: ZoneInfo) -> list[int]:
    """Encode the minute frame for the minute that *begins* at dt_local.

    dt_local must be tz-aware and represent the local time at second 0 of
    the target minute. Returns a list of 60 bits, indexed by second 0..59.
    Bit 59 is the minute marker (value 0, no pulse emitted by transmitter).
    """
    if dt_local.tzinfo is None:
        raise ValueError("dt_local must be timezone-aware")

    bits = [0] * 60

    bits[0] = 0
    for i in range(1, 15):
        bits[i] = 0
    bits[15] = 0

    bits[16] = 1 if _dst_changes_within(dt_local, tz) else 0
    if _is_dst(dt_local):
        bits[17] = 1
        bits[18] = 0
    else:
        bits[17] = 0
        bits[18] = 1
    bits[19] = 0
    bits[20] = 1

    minute_bits = _bcd_bits(dt_local.minute, 7)
    bits[21:28] = minute_bits
    bits[28] = _even_parity(minute_bits)

    hour_bits = _bcd_bits(dt_local.hour, 6)
    bits[29:35] = hour_bits
    bits[35] = _even_parity(hour_bits)

    day_bits = _bcd_bits(dt_local.day, 6)
    bits[36:42] = day_bits

    iso_weekday = dt_local.isoweekday()
    dow_bits = _bcd_bits(iso_weekday, 3)
    bits[42:45] = dow_bits

    month_bits = _bcd_bits(dt_local.month, 5)
    bits[45:50] = month_bits

    year_bits = _bcd_bits(dt_local.year % 100, 8)
    bits[50:58] = year_bits

    bits[58] = _even_parity(bits[36:58])

    bits[59] = 0
    return bits


def bit_pulse_ms(bit: int, second: int) -> int:
    """Return the carrier-reduction duration in milliseconds for a given bit.

    Second 59 emits no pulse (returns 0).
    """
    if second == 59:
        return 0
    return 200 if bit else 100
