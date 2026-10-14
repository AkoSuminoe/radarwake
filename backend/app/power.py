"""PC guc durumu ve komutlari.

Uyandirma WOL ile degil, ESP32'nin optokuplorla anakart guc tusuna basmasiyla yapilir.
Acik bir PC'de tusa basmak onu kapatabilecegi icin, basma komutu yalnizca PC
kapali gorunurken (pc-agent heartbeat'i yokken) kuyruga eklenir.
"""

import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import require_jwt
from .config import Settings
from .db import get_db
from .models import AppState, PowerCommand, utcnow
from .signing import sign

log = logging.getLogger("radarwake.power")
router = APIRouter()

# Basma komutu onaylandiktan sonra PC'nin acilip heartbeat gondermesi icin taninan sure
WAKE_GRACE = timedelta(minutes=3)


def aware(dt: datetime | None) -> datetime | None:
    # SQLite timezone bilgisini saklamaz; tum zamanlar UTC yazilir
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def get_state(db: Session) -> AppState:
    state = db.get(AppState, 1)
    if state is None:
        state = AppState(id=1)
        db.add(state)
        db.flush()
    return state


def pc_is_on(state: AppState, settings: Settings, now: datetime) -> bool:
    hb = aware(state.last_heartbeat_at)
    return hb is not None and now - hb <= timedelta(seconds=settings.pc_heartbeat_timeout_s)


def pending_command(db: Session, now: datetime) -> PowerCommand | None:
    cmd = db.scalars(select(PowerCommand).where(PowerCommand.acked_at.is_(None)).order_by(PowerCommand.id.desc())).first()
    if cmd is not None and aware(cmd.expires_at) > now:
        return cmd
    return None


def recently_pressed(db: Session, state: AppState, now: datetime) -> bool:
    """Komut onaylandi ama PC henuz heartbeat gondermedi (aciliyor)."""
    cmd = db.scalars(select(PowerCommand).where(PowerCommand.acked_at.is_not(None)).order_by(PowerCommand.id.desc())).first()
    if cmd is None:
        return False
    acked = aware(cmd.acked_at)
    hb = aware(state.last_heartbeat_at)
    return now - acked <= WAKE_GRACE and (hb is None or hb < acked)


def pc_state(db: Session, settings: Settings, now: datetime) -> str:
    state = get_state(db)
    if pc_is_on(state, settings, now):
        return "on"
    if pending_command(db, now) is not None or recently_pressed(db, state, now):
        return "waking"
    return "off"


def enqueue_press(db: Session, settings: Settings, source: str, now: datetime) -> PowerCommand:
    last_id = db.scalars(select(PowerCommand.id).order_by(PowerCommand.id.desc())).first() or 0
    cmd = PowerCommand(
        id=max(int(now.timestamp()), last_id + 1),
        created_at=now,
        expires_at=now + timedelta(seconds=settings.power_command_ttl_s),
        source=source,
    )
    db.add(cmd)
    db.flush()
    log.info("power press queued id=%s source=%s", cmd.id, source)
    return cmd


def send_agent(settings: Settings, action: str) -> None:
    if not settings.pc_agent_url:
        raise RuntimeError("PC_AGENT_URL ayarli degil")
    body = json.dumps({"action": action}).encode()
    headers = {"Content-Type": "application/json", **sign(settings.pc_agent_secret, body)}
    resp = httpx.post(f"{settings.pc_agent_url.rstrip('/')}/power", content=body, headers=headers, timeout=5)
    resp.raise_for_status()


class StatusOut(BaseModel):
    state: str  # on | off | waking
    last_heartbeat_at: datetime | None
    pending_command_id: int | None


class SleepIn(BaseModel):
    action: str = "sleep"  # sleep | shutdown


@router.get("/api/pc/status", response_model=StatusOut, dependencies=[Depends(require_jwt)])
def status(request: Request, db: Session = Depends(get_db)) -> StatusOut:
    now = utcnow()
    state = get_state(db)
    pending = pending_command(db, now)
    return StatusOut(
        state=pc_state(db, request.app.state.settings, now),
        last_heartbeat_at=aware(state.last_heartbeat_at),
        pending_command_id=pending.id if pending else None,
    )


@router.post("/api/pc/wake", status_code=202, dependencies=[Depends(require_jwt)])
def wake(request: Request, db: Session = Depends(get_db)) -> dict:
    settings = request.app.state.settings
    now = utcnow()
    current = pc_state(db, settings, now)
    if current == "on":
        raise HTTPException(status_code=409, detail="pc already on")
    if current == "waking":
        raise HTTPException(status_code=409, detail="wake already in progress")
    cmd = enqueue_press(db, settings, "manual", now)
    db.commit()
    return {"command_id": cmd.id}


@router.post("/api/pc/sleep", dependencies=[Depends(require_jwt)])
def sleep(request: Request, body: SleepIn | None = None, db: Session = Depends(get_db)) -> dict:
    action = (body or SleepIn()).action
    if action not in ("sleep", "shutdown"):
        raise HTTPException(status_code=422, detail="action must be sleep or shutdown")
    settings = request.app.state.settings
    now = utcnow()
    state = get_state(db)
    if not pc_is_on(state, settings, now):
        raise HTTPException(status_code=409, detail="pc is not on")
    try:
        send_agent(settings, action)
    except Exception as exc:
        log.warning("pc-agent %s failed: %s", action, exc)
        raise HTTPException(status_code=502, detail="pc-agent unreachable")
    state.last_sleep_at = now
    db.commit()
    return {"ok": True, "action": action}


@router.post("/api/pc/heartbeat")
async def heartbeat(request: Request, db: Session = Depends(get_db)) -> dict:
    body = await request.body()
    h = request.headers
    if not request.app.state.agent_verifier.verify(h.get("x-timestamp"), h.get("x-nonce"), h.get("x-signature"), body):
        raise HTTPException(status_code=401, detail="invalid signature")
    get_state(db).last_heartbeat_at = utcnow()
    db.commit()
    return {"ok": True}
