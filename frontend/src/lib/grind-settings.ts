// The account's 刷图 settings (account_data pref `grind.settings`): the choices its clients
// share (grind_settings_sync.py). It holds only what was chosen; the rest reads as each
// client's defaults (grind_tracker.DEFAULTS). Saved here, the clients take it within a minute.
import { useMemo } from "react";
import { useUserValue } from "./live";
import type { GrindSettings } from "../../desktop/grind";
import type { SettingsChanges } from "../../desktop/grind-settings";

export const KEY = "grind.settings";

/** grind_tracker.DEFAULTS. Only the shared ones matter here; this PC's own are placeholders. */
export const GRIND_DEFAULTS: GrindSettings = {
  enabled: true, record_frames: true, upload: true, idle_seconds: 90, end_after_seconds: 600,
  start_events: 3, start_window: 60, price_basis: "typical", notable_value: 500000,
  count_mesos_spent: true, min_upload_seconds: 300, min_record_seconds: 60, buff_warn_seconds: 3, buff_sound: true, hp_warn: true,
  auto_buff: false, auto_potion: false, hotkeys: { overlay: "Ctrl+Alt+O", pause: "Ctrl+Alt+P", end: "Ctrl+Alt+E" },
  overlay: { enabled: true, layout: "slim", theme: "dark", opacity: 0.92, scale: 1, hide_in_capture: false, stream: false,
    mouse_through: false, x: null, y: null, fields: ["time", "exp_rate", "profit", "level", "buffs", "potions", "recent"] } as GrindSettings["overlay"],
  performance: { enabled: false, exp_per_10k: 1, income_per_10k: 1, cost_per_10k: 1, per_hour: 0, other_per_10k: 0 },
};
const NESTED = ["overlay", "performance", "hotkeys"] as const;

const parse = (raw: string): Record<string, any> => {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

/** Chosen over defaults, one level deep like the clients' settings.json. */
function merged(chosen: Record<string, any>): GrindSettings {
  const out: Record<string, any> = { ...GRIND_DEFAULTS };
  for (const [key, value] of Object.entries(chosen)) {
    if (!(key in GRIND_DEFAULTS)) continue;
    if ((NESTED as readonly string[]).includes(key)) out[key] = { ...(GRIND_DEFAULTS as any)[key], ...(value && typeof value === "object" ? value : {}) };
    else if (typeof value === typeof (GRIND_DEFAULTS as any)[key]) out[key] = value;
  }
  return out as GrindSettings;
}

/** The 积分 rule while 绩效模式 is on (as the collector's pointsRule). */
export const pointsRule = (settings?: GrindSettings | null) => settings?.performance?.enabled ? settings.performance : undefined;

/** [settings, save, saved anything yet]. */
export function useAccountGrindSettings() {
  const [raw, write] = useUserValue(KEY, "{}");
  const chosen = useMemo(() => parse(raw), [raw]);
  const settings = useMemo(() => merged(chosen), [chosen]);
  const save = (changes: SettingsChanges) => {
    const next: Record<string, any> = { ...parse(raw) };
    for (const [key, value] of Object.entries(changes)) {
      if ((NESTED as readonly string[]).includes(key) && value && typeof value === "object" && !Array.isArray(value))
        next[key] = { ...(next[key] && typeof next[key] === "object" ? next[key] : {}), ...value };
      else next[key] = value;
    }
    write(JSON.stringify(next));
  };
  return [settings, save, Object.keys(chosen).length > 0] as const;
}
