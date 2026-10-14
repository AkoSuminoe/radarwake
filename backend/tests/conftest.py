import pytest
from fastapi.testclient import TestClient
from pwdlib import PasswordHash

from app.config import Settings
from app.main import create_app

PASSWORD = "correct-horse-battery"
API_KEY = "esp-test-key"
AGENT_SECRET = "agent-test-secret"


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        jwt_secret="test-jwt-secret-that-is-long-enough-123",
        admin_username="admin",
        admin_password_hash=PasswordHash.recommended().hash(PASSWORD),
        esp32_api_key=API_KEY,
        pc_agent_secret=AGENT_SECRET,
        pc_agent_url="http://agent.invalid:8765",
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
    )


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def api(app):
    return TestClient(app, base_url="http://testserver:8000")


@pytest.fixture
def ingest(app):
    return TestClient(app, base_url="http://testserver:8001")


@pytest.fixture
def token(api):
    r = api.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
