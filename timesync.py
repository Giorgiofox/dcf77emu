"""NTP time synchronization.

Queries an NTP server on startup and refreshes periodically. The offset
(NTP_time - local_clock) is held in a thread-safe holder and applied when
the emulator asks for "now". This lets the emulator transmit accurate
time even if the local system clock is drifting.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import ntplib


class NtpOffset:
    def __init__(self, server: str = "pool.ntp.org", refresh_seconds: int = 3600):
        self._server = server
        self._refresh = refresh_seconds
        self._offset = timedelta(0)
        self._last_sync: datetime | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()

    @property
    def offset(self) -> timedelta:
        with self._lock:
            return self._offset

    @property
    def last_sync(self) -> datetime | None:
        with self._lock:
            return self._last_sync

    def now(self, tz) -> datetime:
        return (datetime.now(timezone.utc) + self.offset).astimezone(tz)

    def sync_once(self) -> bool:
        client = ntplib.NTPClient()
        try:
            resp = client.request(self._server, version=3, timeout=5)
        except Exception:
            return False
        with self._lock:
            self._offset = timedelta(seconds=resp.offset)
            self._last_sync = datetime.now(timezone.utc)
        return True

    def start(self) -> None:
        t = threading.Thread(target=self._loop, daemon=True)
        t.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.sync_once()
            if self._stop.wait(self._refresh):
                return
