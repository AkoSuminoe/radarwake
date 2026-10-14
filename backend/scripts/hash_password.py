"""ADMIN_PASSWORD_HASH uretir ve rastgele secret onerir.

Kullanim:  python scripts/hash_password.py
"""

import getpass
import secrets

from pwdlib import PasswordHash

pw = getpass.getpass("Dashboard parolasi: ")
if pw != getpass.getpass("Tekrar: "):
    raise SystemExit("Parolalar eslesmiyor")
if len(pw) < 12:
    raise SystemExit("En az 12 karakter kullan")

print("\n# backend/.env icine:")
# $ isaretleri docker compose env_file'da sorun cikarmasin diye tek tirnak
print(f"ADMIN_PASSWORD_HASH='{PasswordHash.recommended().hash(pw)}'")
print(f"JWT_SECRET={secrets.token_urlsafe(48)}")
print(f"ESP32_API_KEY={secrets.token_urlsafe(32)}")
print(f"PC_AGENT_SECRET={secrets.token_urlsafe(32)}")
