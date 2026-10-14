from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String
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
