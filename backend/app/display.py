"""OLED ekran profilleri, GIF kutuphanesi ve ESP'ye giden "display bundle".

Sunucu hangi profilin gosterilecegine karar verir (aktif profil, rotasyon, bos oda
profili); ESP her rapor cevabinda gelen `disp` surumu degisince tek bir bundle indirir:

    u16 json_len (little endian) | JSON config | kareler

Kareler 1 bit, U8g2 drawXBM sirasinda (satir basina ceil(w/8) bayt, LSB = soldaki piksel).
"""

import io
import json
import logging
import math
import struct
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from PIL import Image, ImageOps, ImageSequence
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .auth import require_api_key, require_jwt
from .db import get_db
from .models import Animation, DisplayProfile, DisplaySettings, utcnow
from .power import aware, get_state

log = logging.getLogger("radarwake.display")
router = APIRouter()

Layout = Literal["status", "sonar", "clock", "gif", "gif_status", "gif_corner"]
GIF_LAYOUTS = {"gif", "gif_status", "gif_corner"}
# GIF'in cizildigi kutu: (w, h, x, y)
ANIM_BOX = {"gif": (128, 64, 0, 0), "gif_corner": (128, 64, 0, 0), "gif_status": (64, 64, 0, 0)}

MAX_UPLOAD = 8 * 1024 * 1024
MAX_SOURCE_PIXELS = 2048 * 2048
MAX_SOURCE_FRAMES = 1000
MAX_FRAMES = 120
MIN_FRAME_MS = 40
# Bos oda profili icin: son varliktan bu kadar sonra "kimse yok" sayilir
IDLE_AFTER = timedelta(seconds=60)


# --- semalar ---

class ProfileOptions(BaseModel):
    contrast: int = Field(default=160, ge=0, le=255)
    flip: bool = False  # ekran ters takiliysa 180 derece
    sweep: int = Field(default=0, ge=0, le=3)  # sonar tarama hizi, 0 = kapali
    corner: Literal["tl", "tr", "bl", "br"] = "br"  # gif_corner mesafe kosesi
    show_pc: bool = True


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    layout: Layout
    anim_id: int | None = None
    options: ProfileOptions = ProfileOptions()


class ProfilePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    layout: Layout | None = None
    anim_id: int | None = None
    clear_anim: bool = False
    options: ProfileOptions | None = None
    sort: int | None = None


class ProfileOut(BaseModel):
    id: int
    name: str
    layout: str
    anim_id: int | None
    options: ProfileOptions
    sort: int
    version: str


class SettingsIO(BaseModel):
    active_profile_id: int | None = None
    rotate_ids: list[int] = Field(default_factory=list, max_length=50)
    rotate_every_s: int = Field(default=0, ge=0, le=86400)
    idle_profile_id: int | None = None
    sleep_after_min: int = Field(default=5, ge=0, le=1440)
    tz: str = Field(default="GMT0BST,M3.5.0/1,M10.5.0", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9<>+\-,./:]+$")


class SettingsOut(SettingsIO):
    showing_profile_id: int | None = None


class AnimationPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    fit: Literal["contain", "cover"] | None = None
    dither: bool | None = None
    invert: bool | None = None
    level: int | None = Field(default=None, ge=0, le=255)


class AnimationOut(BaseModel):
    id: int
    name: str
    frames: int
    fit: str
    dither: bool
    invert: bool
    level: int
    updated_at: datetime


# --- GIF donusumu ---

def _open(data: bytes) -> Image.Image:
    try:
        im = Image.open(io.BytesIO(data))  # sadece basligi okur
    except Exception:
        raise HTTPException(status_code=415, detail="not a supported image")
    if im.format not in ("GIF", "PNG", "WEBP", "JPEG"):
        raise HTTPException(status_code=415, detail="upload a GIF, PNG, WebP or JPEG")
    if im.width * im.height > MAX_SOURCE_PIXELS:
        raise HTTPException(status_code=413, detail="image is too large (max 2048x2048)")
    try:
        im.load()
    except Exception:
        raise HTTPException(status_code=415, detail="image could not be decoded")
    if getattr(im, "n_frames", 1) > MAX_SOURCE_FRAMES:
        raise HTTPException(status_code=413, detail="too many frames")
    return im


