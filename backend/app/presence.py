"""ESP32 varlik raporlari: kayit, debounce, history ve otomatik uyandirma/uyku."""

import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .auth import require_api_key, require_jwt
from .config import Settings
from .db import get_db
from .display import current_profile, version_of
from .models import PowerCommand, PresenceEvent, utcnow
from .power import aware, enqueue_press, get_state, pc_is_on, pc_state, send_agent
from .ratelimit import rate_limit

log = logging.getLogger("radarwake.presence")
router = APIRouter()

SENSOR_OFFLINE_AFTER = timedelta(seconds=60)
# ESP biri varken saniyede bir rapor atar. Her raporu DB'ye yazmak yerine canli okuma
# bellekte tutulur; DB'ye sadece durum degisince ya da bu araliktan seyrek yazilir.
HISTORY_SAMPLE_EVERY = timedelta(seconds=60)


class PresenceIn(BaseModel):
    presence: bool
    moving: bool = False
    stationary: bool = False
    moving_dist: int = Field(default=0, ge=0, le=10000)
    stationary_dist: int = Field(default=0, ge=0, le=10000)
    moving_energy: int = Field(default=0, ge=0, le=100)
    stationary_energy: int = Field(default=0, ge=0, le=100)
    radar_ok: bool = True  # ESP radardan veri alabiliyor mu
    rssi: int | None = Field(default=None, ge=-127, le=0)
    ack: int | None = None


class PresenceOut(BaseModel):
    ack_ok: bool = False
    pc: str = "off"  # on | off | waking (ESP ekraninda gosterilir)
    command: str | None = None
    id: int | None = None
    disp: str = "0"  # ekran bundle surumu; degisince ESP /api/device/display'i indirir


def is_present(last_present_at: datetime | None, settings: Settings, now: datetime) -> bool:
    lp = aware(last_present_at)
    return lp is not None and now - lp <= timedelta(minutes=settings.absence_debounce_min)


def _auto_sleep(settings: Settings) -> None:
    try:
        send_agent(settings, "sleep")
        log.info("auto sleep sent")
    except Exception as exc:
        log.warning("auto sleep failed: %s", exc)


@router.post(
    "/api/presence",
    response_model=PresenceOut,
    dependencies=[Depends(require_api_key), Depends(rate_limit("presence", "rate_limit_presence"))],
)
def ingest(body: PresenceIn, request: Request, background: BackgroundTasks, db: Session = Depends(get_db)) -> PresenceOut:
    settings: Settings = request.app.state.settings
    now = utcnow()
    state = get_state(db)
    out = PresenceOut()

    # Canli okuma (dashboard sonar ekrani icin), sadece bellekte
    request.app.state.live = {"ts": now, **body.model_dump(exclude={"ack"})}

    last = db.scalars(select(PresenceEvent).order_by(PresenceEvent.id.desc())).first()
    if last is None or last.presence != body.presence or now - aware(last.ts) >= HISTORY_SAMPLE_EVERY:
        event = PresenceEvent(
            ts=now,
            presence=body.presence,
            moving=body.moving,
            stationary=body.stationary,
            moving_dist=body.moving_dist,
            stationary_dist=body.stationary_dist,
        )
        db.add(event)
        db.flush()
        if event.id % 1000 == 0:
            db.execute(delete(PresenceEvent).where(PresenceEvent.ts < now - timedelta(days=settings.history_retention_days)))

    state.last_report_at = now
    if body.presence:
        state.last_present_at = now

    if body.ack is not None:
        cmd = db.get(PowerCommand, body.ack)
        if cmd is not None and cmd.acked_at is None:
            cmd.acked_at = now
            log.info("power press acked id=%s", cmd.id)
        out.ack_ok = True  # bilinmeyen id'yi de onayla, ESP tekrar denemeyi birakir

    current = pc_state(db, settings, now)
    out.pc = current

    if settings.auto_wake_enabled and body.presence and current == "off":
        last_auto = db.scalars(
            select(PowerCommand).where(PowerCommand.source == "auto").order_by(PowerCommand.id.desc())
        ).first()
        if last_auto is None or now - aware(last_auto.created_at) > timedelta(minutes=settings.auto_wake_cooldown_min):
            enqueue_press(db, settings, "auto", now)

    if settings.auto_sleep_enabled and pc_is_on(state, settings, now):
        lp, ls = aware(state.last_present_at), aware(state.last_sleep_at)
        absent_long = lp is not None and now - lp > timedelta(minutes=settings.auto_sleep_after_min)
        if absent_long and (ls is None or ls < lp):
            state.last_sleep_at = now
            background.add_task(_auto_sleep, settings)

    cmd = db.scalars(
        select(PowerCommand).where(PowerCommand.acked_at.is_(None)).order_by(PowerCommand.id.desc())
    ).first()
    if cmd is not None and aware(cmd.expires_at) > now:
        cmd.delivered_at = cmd.delivered_at or now
        out.command, out.id = "press_power", cmd.id

    out.disp = version_of(db, current_profile(db, now))
    db.commit()
    return out


