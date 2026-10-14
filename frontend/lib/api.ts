// Same origin as the backend. The token lives in an httpOnly cookie (not readable from JS).
// X-Radarwake is the CSRF header the backend requires on cookie-authenticated POSTs.

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

export interface LiveReading {
  ts: string;
  presence: boolean;
  moving: boolean;
  stationary: boolean;
  moving_dist: number;
  stationary_dist: number;
  moving_energy: number;
  stationary_energy: number;
  radar_ok: boolean;
  rssi: number | null;
  age_s: number;
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
  live: () => request<LiveReading | null>("/api/presence/live"),
  history: (hours = 24) => request<PresenceEvent[]>(`/api/presence/history?hours=${hours}`),
  wake: () => request<{ command_id: number }>("/api/pc/wake", { method: "POST" }),
  sleep: (action: "sleep" | "shutdown") =>
    request("/api/pc/sleep", { method: "POST", body: JSON.stringify({ action }) }),
};

const MESSAGES: Record<string, string> = {
  "invalid credentials": "Invalid username or password",
  "too many requests": "Too many attempts. Try again in a minute",
  "pc already on": "Workstation is already online",
  "wake already in progress": "Workstation is already booting",
  "pc is not on": "Workstation is not online",
  "pc-agent unreachable": "Workstation agent is unreachable",
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.message] ?? `${err.message} (${err.status})`;
  return "Connection error";
}
