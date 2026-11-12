// The share card: drawn on a canvas (no external images, so it can always be
// copied or saved) in the adventure status-bar look.
import { big, clock, when, type GrindRun, type Words } from "../components/grind-run";

export interface CardOptions { url: string; t: Words; showName: boolean; showProfit: boolean; english?: boolean }

const W = 640, H = 360;

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = "#121722";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#05070a";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 1, y + h + 0.5);
  ctx.lineTo(x + w - 1, y + h + 0.5);
  ctx.stroke();
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, color: string, weight = 600, align: CanvasTextAlign = "left") {
  ctx.font = `${weight} ${size}px "Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif`;
  ctx.textAlign = align;
  ctx.fillStyle = "#000";
  ctx.fillText(value, x, y + 1.5);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

/** Draws the card at 2x into `canvas` (sized here) and returns it. */
export function drawCard(canvas: HTMLCanvasElement, run: GrindRun, options: CardOptions) {
  const { t, showName, showProfit, english = false } = options;
  const scale = 2;
  canvas.width = W * scale;
  canvas.height = H * scale;
  canvas.style.aspectRatio = `${W} / ${H}`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const frame = ctx.createLinearGradient(0, 0, 0, H);
  frame.addColorStop(0, "#5e6676");
  frame.addColorStop(0.4, "#343a48");
  frame.addColorStop(1, "#22262f");
  ctx.fillStyle = frame;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.4)";
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  ctx.strokeStyle = "#0d1016";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, W, H);

  const level = run.level ?? run.character?.level;
  const who = showName && run.character?.name ? run.character.name : (run.job_name ? t(`一位${run.job_name}`, `A ${run.job_name}`) : t("冒险家", "Adventurer"));
  text(ctx, `Lv.${level ?? "?"}`, 24, 42, 22, "#ffd84a", 800);
  ctx.font = `800 22px "Microsoft YaHei UI",sans-serif`;
  const lvWidth = ctx.measureText(`Lv.${level ?? "?"}`).width;
  text(ctx, who, 24 + lvWidth + 10, 42, 22, "#ffffff", 700);
  text(ctx, run.job_name || "", W - 24, 42, 16, "#cfd6e4", 600, "right");
  const minutes = Math.round(run.active_seconds / 60);
  const length = minutes >= 60 ? t(`${Math.floor(minutes / 60)}小时${minutes % 60}分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`) : t(`${minutes}分钟`, `${minutes} min`);
  text(ctx, `${run.map_name || t("冒险岛", "MapleStory")} · ${length}`, 24, 78, 18, "#e8edf5", 600);
  text(ctx, when(run.started_at), W - 24, 78, 13, "#aab3c4", 500, "right");

  const tiles: [string, string, string][] = [
    [t("经验/时", "EXP/h"), big(run.exp_per_hour, english), "#ffffff"],
    showProfit ? [t("收益/时", "Profit/h"), big(run.net_per_hour, english), "#ffd84a"] : [t("经验", "EXP"), big(run.exp, english), "#ffffff"],
    [t("击杀", "Kills"), big(run.kills, english), "#ffffff"],
    run.average_dps != null ? ["DPS", big(run.average_dps, english), "#ffffff"] : [t("时长", "Time"), clock(run.active_seconds), "#ffffff"],
  ];
  const tileW = (W - 48 - 3 * 10) / 4;
  tiles.forEach(([label, value, color], i) => {
    const x = 24 + i * (tileW + 10);
    panel(ctx, x, 98, tileW, 78);
    text(ctx, label, x + 12, 122, 13, "#aab3c4", 500);
    text(ctx, value, x + 12, 160, i < 2 ? 30 : 26, color, 800);
  });

  // EXP bar for the run: share of this level gained, when known.
  const line = run.timeline;
  panel(ctx, 24, 192, W - 48, 70);
  if (line && line.exp.length > 1) {
    const rates = line.exp, max = Math.max(...rates, 1);
    const step = (W - 72) / (rates.length - 1);
    ctx.beginPath();
    rates.forEach((v, i) => {
      const x = 36 + i * step, y = 254 - (v / max) * 34;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = "#b9e530";
    ctx.lineWidth = 2;
    ctx.stroke();
    text(ctx, t("整场经验走势", "EXP over the run"), 36, 212, 12, "#aab3c4", 500);
  } else {
    text(ctx, t(`累计经验 ${big(run.exp, english)}`, `${big(run.exp, english)} EXP`), 36, 234, 18, "#e8edf5", 600);
  }

  const best = (run.loot?.length ? run.loot : run.drops || []).slice(0, 3)
    .map((row) => `${row.name || "#" + row.item_id} ×${big(row.quantity, english)}`).join(" · ");
  if (best) text(ctx, `${t("掉落", "Loot")}  ${best}`, 24, 288, 14, "#e8edf5", 500);

  ctx.fillStyle = "rgba(255,255,255,.16)";
  ctx.fillRect(24, 304, W - 48, 1);
  text(ctx, t("枫叶市集客户端 · 自动记录经验、掉落和收益", "Maple Market client · automatic EXP, loot and profit"), 24, 334, 14, "#ffffff", 600);
  text(ctx, options.url.replace(/^https?:\/\//, ""), W - 24, 334, 15, "#ffd84a", 700, "right");
  return canvas;
}

export async function cardBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas"))), "image/png"));
}

/** Copies the card image; false when the browser cannot (then offer saving). */
export async function copyCard(canvas: HTMLCanvasElement) {
  try {
    const blob = await cardBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function saveCard(canvas: HTMLCanvasElement, name: string) {
  const blob = await cardBlob(canvas);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
