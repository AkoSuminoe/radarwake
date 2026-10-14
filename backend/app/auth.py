import hmac
from datetime import timedelta

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash
from pydantic import BaseModel

from .models import utcnow
from .ratelimit import rate_limit

router = APIRouter()
password_hash = PasswordHash.recommended()
_bearer = HTTPBearer(auto_error=False)
# Kullanici adi yanlisken de hash dogrulamasi yapilsin (zamanlama farki olmasin)
_DUMMY_HASH = password_hash.hash("radarwake-dummy-password")

# Dashboard tokeni httpOnly cookie'de tutar (JS erisemez). Cookie ile gelen
# durum degistiren isteklerde ayrica bu header aranir (CSRF'e karsi ikinci kat).
COOKIE_NAME = "rw_token"
CSRF_HEADER = "x-radarwake"


class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


@router.post("/api/auth/login", response_model=TokenOut, dependencies=[Depends(rate_limit("login", "rate_limit_login"))])
def login(body: LoginIn, request: Request, response: Response) -> TokenOut:
    s = request.app.state.settings
    user_ok = hmac.compare_digest(body.username.encode(), s.admin_username.encode())
    stored = s.admin_password_hash if user_ok else _DUMMY_HASH
    try:
        pw_ok = password_hash.verify(body.password, stored)
    except Exception:
        pw_ok = False
    if not (user_ok and pw_ok):
        raise HTTPException(status_code=401, detail="invalid credentials")

    ttl = timedelta(minutes=s.access_token_ttl_min)
    now = utcnow()
    token = jwt.encode({"sub": s.admin_username, "iat": now, "exp": now + ttl}, s.jwt_secret, algorithm="HS256")
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=int(ttl.total_seconds()),
        httponly=True,
        secure=s.cookie_secure,
        samesite="strict",
        path="/api",
    )
    return TokenOut(access_token=token, expires_in=int(ttl.total_seconds()))


@router.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict:
    response.delete_cookie(COOKIE_NAME, path="/api", secure=request.app.state.settings.cookie_secure, httponly=True, samesite="strict")
    return {"ok": True}


def require_jwt(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> str:
    if creds is not None:
        token = creds.credentials
    else:
        token = request.cookies.get(COOKIE_NAME)
        if token and request.method not in ("GET", "HEAD") and request.headers.get(CSRF_HEADER) != "1":
            raise HTTPException(status_code=403, detail="missing csrf header")
    if not token:
        raise HTTPException(status_code=401, detail="missing token", headers={"WWW-Authenticate": "Bearer"})
    s = request.app.state.settings
    try:
        payload = jwt.decode(token, s.jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub"]})
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid token", headers={"WWW-Authenticate": "Bearer"})
    if payload["sub"] != s.admin_username:
        raise HTTPException(status_code=401, detail="invalid token")
    return payload["sub"]


@router.get("/api/auth/me")
def me(user: str = Depends(require_jwt)) -> dict:
    return {"username": user}


def require_api_key(request: Request, x_api_key: str | None = Header(default=None)) -> None:
    expected = request.app.state.settings.esp32_api_key
    if not x_api_key or not hmac.compare_digest(x_api_key.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="invalid api key")