class CurrentOut(BaseModel):
    present: bool  # debounce uygulanmis
    raw_presence: bool | None
    moving_dist: int | None
    stationary_dist: int | None
    sensor_online: bool  # ESP rapor gonderiyor mu
    radar_ok: bool | None  # ESP radardan veri alabiliyor mu (None: henuz rapor yok)
    last_present_at: datetime | None
    last_report_at: datetime | None


@router.get("/api/presence/current", response_model=CurrentOut, dependencies=[Depends(require_jwt)])
def current(request: Request, db: Session = Depends(get_db)) -> CurrentOut:
    settings = request.app.state.settings
    now = utcnow()
    state = get_state(db)
    last = db.scalars(select(PresenceEvent).order_by(PresenceEvent.id.desc())).first()
    lr = aware(state.last_report_at)
    return CurrentOut(
        present=is_present(state.last_present_at, settings, now),
        raw_presence=last.presence if last else None,
        moving_dist=last.moving_dist if last else None,
        stationary_dist=last.stationary_dist if last else None,
        sensor_online=lr is not None and now - lr <= SENSOR_OFFLINE_AFTER,
        radar_ok=live["radar_ok"] if (live := getattr(request.app.state, "live", None)) else None,
        last_present_at=aware(state.last_present_at),
        last_report_at=lr,
    )


class EventOut(BaseModel):
    ts: datetime
    presence: bool
    moving: bool
    stationary: bool
    moving_dist: int
    stationary_dist: int


@router.get("/api/presence/history", response_model=list[EventOut], dependencies=[Depends(require_jwt)])
def history(hours: int = Query(default=24, ge=1, le=168), db: Session = Depends(get_db)) -> list[EventOut]:
    since = utcnow() - timedelta(hours=hours)
    rows = db.scalars(select(PresenceEvent).where(PresenceEvent.ts >= since).order_by(PresenceEvent.ts)).all()
    return [
        EventOut(
            ts=aware(r.ts),
            presence=r.presence,
            moving=r.moving,
            stationary=r.stationary,
            moving_dist=r.moving_dist,
            stationary_dist=r.stationary_dist,
        )
        for r in rows
    ]


class LiveOut(BaseModel):
    ts: datetime
    presence: bool
    moving: bool
    stationary: bool
    moving_dist: int
    stationary_dist: int
    moving_energy: int
    stationary_energy: int
    radar_ok: bool
    rssi: int | None
    age_s: float  # okumanin yasi; buyukse ESP rapor gondermiyor


@router.get("/api/presence/live", response_model=LiveOut | None, dependencies=[Depends(require_jwt)])
def live(request: Request) -> LiveOut | None:
    data = getattr(request.app.state, "live", None)
    if data is None:
        return None
    return LiveOut(**data, age_s=(utcnow() - data["ts"]).total_seconds())
