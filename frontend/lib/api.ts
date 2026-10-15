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

export type Layout = "status" | "sonar" | "clock" | "gif" | "gif_status" | "gif_corner";

export interface ProfileOptions {
  contrast: number;
  flip: boolean;
  sweep: number;
  corner: "tl" | "tr" | "bl" | "br";
  show_pc: boolean;
}

export interface DisplayProfile {
  id: number;
  name: string;
  layout: Layout;
  anim_id: number | null;
  options: ProfileOptions;
  sort: number;
  version: string;
}

export interface DisplaySettings {
  active_profile_id: number | null;
  rotate_ids: number[];
  rotate_every_s: number;
  idle_profile_id: number | null;
  sleep_after_min: number;
  tz: string;
  showing_profile_id?: number | null;
}

export interface Animation {
  id: number;
  name: string;
  frames: number;
  fit: "contain" | "cover";
  dither: boolean;
  invert: boolean;
  level: number;
  updated_at: string;
}

export type ProfileInput = Pick<DisplayProfile, "name" | "layout" | "options"> & { anim_id: number | null };

async function binary(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.arrayBuffer();
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

  profiles: () => request<DisplayProfile[]>("/api/display/profiles"),
  createProfile: (p: ProfileInput) =>
    request<DisplayProfile>("/api/display/profiles", { method: "POST", body: JSON.stringify(p) }),
  updateProfile: (id: number, p: ProfileInput) =>
    request<DisplayProfile>(`/api/display/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...p, clear_anim: p.anim_id === null }),
    }),
  deleteProfile: (id: number) => request(`/api/display/profiles/${id}`, { method: "DELETE" }),
  activateProfile: (id: number) =>
    request<DisplaySettings>(`/api/display/profiles/${id}/activate`, { method: "POST" }),
  displaySettings: () => request<DisplaySettings>("/api/display/settings"),
  saveDisplaySettings: (s: DisplaySettings) =>
    request<DisplaySettings>("/api/display/settings", { method: "PUT", body: JSON.stringify(s) }),

  animations: () => request<Animation[]>("/api/display/animations"),
  uploadAnimation: (name: string, file: File) =>
    request<Animation>(`/api/display/animations?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    }),
  updateAnimation: (id: number, patch: Partial<Pick<Animation, "name" | "fit" | "dither" | "invert" | "level">>) =>
    request<Animation>(`/api/display/animations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAnimation: (id: number) => request(`/api/display/animations/${id}`, { method: "DELETE" }),
  animationFrames: (id: number, box: "full" | "square") => binary(`/api/display/animations/${id}/frames?box=${box}`),
};

const MESSAGES: Record<string, string> = {
  "invalid credentials": "Invalid username or password",
  "too many requests": "Too many attempts. Try again in a minute",
  "pc already on": "Workstation is already online",
  "wake already in progress": "Workstation is already booting",
  "pc is not on": "Workstation is not online",
  "pc-agent unreachable": "Workstation agent is unreachable",
  "keep at least one profile": "Keep at least one screen",
  "rotate at most every 5 seconds": "Rotate at most every 5 seconds",
  "file is too large (max 8 MB)": "File is too large (max 8 MB)",
  "upload a GIF, PNG, WebP or JPEG": "Upload a GIF, PNG, WebP or JPEG",
  "not a supported image": "Not a supported image",
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.message] ?? `${err.message} (${err.status})`;
  return "Connection error";
}
