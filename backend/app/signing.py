"""Backend <-> pc-agent arasi HMAC-SHA256 imzali istekler.

imza = hex(hmac_sha256(secret, f"{ts}.{nonce}.".encode() + body))
pc-agent/agent.py ayni semayi kullanir.
"""

import hashlib
import hmac
import secrets
import threading
import time

MAX_SKEW_S = 30


def sign(secret: str, body: bytes) -> dict[str, str]:
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    mac = hmac.new(secret.encode(), f"{ts}.{nonce}.".encode() + body, hashlib.sha256)
    return {"X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": mac.hexdigest()}


class Verifier:
    def __init__(self, secret: str):
        self._secret = secret.encode()
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def verify(self, ts: str | None, nonce: str | None, signature: str | None, body: bytes) -> bool:
        if not (ts and nonce and signature):
            return False
        try:
            ts_i = int(ts)
        except ValueError:
            return False
        now = time.time()
        if abs(now - ts_i) > MAX_SKEW_S:
            return False
        expected = hmac.new(self._secret, f"{ts}.{nonce}.".encode() + body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return False
        with self._lock:
            self._seen = {n: t for n, t in self._seen.items() if now - t <= MAX_SKEW_S * 2}
            if nonce in self._seen:
                return False
            self._seen[nonce] = now
        return True
