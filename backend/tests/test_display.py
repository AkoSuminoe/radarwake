import io
import json
import struct

from PIL import Image

from .conftest import API_KEY

ESP = {"X-API-Key": API_KEY}


def make_gif(frames=3, size=(40, 30)) -> bytes:
    imgs = [Image.new("RGB", size, (i * 80, 255 - i * 80, 120)) for i in range(frames)]
    buf = io.BytesIO()
    imgs[0].save(buf, format="GIF", save_all=True, append_images=imgs[1:], duration=[50, 120, 200][:frames], loop=0)
    return buf.getvalue()


def parse_bundle(data: bytes) -> tuple[dict, bytes]:
    (n,) = struct.unpack("<H", data[:2])
    return json.loads(data[2:2 + n]), data[2 + n:]


def upload(api, token, data=None, name="test"):
    return api.post(f"/api/display/animations?name={name}", content=data or make_gif(),
                    headers={**token, "Content-Type": "image/gif"})


def disp(ingest, presence=True):
    return ingest.post("/api/presence", json={"presence": presence}, headers=ESP).json()["disp"]


def test_default_profiles_seeded(api, token):
    names = [p["name"] for p in api.get("/api/display/profiles", headers=token).json()]
    assert names == ["Calm status", "Sonar", "Clock"]
    s = api.get("/api/display/settings", headers=token).json()
    assert s["active_profile_id"] == s["showing_profile_id"]


def test_display_routes_need_auth(api, ingest):
    assert api.get("/api/display/profiles").status_code == 401
    assert api.post("/api/display/animations?name=x", content=make_gif()).status_code == 401
    assert ingest.get("/api/device/display").status_code == 401


def test_port_split(api, ingest, token):
    assert api.get("/api/device/display", headers=ESP).status_code == 404
    assert ingest.get("/api/display/profiles", headers=token).status_code == 404


def test_device_bundle_status_layout(ingest):
    r = ingest.get("/api/device/display", headers=ESP)
    assert r.status_code == 200
    cfg, frames = parse_bundle(r.content)
    assert cfg["layout"] == "status" and cfg["anim"] is None and frames == b""
    assert r.headers["x-display-version"] == cfg["v"]


def test_gif_profile_bundle(api, ingest, token):
    anim = upload(api, token).json()
    assert anim["frames"] == 3
    p = api.post("/api/display/profiles", headers=token,
                 json={"name": "Chibi", "layout": "gif_status", "anim_id": anim["id"]}).json()
    before = disp(ingest)
    api.post(f"/api/display/profiles/{p['id']}/activate", headers=token)
    after = disp(ingest)
    assert before != after and after.startswith(f"{p['id']}.")

    cfg, frames = parse_bundle(ingest.get("/api/device/display", headers=ESP).content)
    a = cfg["anim"]
    assert cfg["layout"] == "gif_status" and (a["w"], a["h"], a["n"]) == (64, 64, 3)
    assert len(frames) == 64 // 8 * 64 * 3
    assert a["dur"] == [50, 120, 200]


def test_full_screen_gif_size(api, token):
    anim = upload(api, token).json()
    p = api.post("/api/display/profiles", headers=token,
                 json={"name": "Full", "layout": "gif", "anim_id": anim["id"]}).json()
    r = api.get(f"/api/display/preview?profile={p['id']}", headers=token)
    cfg, frames = parse_bundle(r.content)
    assert len(frames) == 128 // 8 * 64 * 3


def test_animation_edit_changes_version(api, token):
    anim = upload(api, token).json()
    p = api.post("/api/display/profiles", headers=token,
                 json={"name": "G", "layout": "gif", "anim_id": anim["id"]}).json()
    api.patch(f"/api/display/animations/{anim['id']}", headers=token, json={"invert": True})
    p2 = next(x for x in api.get("/api/display/profiles", headers=token).json() if x["id"] == p["id"])
    assert p2["version"] != p["version"]


def test_idle_profile_when_empty(api, ingest, token):
    profiles = api.get("/api/display/profiles", headers=token).json()
    clock = next(p for p in profiles if p["layout"] == "clock")
    s = api.get("/api/display/settings", headers=token).json()
    s["idle_profile_id"] = clock["id"]
    assert api.put("/api/display/settings", headers=token, json=s).status_code == 200
    assert disp(ingest, presence=False).startswith(f"{clock['id']}.")
    assert not disp(ingest, presence=True).startswith(f"{clock['id']}.")


def test_rotation_minimum(api, token):
    s = api.get("/api/display/settings", headers=token).json()
    s["rotate_every_s"] = 2
    assert api.put("/api/display/settings", headers=token, json=s).status_code == 422


def test_upload_rejects_garbage_and_oversize(api, token):
    assert upload(api, token, data=b"not an image").status_code == 415
    big = b"0" * (8 * 1024 * 1024 + 1)
    assert upload(api, token, data=big).status_code == 413


def test_delete_animation_detaches_profiles(api, token):
    anim = upload(api, token).json()
    p = api.post("/api/display/profiles", headers=token,
                 json={"name": "G", "layout": "gif", "anim_id": anim["id"]}).json()
    assert api.delete(f"/api/display/animations/{anim['id']}", headers=token).status_code == 200
    p2 = next(x for x in api.get("/api/display/profiles", headers=token).json() if x["id"] == p["id"])
    assert p2["anim_id"] is None


def test_cannot_delete_last_profile(api, token):
    ids = [p["id"] for p in api.get("/api/display/profiles", headers=token).json()]
    for pid in ids[:-1]:
        assert api.delete(f"/api/display/profiles/{pid}", headers=token).status_code == 200
    assert api.delete(f"/api/display/profiles/{ids[-1]}", headers=token).status_code == 409
