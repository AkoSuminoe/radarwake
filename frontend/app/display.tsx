"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Animation,
  DisplayProfile,
  DisplaySettings,
  Layout,
  ProfileInput,
  ProfileOptions,
  api,
  errorText,
} from "@/lib/api";
import { OledPreview, Sample, isGifLayout } from "./oled";

const LAYOUTS: { id: Layout; name: string; desc: string }[] = [
  { id: "status", name: "Calm status", desc: "Distance, presence and PC state. No animation." },
  { id: "sonar", name: "Sonar", desc: "Range arc, optional slow sweep." },
  { id: "clock", name: "Clock", desc: "Time and date with a presence dot." },
  { id: "gif", name: "GIF", desc: "Full-screen animation." },
  { id: "gif_status", name: "GIF + distance", desc: "Square animation, reading beside it." },
  { id: "gif_corner", name: "GIF + corner", desc: "Full-screen animation, distance in a corner." },
];
const LAYOUT_NAME = Object.fromEntries(LAYOUTS.map((l) => [l.id, l.name])) as Record<Layout, string>;

const DEFAULT_OPTIONS: ProfileOptions = { contrast: 160, flip: false, sweep: 0, corner: "br", show_pc: true };

const ROTATE_CHOICES = [
  [10, "10 s"],
  [30, "30 s"],
  [60, "1 min"],
  [300, "5 min"],
  [900, "15 min"],
  [3600, "1 h"],
] as const;
const SLEEP_CHOICES = [
  [0, "Never"],
  [1, "1 min"],
  [5, "5 min"],
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 h"],
] as const;
const TIMEZONES = [
  ["GMT0BST,M3.5.0/1,M10.5.0", "London"],
  ["CET-1CEST,M3.5.0,M10.5.0/3", "Central Europe"],
  ["<+03>-3", "Istanbul"],
  ["EST5EDT,M3.2.0,M11.1.0", "New York"],
  ["PST8PDT,M3.2.0,M11.1.0", "Los Angeles"],
  ["UTC0", "UTC"],
] as const;

type Toast = (text: string, error?: boolean) => void;

