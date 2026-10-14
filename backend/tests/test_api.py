import json
from datetime import timedelta

from app.models import utcnow
from app.power import get_state
from app.signing import sign

from .conftest import AGENT_SECRET, API_KEY, PASSWORD

ESP = {"X-API-Key": API_KEY}


def report(ingest, presence=True, **extra):
    return ingest.post("/api/presence", json={"presence": presence, **extra}, headers=ESP)


def heartbeat(ingest, secret=AGENT_SECRET):
    body = json.dumps({"host": "desktop"}).encode()
    return ingest.post("/api/pc/heartbeat", content=body, headers={"Content-Type": "application/json", **sign(secret, body)})


# --- auth ---

def test_login_wrong_password(api):
    assert api.post("/api/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401


def test_login_wrong_user(api):
    assert api.post("/api/auth/login", json={"username": "root", "password": PASSWORD}).status_code == 401


def test_login_rate_limited(api):
    codes = [api.post("/api/auth/login", json={"username": "admin", "password": "x"}).status_code for _ in range(6)]
    assert codes[-1] == 429


def test_protected_routes_need_jwt(api):
    assert api.get("/api/pc/status").status_code == 401
    assert api.post("/api/pc/wake").status_code == 401
    assert api.post("/api/pc/sleep").status_code == 401
    assert api.get("/api/presence/history").status_code == 401
    assert api.get("/api/pc/status", headers={"Authorization": "Bearer garbage"}).status_code == 401


# --- port ayrimi ---

def test_presence_not_on_api_port(api):
    assert api.post("/api/presence", json={"presence": True}, headers=ESP).status_code == 404


def test_dashboard_not_on_ingest_port(ingest):
    assert ingest.post("/api/auth/login", json={"username": "admin", "password": PASSWORD}).status_code == 404
    assert ingest.post("/api/pc/wake").status_code == 404


def test_health_on_both(api, ingest):
    assert api.get("/api/health").status_code == 200
    assert ingest.get("/api/health").status_code == 200


# --- presence ---

def test_presence_requires_api_key(ingest):
    assert ingest.post("/api/presence", json={"presence": True}).status_code == 401
    assert ingest.post("/api/presence", json={"presence": True}, headers={"X-API-Key": "wrong"}).status_code == 401


def test_presence_recorded(api, ingest, token):
    r = report(ingest, presence=True, moving=True, moving_dist=120)
    assert r.status_code == 200
    assert r.json()["command"] is None
    cur = api.get("/api/presence/current", headers=token).json()
    assert cur["present"] and cur["sensor_online"] and cur["moving_dist"] == 120
    hist = api.get("/api/presence/history", headers=token).json()
    assert len(hist) == 1 and hist[0]["presence"] is True


def test_radar_ok_reported(api, ingest, token):
    assert api.get("/api/presence/current", headers=token).json()["radar_ok"] is None
    report(ingest, presence=False, radar_ok=False)
    assert api.get("/api/presence/current", headers=token).json()["radar_ok"] is False
    report(ingest, presence=False)
    assert api.get("/api/presence/current", headers=token).json()["radar_ok"] is True


def test_absence_debounced(app, api, ingest, token):
    report(ingest, presence=True)
    report(ingest, presence=False)
    assert api.get("/api/presence/current", headers=token).json()["present"] is True
    with app.state.sessionmaker() as db:
        get_state(db).last_present_at = utcnow() - timedelta(minutes=11)
        db.commit()
    assert api.get("/api/presence/current", headers=token).json()["present"] is False


# --- heartbeat / status ---

def test_heartbeat_signature(ingest):
    assert heartbeat(ingest).status_code == 200
    assert heartbeat(ingest, secret="wrong").status_code == 401


def test_heartbeat_replay_rejected(ingest):
    body = b"{}"
    headers = {"Content-Type": "application/json", **sign(AGENT_SECRET, body)}
    assert ingest.post("/api/pc/heartbeat", content=body, headers=headers).status_code == 200
    assert ingest.post("/api/pc/heartbeat", content=body, headers=headers).status_code == 401


def test_status_follows_heartbeat(api, ingest, token):
    assert api.get("/api/pc/status", headers=token).json()["state"] == "off"
    assert report(ingest).json()["pc"] == "off"
    heartbeat(ingest)
    assert api.get("/api/pc/status", headers=token).json()["state"] == "on"
    assert report(ingest).json()["pc"] == "on"


# --- wake akisi ---

def test_wake_refused_when_on(api, ingest, token):
    heartbeat(ingest)
    assert api.post("/api/pc/wake", headers=token).status_code == 409


def test_wake_command_flow(api, ingest, token):
    r = api.post("/api/pc/wake", headers=token)
    assert r.status_code == 202
    cmd_id = r.json()["command_id"]

    # ikinci basma reddedilir (acik PC'yi kapatmasin)
    assert api.post("/api/pc/wake", headers=token).status_code == 409
    assert api.get("/api/pc/status", headers=token).json()["state"] == "waking"

    out = report(ingest).json()
    assert out == {"ack_ok": False, "pc": "waking", "command": "press_power", "id": cmd_id}

    out = report(ingest, ack=cmd_id).json()
    assert out["ack_ok"] is True and out["command"] is None

    # PC acilana kadar "waking", heartbeat gelince "on"
    assert api.post("/api/pc/wake", headers=token).status_code == 409
    heartbeat(ingest)
    assert api.get("/api/pc/status", headers=token).json()["state"] == "on"


def test_command_expires(app, api, ingest, token):
    cmd_id = api.post("/api/pc/wake", headers=token).json()["command_id"]
    from app.models import PowerCommand

    with app.state.sessionmaker() as db:
        db.get(PowerCommand, cmd_id).expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert report(ingest).json()["command"] is None
    assert api.get("/api/pc/status", headers=token).json()["state"] == "off"


def test_auto_wake(settings, ingest):
    settings.auto_wake_enabled = True
    out = report(ingest, presence=True).json()
    assert out["command"] == "press_power"
    # cooldown + pending: ikinci rapor yeni komut uretmez, ayni komutu tekrar verir
    assert report(ingest, presence=True).json()["id"] == out["id"]


def test_auto_wake_disabled_by_default(ingest):
    assert report(ingest, presence=True).json()["command"] is None


# --- sleep ---

def test_sleep_refused_when_off(api, token):
    assert api.post("/api/pc/sleep", headers=token).status_code == 409


def test_sleep_agent_unreachable(api, ingest, token):
    heartbeat(ingest)
    assert api.post("/api/pc/sleep", headers=token).status_code == 502


def test_sleep_calls_agent(api, ingest, token, monkeypatch):
    sent = []
    monkeypatch.setattr("app.power.send_agent", lambda s, action: sent.append(action))
    heartbeat(ingest)
    assert api.post("/api/pc/sleep", headers=token, json={"action": "shutdown"}).status_code == 200
    assert sent == ["shutdown"]
    assert api.post("/api/pc/sleep", headers=token, json={"action": "rm -rf"}).status_code == 422


# --- cookie oturumu (dashboard) ---

def test_cookie_login_flow(api):
    r = api.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert "httponly" in r.headers["set-cookie"].lower()
    assert "samesite=strict" in r.headers["set-cookie"].lower()
    # TestClient http kullaniyor; Secure cookie'yi geri gondermesi icin elle ekle
    api.cookies.set("rw_token", r.json()["access_token"], path="/api")
    assert api.get("/api/auth/me").json() == {"username": "admin"}
    assert api.get("/api/pc/status").status_code == 200


def test_cookie_post_needs_csrf_header(api):
    token = api.post("/api/auth/login", json={"username": "admin", "password": PASSWORD}).json()["access_token"]
    api.cookies.set("rw_token", token, path="/api")
    assert api.post("/api/pc/wake").status_code == 403
    assert api.post("/api/pc/wake", headers={"X-Radarwake": "1"}).status_code == 202


def test_security_headers(api):
    h = api.get("/api/health").headers
    assert h["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in h["content-security-policy"]


def test_spoofed_forwarded_header_does_not_bypass_rate_limit(api):
    codes = [
        api.post("/api/auth/login", json={"username": "admin", "password": "x"}, headers={"CF-Connecting-IP": f"10.0.0.{i}"}).status_code
        for i in range(6)
    ]
    assert codes[-1] == 429


def test_unknown_host_rejected(settings):
    from fastapi.testclient import TestClient
    from app.main import create_app

    settings.allowed_hosts = "192.168.1.146,localhost"
    app = create_app(settings)
    assert TestClient(app, base_url="http://evil.example:8000").get("/api/health").status_code == 400
    assert TestClient(app, base_url="http://192.168.1.146:8000").get("/api/health").status_code == 200


# --- canli okuma ---

def test_live_reading(api, ingest, token):
    assert api.get("/api/presence/live", headers=token).json() is None
    report(ingest, presence=True, moving=True, moving_dist=82, moving_energy=64, rssi=-50)
    live = api.get("/api/presence/live", headers=token).json()
    assert live["moving_dist"] == 82 and live["moving_energy"] == 64 and live["rssi"] == -50
    assert live["age_s"] < 5
    api.cookies.clear()  # login cookie'si olmadan
    assert api.get("/api/presence/live").status_code == 401


def test_history_throttled(api, ingest, token):
    for d in (50, 55, 60):
        report(ingest, presence=True, stationary=True, stationary_dist=d)
    report(ingest, presence=False)  # durum degisimi her zaman yazilir
    hist = api.get("/api/presence/history", headers=token).json()
    assert [h["presence"] for h in hist] == [True, False]
    assert api.get("/api/presence/live", headers=token).json()["presence"] is False
