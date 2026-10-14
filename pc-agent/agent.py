"""radarwake PC ajani (masaustunde calisir, sadece stdlib).

- Backend'e (laptop, ingest portu) periyodik HMAC imzali heartbeat gonderir:
  backend PC'nin acik oldugunu buradan anlar.
- 8765 portunda backend'den gelen imzali sleep/shutdown komutlarini dinler.

Imza semasi backend/app/signing.py ile ayni:
  hex(hmac_sha256(secret, f"{ts}.{nonce}.".encode() + body))
"""

import ctypes
import hashlib
import hmac
import json
import logging
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_SKEW_S = 30
MAX_BODY = 1024
CONFIG_PATH = Path(__file__).with_name("config.json")
LOG_PATH = Path(__file__).with_name("agent.log")

log = logging.getLogger("radarwake.agent")


def load_config() -> dict:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for key in ("backend_url", "secret"):
        if not cfg.get(key):
            raise SystemExit(f"config.json: '{key}' bos")
    cfg.setdefault("listen_host", "0.0.0.0")
    cfg.setdefault("listen_port", 8765)
    cfg.setdefault("allowed_ips", [])
    cfg.setdefault("heartbeat_interval_s", 30)
    return cfg


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

    def verify(self, ts, nonce, signature, body: bytes) -> bool:
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


def do_sleep() -> None:
    # Hibernation aciksa bu cagri uyku yerine hazirda beklemeye gecer:
    # gercek uyku icin bir kez `powercfg /h off` calistir.
    ctypes.windll.powrprof.SetSuspendState(False, True, False)


def do_shutdown() -> None:
    subprocess.run(["shutdown", "/s", "/t", "5", "/c", "radarwake"], check=False)


ACTIONS = {"sleep": do_sleep, "shutdown": do_shutdown}


def make_handler(cfg: dict, verifier: Verifier):
    allowed = set(cfg["allowed_ips"])

    class Handler(BaseHTTPRequestHandler):
        server_version = "radarwake-agent"
        sys_version = ""

        def _reply(self, code: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if allowed and self.client_address[0] not in allowed:
                return self._reply(403, {"error": "forbidden"})
            if self.path != "/power":
                return self._reply(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._reply(400, {"error": "bad body"})
            body = self.rfile.read(length)
            h = self.headers
            if not verifier.verify(h.get("X-Timestamp"), h.get("X-Nonce"), h.get("X-Signature"), body):
                log.warning("gecersiz imza: %s", self.client_address[0])
                return self._reply(401, {"error": "invalid signature"})
            try:
                action = json.loads(body).get("action")
            except (ValueError, AttributeError):
                action = None
            fn = ACTIONS.get(action)
            if fn is None:
                return self._reply(400, {"error": "unknown action"})
            log.info("komut: %s (%s)", action, self.client_address[0])
            self._reply(200, {"ok": True, "action": action})
            # Cevap gittikten sonra calistir
            threading.Timer(1.0, fn).start()

        def do_GET(self):
            self._reply(404, {"error": "not found"})

        def log_message(self, fmt, *args):
            log.debug("%s %s", self.client_address[0], fmt % args)

    return Handler


def heartbeat_loop(cfg: dict, stop: threading.Event) -> None:
    url = cfg["backend_url"].rstrip("/") + "/api/pc/heartbeat"
    host = socket.gethostname()
    while not stop.is_set():
        body = json.dumps({"host": host}).encode()
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json", **sign(cfg["secret"], body)})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
        except Exception as exc:
            log.warning("heartbeat basarisiz: %s", exc)
        stop.wait(cfg["heartbeat_interval_s"])


def main() -> None:
    handlers = [logging.FileHandler(LOG_PATH, encoding="utf-8")]
    if sys.stderr is not None:  # pythonw altinda stderr yok
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)

    cfg = load_config()
    stop = threading.Event()
    threading.Thread(target=heartbeat_loop, args=(cfg, stop), daemon=True).start()

    server = ThreadingHTTPServer((cfg["listen_host"], cfg["listen_port"]), make_handler(cfg, Verifier(cfg["secret"])))
    log.info("dinleniyor %s:%s, backend=%s", cfg["listen_host"], cfg["listen_port"], cfg["backend_url"])
    try:
        server.serve_forever()
    finally:
        stop.set()


if __name__ == "__main__":
    main()