export function DisplayTab({ sample, toast }: { sample: Sample; toast: Toast }) {
  const [profiles, setProfiles] = useState<DisplayProfile[]>([]);
  const [settings, setSettings] = useState<DisplaySettings | null>(null);
  const [anims, setAnims] = useState<Animation[]>([]);
  const [editing, setEditing] = useState<DisplayProfile | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s, a] = await Promise.all([api.profiles(), api.displaySettings(), api.animations()]);
      setProfiles(p);
      setSettings(s);
      setAnims(a);
    } catch (err) {
      toast(errorText(err), true);
    }
  }, [toast]);

  useEffect(() => {
    load();
    // "On screen" follows rotation and the empty-room screen
    const t = setInterval(() => api.displaySettings().then(setSettings).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, [load]);

  const animById = (id: number | null) => anims.find((a) => a.id === id) ?? null;

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast(done);
      await load();
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <div>
            <h2>Screens</h2>
            <p className="muted">What the OLED on the sensor shows. Activate one, or rotate between several below.</p>
          </div>
          <button className="btn primary sm" onClick={() => setEditing("new")}>
            New screen
          </button>
        </header>
        <div className="screens">
          {profiles.map((p) => {
            const active = settings?.active_profile_id === p.id;
            const showing = settings?.showing_profile_id === p.id;
            const rotating = !!settings?.rotate_every_s && settings.rotate_ids.includes(p.id);
            return (
              <article key={p.id} className={`screen ${showing ? "showing" : ""}`}>
                <OledPreview layout={p.layout} options={p.options} anim={animById(p.anim_id)} sample={sample} label={p.name} />
                <div className="screen-meta">
                  <div>
                    <h3>{p.name}</h3>
                    {p.name !== LAYOUT_NAME[p.layout] && <span className="muted">{LAYOUT_NAME[p.layout]}</span>}
                  </div>
                  <div className="badges">
                    {showing && <span className="badge on">On screen</span>}
                    {active && !showing && <span className="badge">Active</span>}
                    {rotating && <span className="badge">Rotation</span>}
                    {settings?.idle_profile_id === p.id && <span className="badge">Empty room</span>}
                  </div>
                </div>
                <div className="screen-actions">
                  <button
                    className="btn sm"
                    disabled={active && !settings?.rotate_every_s}
                    onClick={() => act(() => api.activateProfile(p.id), `Showing “${p.name}”`)}
                  >
                    {active && !settings?.rotate_every_s ? "Active" : "Show"}
                  </button>
                  <button className="btn sm ghost" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      act(
                        () => api.createProfile({ name: `${p.name} copy`.slice(0, 64), layout: p.layout, anim_id: p.anim_id, options: p.options }),
                        "Screen duplicated",
                      )
                    }
                  >
                    Duplicate
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {settings && <Behaviour key={JSON.stringify(settings)} settings={settings} profiles={profiles} onSave={(s) => act(() => api.saveDisplaySettings(s), "Display settings saved")} />}

      <Library anims={anims} sample={sample} reload={load} toast={toast} />

      {editing && (
        <Editor
          profile={editing === "new" ? null : editing}
          anims={anims}
          sample={sample}
          canDelete={profiles.length > 1}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const isNew = editing === "new";
            await act(
              () => (isNew ? api.createProfile(input) : api.updateProfile((editing as DisplayProfile).id, input)),
              isNew ? "Screen created" : "Screen saved",
            );
            setEditing(null);
          }}
          onDelete={async () => {
            await act(() => api.deleteProfile((editing as DisplayProfile).id), "Screen deleted");
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Behaviour({ settings, profiles, onSave }: { settings: DisplaySettings; profiles: DisplayProfile[]; onSave: (s: DisplaySettings) => void }) {
  const [s, setS] = useState(settings);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const rotateOn = s.rotate_every_s > 0;
  const tzKnown = TIMEZONES.some(([v]) => v === s.tz);

  function toggleRotate(id: number) {
    setS({ ...s, rotate_ids: s.rotate_ids.includes(id) ? s.rotate_ids.filter((x) => x !== id) : [...s.rotate_ids, id] });
  }

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Behaviour</h2>
          <p className="muted">Showing a screen by hand stops the rotation.</p>
        </div>
        <button className="btn primary sm" disabled={!dirty} onClick={() => onSave(s)}>
          Save
        </button>
      </header>
      <div className="form-grid">
        <label className="field">
          <span>Rotate screens</span>
          <select value={s.rotate_every_s} onChange={(e) => setS({ ...s, rotate_every_s: Number(e.target.value) })}>
            <option value={0}>Off</option>
            {ROTATE_CHOICES.map(([v, l]) => (
              <option key={v} value={v}>
                Every {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>When the room is empty</span>
          <select value={s.idle_profile_id ?? ""} onChange={(e) => setS({ ...s, idle_profile_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Keep the current screen</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                Show “{p.name}”
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Screen off when nobody is around</span>
          <select value={s.sleep_after_min} onChange={(e) => setS({ ...s, sleep_after_min: Number(e.target.value) })}>
            {SLEEP_CHOICES.map(([v, l]) => (
              <option key={v} value={v}>
                {v ? `After ${l}` : l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Clock time zone</span>
          <select value={tzKnown ? s.tz : "custom"} onChange={(e) => e.target.value !== "custom" && setS({ ...s, tz: e.target.value })}>
            {TIMEZONES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            {!tzKnown && <option value="custom">{s.tz}</option>}
          </select>
        </label>
      </div>
      {rotateOn && (
        <div className="field">
          <span>Screens in the rotation</span>
          <div className="chips">
            {profiles.map((p) => (
              <label key={p.id} className={`chip-toggle ${s.rotate_ids.includes(p.id) ? "on" : ""}`}>
                <input type="checkbox" checked={s.rotate_ids.includes(p.id)} onChange={() => toggleRotate(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
          {s.rotate_ids.length < 2 && <p className="note">Pick at least two screens.</p>}
        </div>
      )}
    </section>
  );
}

function Editor({
  profile,
  anims,
  sample,
  canDelete,
  onClose,
  onSave,
  onDelete,
}: {
  profile: DisplayProfile | null;
  anims: Animation[];
  sample: Sample;
  canDelete: boolean;
  onClose: () => void;
  onSave: (p: ProfileInput) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(profile?.name ?? "New screen");
  const [layout, setLayout] = useState<Layout>(profile?.layout ?? "gif_status");
  const [animId, setAnimId] = useState<number | null>(profile?.anim_id ?? anims[0]?.id ?? null);
  const [opts, setOpts] = useState<ProfileOptions>({ ...DEFAULT_OPTIONS, ...profile?.options });
  const [busy, setBusy] = useState(false);
  const anim = anims.find((a) => a.id === animId) ?? null;
  const gif = isGifLayout(layout);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function save() {
    setBusy(true);
    await onSave({ name: name.trim() || "Screen", layout, anim_id: gif ? animId : null, options: opts });
    setBusy(false);
  }

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onCancel={onClose}>
      <header className="card-head">
        <h2>{profile ? "Edit screen" : "New screen"}</h2>
        <button className="btn sm ghost" onClick={onClose} aria-label="Close">
          Close
        </button>
      </header>

      <OledPreview layout={layout} options={opts} anim={gif ? anim : null} sample={sample} />

      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="field">
        <span>Layout</span>
        <div className="layouts">
          {LAYOUTS.map((l) => (
            <button key={l.id} type="button" className={`layout ${layout === l.id ? "on" : ""}`} onClick={() => setLayout(l.id)}>
              <strong>{l.name}</strong>
              <span>{l.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {gif && (
        <label className="field">
          <span>Animation</span>
          {anims.length ? (
            <select value={animId ?? ""} onChange={(e) => setAnimId(e.target.value ? Number(e.target.value) : null)}>
              {anims.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.frames} frames
                </option>
              ))}
            </select>
          ) : (
            <p className="note">Upload a GIF in the library first.</p>
          )}
        </label>
      )}

      <div className="form-grid">
        <label className="field">
          <span>Brightness · {Math.round((opts.contrast / 255) * 100)}%</span>
          <input type="range" min={0} max={255} value={opts.contrast} onChange={(e) => setOpts({ ...opts, contrast: Number(e.target.value) })} />
        </label>
        {layout === "sonar" && (
          <label className="field">
            <span>Sweep</span>
            <select value={opts.sweep} onChange={(e) => setOpts({ ...opts, sweep: Number(e.target.value) })}>
              <option value={0}>Off</option>
              <option value={1}>Slow</option>
              <option value={2}>Medium</option>
              <option value={3}>Fast</option>
            </select>
          </label>
        )}
        {layout === "gif_corner" && (
          <label className="field">
            <span>Corner</span>
            <select value={opts.corner} onChange={(e) => setOpts({ ...opts, corner: e.target.value as ProfileOptions["corner"] })}>
              <option value="tl">Top left</option>
              <option value="tr">Top right</option>
              <option value="bl">Bottom left</option>
              <option value="br">Bottom right</option>
            </select>
          </label>
        )}
      </div>
      <div className="checks">
        {layout !== "clock" && layout !== "gif" && layout !== "gif_corner" && (
          <label className="check">
            <input type="checkbox" checked={opts.show_pc} onChange={(e) => setOpts({ ...opts, show_pc: e.target.checked })} />
            Show PC state
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={opts.flip} onChange={(e) => setOpts({ ...opts, flip: e.target.checked })} />
          Rotate 180°
        </label>
      </div>

      <footer className="sheet-foot">
        {profile && canDelete ? (
          <button className="btn danger sm" disabled={busy} onClick={() => window.confirm(`Delete “${profile.name}”?`) && onDelete()}>
            Delete
          </button>
        ) : (
          <span />
        )}
        <button className="btn primary" disabled={busy || (gif && !animId)} onClick={save}>
          {profile ? "Save" : "Create"}
        </button>
      </footer>
    </dialog>
  );
}

function Library({ anims, sample, reload, toast }: { anims: Animation[]; sample: Sample; reload: () => Promise<void>; toast: Toast }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setUploading(true);
    for (const f of files) {
      try {
        await api.uploadAnimation(f.name.replace(/\.[^.]+$/, "").slice(0, 64) || "animation", f);
      } catch (err) {
        toast(`${f.name}: ${errorText(err)}`, true);
      }
    }
    setUploading(false);
    await reload();
  }

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>GIF library</h2>
          <p className="muted">Converted to 1-bit for the 128×64 panel. Stored on your server only.</p>
        </div>
        <button className="btn primary sm" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? "Uploading…" : "Upload"}
        </button>
        <input ref={input} type="file" accept="image/gif,image/png,image/webp,image/jpeg" multiple hidden onChange={upload} />
      </header>
      {anims.length === 0 ? (
        <p className="empty">No animations yet. Upload a GIF (up to 8 MB); transparent backgrounds work best.</p>
      ) : (
        <div className="library">
          {anims.map((a) => (
            <LibraryItem key={a.id} anim={a} sample={sample} reload={reload} toast={toast} />
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryItem({ anim, sample, reload, toast }: { anim: Animation; sample: Sample; reload: () => Promise<void>; toast: Toast }) {
  const [a, setA] = useState(anim);
  const [name, setName] = useState(anim.name);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setA(anim), [anim]);

  function patch(p: Partial<Animation>, delay = 0) {
    setA({ ...a, ...p });
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        setA(await api.updateAnimation(a.id, p));
      } catch (err) {
        toast(errorText(err), true);
      }
    }, delay);
  }

  // level < 128 brightens, > 128 darkens (server side); the slider shows it as brightness
  const brightness = Math.round(((128 - a.level) / 128) * 100);

  return (
    <article className="item">
      <div className="item-media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/display/animations/${a.id}/original`} alt="" loading="lazy" />
        <OledPreview layout="gif" options={DEFAULT_OPTIONS} anim={a} sample={sample} label={`${a.name}, 1-bit`} />
      </div>
      <div className="item-body">
        <input
          className="item-name"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== a.name && patch({ name: name.trim() })}
          aria-label="Name"
        />
        <span className="muted mono">{a.frames} frames</span>
        <div className="segmented" role="group" aria-label="Fit">
          <button className={a.fit === "contain" ? "on" : ""} onClick={() => patch({ fit: "contain" })}>
            Fit
          </button>
          <button className={a.fit === "cover" ? "on" : ""} onClick={() => patch({ fit: "cover" })}>
            Fill
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Shading">
          <button className={a.dither ? "on" : ""} onClick={() => patch({ dither: true })}>
            Dither
          </button>
          <button className={!a.dither ? "on" : ""} onClick={() => patch({ dither: false })}>
            Solid
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={a.invert} onChange={(e) => patch({ invert: e.target.checked })} />
          Invert (for light backgrounds)
        </label>
        <label className="field">
          <span>Brightness {brightness > 0 ? `+${brightness}` : brightness}</span>
          <input type="range" min={-100} max={100} value={brightness} onChange={(e) => patch({ level: Math.min(255, Math.max(0, Math.round(128 - (Number(e.target.value) / 100) * 128))) }, 400)} />
        </label>
        <button
          className="btn sm danger"
          onClick={async () => {
            if (!window.confirm(`Delete “${a.name}”? Screens using it will show “NO GIF”.`)) return;
            try {
              await api.deleteAnimation(a.id);
              await reload();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Delete
        </button>
      </div>
    </article>
  );
}
