"""Basit bellek ici sliding-window rate limiter (tek process, tek kullanici)."""

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_UNITS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}


def parse_rate(rate: str) -> tuple[int, int]:
    count, unit = rate.split("/", 1)
    return int(count), _UNITS[unit.strip().rstrip("s")]


class RateLimiter:
    def __init__(self):
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, bucket: str, key: str, rate: str) -> bool:
        limit, window = parse_rate(rate)
        now = time.monotonic()
        with self._lock:
            q = self._hits[(bucket, key)]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True


def client_key(request: Request) -> str:
    # Servis dogrudan LAN'a acik (proxy yok): istemci IP'si dogrudan socket'ten gelir,
    # X-Forwarded-For gibi header'lara guvenilmez (sahtelenebilir).
    return request.client.host if request.client else "unknown"


def rate_limit(bucket: str, setting_name: str):
    def dependency(request: Request) -> None:
        rate = getattr(request.app.state.settings, setting_name)
        if not request.app.state.limiter.hit(bucket, client_key(request), rate):
            raise HTTPException(status_code=429, detail="too many requests")

    return dependency
