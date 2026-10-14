from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Auth ---
    jwt_secret: str
    admin_username: str
    admin_password_hash: str
    access_token_ttl_min: int = 60 * 24 * 7  # telefonda haftada bir giris
    cookie_secure: bool = False  # LAN'da duz HTTP; HTTPS'e gecilirse true yap
    # Kabul edilen Host header'lari (DNS rebinding'e karsi). Virgulle ayrilmis.
    allowed_hosts: str = "*"

    # --- Portlar ---
    # api_port: dashboard + API (telefon/tarayici)
    # ingest_port: ESP32 + pc-agent
    # Ikisi de sadece laptopun LAN IP'sine publish edilir (docker-compose.yml)
    api_port: int = 8000
    ingest_port: int = 8001

    # --- ESP32 ---
    esp32_api_key: str
    power_command_ttl_s: int = 60

    # --- PC ajani ---
    pc_agent_url: str = ""
    pc_agent_secret: str
    pc_heartbeat_timeout_s: int = 90

    # --- Dashboard ---
    static_dir: str = "static"  # Next.js static export (Docker image icine kopyalanir)

    # --- DB ---
    database_url: str = "sqlite:///./data/presence.db"
    history_retention_days: int = 30

    # --- Davranis ---
    absence_debounce_min: int = 10
    auto_wake_enabled: bool = False
    auto_wake_cooldown_min: int = 5
    auto_sleep_enabled: bool = False
    auto_sleep_after_min: int = 30

    # --- Rate limit ---
    rate_limit_login: str = "5/minute"
    rate_limit_presence: str = "120/minute"
