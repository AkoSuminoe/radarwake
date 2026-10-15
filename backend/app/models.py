from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PresenceEvent(Base):
    __tablename__ = "presence_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    presence: Mapped[bool]
    moving: Mapped[bool]
    stationary: Mapped[bool]
    moving_dist: Mapped[int]
    stationary_dist: Mapped[int]


class AppState(Base):
    """Tek satirlik durum tablosu (id=1)."""

    __tablename__ = "app_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    last_present_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_report_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sleep_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PowerCommand(Base):
    __tablename__ = "power_commands"

    # id = olusturulma unix zamani (saniye). ESP32 son calistirdigi id'yi NVS'te
    # tutup kucuk/esit id'leri reddettigi icin id'ler DB sifirlansa bile artmali.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(16))  # manual | auto


class Animation(Base):
    """Dashboard'dan yuklenen GIF. Orijinal saklanir, OLED karelerine istek aninda cevrilir."""

    __tablename__ = "animations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    original: Mapped[bytes] = mapped_column(LargeBinary)
    frames: Mapped[int] = mapped_column(Integer, default=1)
    fit: Mapped[str] = mapped_column(String(8), default="contain")  # contain | cover
    dither: Mapped[bool] = mapped_column(default=True)
    invert: Mapped[bool] = mapped_column(default=False)
    level: Mapped[int] = mapped_column(Integer, default=128)  # parlaklik/esik, 0-255
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DisplayProfile(Base):
    """OLED ekran profili: duzen + secenekler (+ GIF)."""

    __tablename__ = "display_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    layout: Mapped[str] = mapped_column(String(16))
    anim_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    rev: Mapped[int] = mapped_column(Integer, default=1)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DisplaySettings(Base):
    """Tek satir (id=1): hangi profil gosterilir, rotasyon, bos oda profili."""

    __tablename__ = "display_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    active_profile_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rotate_ids: Mapped[list] = mapped_column(JSON, default=list)
    rotate_every_s: Mapped[int] = mapped_column(Integer, default=0)  # 0 = rotasyon kapali
    idle_profile_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sleep_after_min: Mapped[int] = mapped_column(Integer, default=5)  # 0 = hic kapanma
    tz: Mapped[str] = mapped_column(String(64), default="GMT0BST,M3.5.0/1,M10.5.0")
    rev: Mapped[int] = mapped_column(Integer, default=1)