def convert_frames(data: bytes, w: int, h: int, fit: str = "contain", dither: bool = True,
                   invert: bool = False, level: int = 128) -> tuple[list[bytes], list[int]]:
    """Animasyonu w x h, 1 bit XBM karelerine cevirir. (kareler, sureler_ms) doner."""
    im = _open(data)
    total = getattr(im, "n_frames", 1)
    step = max(1, math.ceil(total / MAX_FRAMES))
    bias = 128 - level  # level < 128 aydinlatir, > 128 karartir
    lut = [min(255, max(0, v + bias)) for v in range(256)]

    frames: list[bytes] = []
    durations: list[int] = []
    for i, frame in enumerate(ImageSequence.Iterator(im)):
        dur = int(frame.info.get("duration") or 100)
        if i % step:
            if durations:
                durations[-1] += dur  # atlanan karenin suresi oncekine eklenir
            continue
        rgba = frame.convert("RGBA")
        # Saydam alanlar siyah (OLED'de sonuk) olsun
        flat = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
        flat.alpha_composite(rgba)
        gray = flat.convert("L")
        if fit == "cover":
            gray = ImageOps.fit(gray, (w, h), Image.LANCZOS)
        else:
            gray = ImageOps.contain(gray, (w, h), Image.LANCZOS)
            canvas = Image.new("L", (w, h), 0)
            canvas.paste(gray, ((w - gray.width) // 2, (h - gray.height) // 2))
            gray = canvas
        if invert:
            gray = ImageOps.invert(gray)
        if bias:
            gray = gray.point(lut)
        mono = gray.convert("1") if dither else gray.point(lambda v: 255 if v >= 128 else 0, "1")
        frames.append(mono.tobytes("raw", "1;R"))
        durations.append(dur)
    durations = [max(MIN_FRAME_MS, min(d, 60000)) for d in durations]
    return frames, durations


# --- ayarlar / profil secimi ---

def get_settings_row(db: Session) -> DisplaySettings:
    ds = db.get(DisplaySettings, 1)
    if ds is None:
        ds = DisplaySettings(id=1, rotate_ids=[])
        db.add(ds)
        db.flush()
    return ds


def ensure_defaults(sm: sessionmaker) -> None:
    """Ilk calistirmada varsayilan profilleri olusturur."""
    with sm() as db:
        ds = get_settings_row(db)
        if db.scalars(select(DisplayProfile)).first() is None:
            calm = DisplayProfile(name="Calm status", layout="status", options=ProfileOptions().model_dump(), sort=0)
            sonar = DisplayProfile(name="Sonar", layout="sonar", options=ProfileOptions(sweep=1).model_dump(), sort=1)
            clock = DisplayProfile(name="Clock", layout="clock", options=ProfileOptions().model_dump(), sort=2)
            db.add_all([calm, sonar, clock])
            db.flush()
            ds.active_profile_id = calm.id
        db.commit()


def _profiles(db: Session) -> list[DisplayProfile]:
    return list(db.scalars(select(DisplayProfile).order_by(DisplayProfile.sort, DisplayProfile.id)))


def current_profile(db: Session, now: datetime) -> DisplayProfile | None:
    ds = get_settings_row(db)
    profiles = {p.id: p for p in _profiles(db)}
    if not profiles:
        return None
    lp = aware(get_state(db).last_present_at)
    present = lp is not None and now - lp <= IDLE_AFTER
    if not present and ds.idle_profile_id in profiles:
        return profiles[ds.idle_profile_id]
    rotation = [i for i in (ds.rotate_ids or []) if i in profiles]
    if ds.rotate_every_s > 0 and len(rotation) >= 2:
        return profiles[rotation[int(now.timestamp() // ds.rotate_every_s) % len(rotation)]]
    if ds.active_profile_id in profiles:
        return profiles[ds.active_profile_id]
    return next(iter(profiles.values()))


def version_of(db: Session, profile: DisplayProfile | None) -> str:
    if profile is None:
        return "0"
    ds = get_settings_row(db)
    anim = db.get(Animation, profile.anim_id) if profile.anim_id and profile.layout in GIF_LAYOUTS else None
    anim_rev = int(aware(anim.updated_at).timestamp()) % 100000 if anim else 0
    return f"{profile.id}.{profile.rev}.{anim_rev}.{ds.rev}"


def build_bundle(request: Request, db: Session, profile: DisplayProfile) -> bytes:
    ds = get_settings_row(db)
    version = version_of(db, profile)
    cache: dict = request.app.state.display_cache
    if version in cache:
        return cache[version]

    opts = ProfileOptions(**(profile.options or {}))
    cfg = {
        "v": version,
        "name": profile.name,
        "layout": profile.layout,
        "contrast": opts.contrast,
        "flip": opts.flip,
        "sweep": opts.sweep,
        "corner": opts.corner,
        "show_pc": opts.show_pc,
        "sleep_min": ds.sleep_after_min,
        "tz": ds.tz,
        "anim": None,
    }
    frames: list[bytes] = []
    anim = db.get(Animation, profile.anim_id) if profile.anim_id else None
    if profile.layout in GIF_LAYOUTS and anim is not None:
        w, h, x, y = ANIM_BOX[profile.layout]
        frames, durations = convert_frames(anim.original, w, h, anim.fit, anim.dither, anim.invert, anim.level)
        cfg["anim"] = {"w": w, "h": h, "x": x, "y": y, "n": len(frames), "dur": durations}
    header = json.dumps(cfg, separators=(",", ":")).encode()
    data = struct.pack("<H", len(header)) + header + b"".join(frames)
    if len(cache) > 16:
        cache.clear()
    cache[version] = data
    return data


def _bundle_response(data: bytes, version: str) -> Response:
    return Response(content=data, media_type="application/octet-stream",
                    headers={"X-Display-Version": version, "Cache-Control": "no-store"})


# --- cihaz (8001) ---

@router.get("/api/device/display", dependencies=[Depends(require_api_key)])
def device_display(request: Request, db: Session = Depends(get_db)) -> Response:
    profile = current_profile(db, utcnow())
    if profile is None:
        raise HTTPException(status_code=404, detail="no profile")
    data = build_bundle(request, db, profile)
    db.commit()
    return _bundle_response(data, version_of(db, profile))


# --- dashboard (8000) ---

def _profile_out(db: Session, p: DisplayProfile) -> ProfileOut:
    return ProfileOut(id=p.id, name=p.name, layout=p.layout, anim_id=p.anim_id,
                      options=ProfileOptions(**(p.options or {})), sort=p.sort, version=version_of(db, p))


def _get_profile(db: Session, pid: int) -> DisplayProfile:
    p = db.get(DisplayProfile, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return p


def _check_anim(db: Session, anim_id: int | None) -> None:
    if anim_id is not None and db.get(Animation, anim_id) is None:
        raise HTTPException(status_code=422, detail="animation not found")


@router.get("/api/display/profiles", response_model=list[ProfileOut], dependencies=[Depends(require_jwt)])
def list_profiles(db: Session = Depends(get_db)) -> list[ProfileOut]:
    return [_profile_out(db, p) for p in _profiles(db)]


@router.post("/api/display/profiles", response_model=ProfileOut, dependencies=[Depends(require_jwt)])
def create_profile(body: ProfileIn, db: Session = Depends(get_db)) -> ProfileOut:
    _check_anim(db, body.anim_id)
    last = _profiles(db)
    p = DisplayProfile(name=body.name, layout=body.layout, anim_id=body.anim_id,
                       options=body.options.model_dump(), sort=(last[-1].sort + 1) if last else 0)
    db.add(p)
    db.commit()
    return _profile_out(db, p)


@router.patch("/api/display/profiles/{pid}", response_model=ProfileOut, dependencies=[Depends(require_jwt)])
def update_profile(pid: int, body: ProfilePatch, db: Session = Depends(get_db)) -> ProfileOut:
    p = _get_profile(db, pid)
    if body.name is not None:
        p.name = body.name
    if body.layout is not None:
        p.layout = body.layout
    if body.clear_anim:
        p.anim_id = None
    elif body.anim_id is not None:
        _check_anim(db, body.anim_id)
        p.anim_id = body.anim_id
    if body.options is not None:
        p.options = body.options.model_dump()
    if body.sort is not None:
        p.sort = body.sort
    p.rev += 1
    db.commit()
    return _profile_out(db, p)


@router.delete("/api/display/profiles/{pid}", dependencies=[Depends(require_jwt)])
def delete_profile(pid: int, db: Session = Depends(get_db)) -> dict:
    p = _get_profile(db, pid)
    rest = [x for x in _profiles(db) if x.id != pid]
    if not rest:
        raise HTTPException(status_code=409, detail="keep at least one profile")
    ds = get_settings_row(db)
    if ds.active_profile_id == pid:
        ds.active_profile_id = rest[0].id
    if ds.idle_profile_id == pid:
        ds.idle_profile_id = None
    ds.rotate_ids = [i for i in (ds.rotate_ids or []) if i != pid]
    ds.rev += 1
    db.delete(p)
    db.commit()
    return {"ok": True}


@router.post("/api/display/profiles/{pid}/activate", response_model=SettingsOut, dependencies=[Depends(require_jwt)])
def activate_profile(pid: int, db: Session = Depends(get_db)) -> SettingsOut:
    _get_profile(db, pid)
    ds = get_settings_row(db)
    ds.active_profile_id = pid
    ds.rotate_every_s = 0  # elle secilen profil rotasyonu durdurur
    ds.rev += 1
    db.commit()
    return _settings_out(db)


def _settings_out(db: Session) -> SettingsOut:
    ds = get_settings_row(db)
    showing = current_profile(db, utcnow())
    return SettingsOut(active_profile_id=ds.active_profile_id, rotate_ids=list(ds.rotate_ids or []),
                       rotate_every_s=ds.rotate_every_s, idle_profile_id=ds.idle_profile_id,
                       sleep_after_min=ds.sleep_after_min, tz=ds.tz,
                       showing_profile_id=showing.id if showing else None)


@router.get("/api/display/settings", response_model=SettingsOut, dependencies=[Depends(require_jwt)])
def get_display_settings(db: Session = Depends(get_db)) -> SettingsOut:
    return _settings_out(db)


@router.put("/api/display/settings", response_model=SettingsOut, dependencies=[Depends(require_jwt)])
def put_display_settings(body: SettingsIO, db: Session = Depends(get_db)) -> SettingsOut:
    ids = {p.id for p in _profiles(db)}
    for pid in [body.active_profile_id, body.idle_profile_id, *body.rotate_ids]:
        if pid is not None and pid not in ids:
            raise HTTPException(status_code=422, detail=f"profile {pid} not found")
    if body.rotate_every_s and body.rotate_every_s < 5:
        raise HTTPException(status_code=422, detail="rotate at most every 5 seconds")
    ds = get_settings_row(db)
    ds.active_profile_id = body.active_profile_id or ds.active_profile_id
    ds.rotate_ids = list(dict.fromkeys(body.rotate_ids))
    ds.rotate_every_s = body.rotate_every_s
    ds.idle_profile_id = body.idle_profile_id
    ds.sleep_after_min = body.sleep_after_min
    ds.tz = body.tz
    ds.rev += 1
    db.commit()
    return _settings_out(db)


@router.get("/api/display/preview", dependencies=[Depends(require_jwt)])
def preview_profile(request: Request, profile: int = Query(...), db: Session = Depends(get_db)) -> Response:
    p = _get_profile(db, profile)
    return _bundle_response(build_bundle(request, db, p), version_of(db, p))


def _anim_out(a: Animation) -> AnimationOut:
    return AnimationOut(id=a.id, name=a.name, frames=a.frames, fit=a.fit, dither=a.dither,
                        invert=a.invert, level=a.level, updated_at=aware(a.updated_at))


def _get_anim(db: Session, aid: int) -> Animation:
    a = db.get(Animation, aid)
    if a is None:
        raise HTTPException(status_code=404, detail="animation not found")
    return a


@router.get("/api/display/animations", response_model=list[AnimationOut], dependencies=[Depends(require_jwt)])
def list_animations(db: Session = Depends(get_db)) -> list[AnimationOut]:
    return [_anim_out(a) for a in db.scalars(select(Animation).order_by(Animation.id.desc()))]


@router.post("/api/display/animations", response_model=AnimationOut, dependencies=[Depends(require_jwt)])
async def upload_animation(request: Request, name: str = Query(min_length=1, max_length=64),
                           db: Session = Depends(get_db)) -> AnimationOut:
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="file is too large (max 8 MB)")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_UPLOAD:
            raise HTTPException(status_code=413, detail="file is too large (max 8 MB)")
    if not data:
        raise HTTPException(status_code=422, detail="empty upload")
    frames, _ = convert_frames(bytes(data), 128, 64)  # dogrulama
    a = Animation(name=name, original=bytes(data), frames=len(frames))
    db.add(a)
    db.commit()
    return _anim_out(a)


@router.patch("/api/display/animations/{aid}", response_model=AnimationOut, dependencies=[Depends(require_jwt)])
def update_animation(aid: int, body: AnimationPatch, db: Session = Depends(get_db)) -> AnimationOut:
    a = _get_anim(db, aid)
    for field in ("name", "fit", "dither", "invert", "level"):
        value = getattr(body, field)
        if value is not None:
            setattr(a, field, value)
    a.updated_at = max(utcnow(), aware(a.updated_at) + timedelta(seconds=1))  # surum mutlaka degissin
    db.commit()
    return _anim_out(a)


@router.delete("/api/display/animations/{aid}", dependencies=[Depends(require_jwt)])
def delete_animation(aid: int, db: Session = Depends(get_db)) -> dict:
    a = _get_anim(db, aid)
    for p in db.scalars(select(DisplayProfile).where(DisplayProfile.anim_id == aid)):
        p.anim_id = None
        p.rev += 1
    db.delete(a)
    db.commit()
    return {"ok": True}


@router.get("/api/display/animations/{aid}/original", dependencies=[Depends(require_jwt)])
def animation_original(aid: int, db: Session = Depends(get_db)) -> Response:
    a = _get_anim(db, aid)
    fmt = (Image.open(io.BytesIO(a.original)).format or "GIF").lower()
    return Response(content=a.original, media_type=f"image/{fmt}", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/display/animations/{aid}/frames", dependencies=[Depends(require_jwt)])
def animation_frames(request: Request, aid: int, box: Literal["full", "square"] = "full",
                     db: Session = Depends(get_db)) -> Response:
    """Kutuphane onizlemesi: tek GIF'in donusturulmus hali, bundle formatinda."""
    a = _get_anim(db, aid)
    w, h = (128, 64) if box == "full" else (64, 64)
    frames, durations = convert_frames(a.original, w, h, a.fit, a.dither, a.invert, a.level)
    cfg = {"layout": "gif", "anim": {"w": w, "h": h, "x": 0, "y": 0, "n": len(frames), "dur": durations}}
    header = json.dumps(cfg, separators=(",", ":")).encode()
    return _bundle_response(struct.pack("<H", len(header)) + header + b"".join(frames), "preview")
