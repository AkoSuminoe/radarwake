// Backend ile ayni origin. Token httpOnly cookie'de; JS ona erismez.
// X-Radarwake header'i backend'in cookie ile gelen POST'larda aradigi CSRF korumasi.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Radarwake": "1", ...init.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export type PcState = "on" | "off" | "waking";

export interface PcStatus {
  state: PcState;
  last_heartbeat_at: string | null;
  pending_command_id: number | null;
}

export interface PresenceCurrent {
  present: boolean;
  raw_presence: boolean | null;
  moving_dist: number | null;
  stationary_dist: number | null;
  sensor_online: boolean;
  radar_ok: boolean | null;
  last_present_at: string | null;
  last_report_at: string | null;
}

export interface PresenceEvent {
  ts: string;
  presence: boolean;
}

export const api = {
  me: () => request<{ username: string }>("/api/auth/me"),
  login: (username: string, password: string) =>
    request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  status: () => request<PcStatus>("/api/pc/status"),
  presence: () => request<PresenceCurrent>("/api/presence/current"),
  history: (hours = 24) => request<PresenceEvent[]>(`/api/presence/history?hours=${hours}`),
  wake: () => request<{ command_id: number }>("/api/pc/wake", { method: "POST" }),
  sleep: (action: "sleep" | "shutdown") =>
    request("/api/pc/sleep", { method: "POST", body: JSON.stringify({ action }) }),
};

const MESSAGES: Record<string, string> = {
  "invalid credentials": "Kullanıcı adı veya şifre yanlış",
  "too many requests": "Çok fazla deneme, biraz bekle",
  "pc already on": "PC zaten açık",
  "wake already in progress": "PC zaten açılıyor",
  "pc is not on": "PC açık değil",
  "pc-agent unreachable": "PC ajanına ulaşılamadı",
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.message] ?? `${err.message} (${err.status})`;
  return "Bağlantı hatası";
}
