"""radarwake backend.

Tek uygulama iki porttan dinler:
- api_port (8000): dashboard + API (telefon/tarayici)
- ingest_port (8001): ESP32 raporlari ve pc-agent heartbeat'i
Ikisi de sadece ev agindan erisilir; internete acilmaz.
Her route yalnizca kendi portundan kabul edilir; digerinden 404 doner.
"""

import asyncio
import logging
import socket
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import auth, power, presence
from .config import Settings
from .db import make_sessionmaker
from .ratelimit import RateLimiter
from .signing import Verifier

INGEST_PATHS = {"/api/presence", "/api/pc/heartbeat"}
SHARED_PATHS = {"/api/health"}


class PortSplitMiddleware:
    def __init__(self, app: ASGIApp, api_port: int, ingest_port: int):
        self.app = app
        self.api_port = api_port
        self.ingest_port = ingest_port

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] not in SHARED_PATHS:
            port = (scope.get("server") or (None, None))[1]
            wanted = self.ingest_port if scope["path"] in INGEST_PATHS else self.api_port
            if port != wanted:
                await JSONResponse({"detail": "Not Found"}, status_code=404)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class SecurityHeadersMiddleware:
    HEADERS = [
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"DENY"),
        (b"referrer-policy", b"no-referrer"),
        (
            b"content-security-policy",
            b"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
            b"img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ]

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + self.HEADERS
            await send(message)

        await self.app(scope, receive, send_with_headers)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="radarwake", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.sessionmaker = make_sessionmaker(settings.database_url)
    app.state.limiter = RateLimiter()
    app.state.agent_verifier = Verifier(settings.pc_agent_secret)

    app.include_router(auth.router)
    app.include_router(presence.router)
    app.include_router(power.router)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    # Dashboard: API route'larindan sonra mount edilir, /api/* onu golgelemez
    if Path(settings.static_dir).is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="dashboard")

    hosts = [h.strip() for h in settings.allowed_hosts.split(",") if h.strip()]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts or ["*"])
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(PortSplitMiddleware, api_port=settings.api_port, ingest_port=settings.ingest_port)
    return app


def _listen(port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.set_inheritable(True)
    return sock


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = create_app()
    s = app.state.settings
    # Tek uvicorn server, iki socket: sinyal yonetimi ve lifespan tek kez calisir
    server = uvicorn.Server(uvicorn.Config(app, proxy_headers=False, server_header=False, access_log=True))
    asyncio.run(server.serve(sockets=[_listen(s.api_port), _listen(s.ingest_port)]))


if __name__ == "__main__":
    run()
