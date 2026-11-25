// Sharing one run, the same in the client's history and the site's 我的记录: the card
// preview, what to show, the link (made as soon as the panel opens and again after a change),
// the share page, and the card image to copy or save.
import { useEffect, useRef, useState } from "react";
import { copyCard, drawCard, saveCard } from "../lib/grind-card";
import type { GrindRun, Words } from "./grind-run";
import "./grind-share.css";

export interface ShareLink { url: string; code: string }

export function GrindShare({ run, t, english, create, openPage, file, button }: {
  run: GrindRun; t: Words; english: boolean;
  /** Makes (or reuses) the link for these options. */
  create(options: { show_name: boolean; show_profit: boolean }): Promise<ShareLink>;
  /** Opens the share page: a site link, or the default browser from the client. */
  openPage(link: ShareLink): void;
  /** The saved image's file name. */
  file: string;
  /** The host's button class ("btn" on the site, "ui-btn" in the client). */
  button: string;
}) {
  const [showName, setShowName] = useState(true), [showProfit, setShowProfit] = useState(true);
  const [link, setLink] = useState<ShareLink | null>(null), [failed, setFailed] = useState(false), [note, setNote] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null), panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }, []);
  useEffect(() => {
    let alive = true;
    setLink(null); setFailed(false);
    create({ show_name: showName, show_profit: showProfit })
      .then(made => { if (alive) setLink(made); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [showName, showProfit]);   // eslint-disable-line react-hooks/exhaustive-deps -- one link per option set
  useEffect(() => {
    if (canvas.current) drawCard(canvas.current, run, { url: link?.url || `${location.host}/g/…`, t, showName, showProfit, english });
  }, [run, link, showName, showProfit, t, english]);
  const flash = (text: string) => { setNote(text); setTimeout(() => setNote(""), 2000); };
  return <section ref={panel} className="gs-panel" aria-label={t("分享", "Share")}>
    <canvas ref={canvas} className="gs-canvas" aria-label={t("分享卡片预览", "Share card preview")} />
    <div className="gs-side">
      <label><input type="checkbox" checked={showName} onChange={e => setShowName(e.target.checked)} /> {t("显示角色名", "Show character name")}</label>
      <label><input type="checkbox" checked={showProfit} onChange={e => setShowProfit(e.target.checked)} /> {t("显示收益", "Show profit")}</label>
      <input className="gs-url" readOnly aria-label={t("分享链接", "Share link")} onFocus={e => e.currentTarget.select()}
        value={link?.url || (failed ? t("暂时生成不了链接，请稍后再试", "Couldn't create the link; try again later") : t("正在生成链接…", "Creating link…"))} />
      <button className={button + " primary"} disabled={!link} onClick={async () => {
        try { await navigator.clipboard.writeText(link!.url); flash(t("链接已复制", "Link copied")); } catch { flash(t("请手动复制链接", "Copy the link by hand")); }
      }}>{t("复制链接", "Copy link")}</button>
      <button className={button} disabled={!link} onClick={() => link && openPage(link)}>{t("打开分享页", "Open share page")}</button>
      <button className={button} onClick={async () => flash(canvas.current && await copyCard(canvas.current) ? t("图片已复制", "Image copied") : t("无法复制，请保存图片", "Can't copy; save the image instead"))}>
        {t("复制图片", "Copy image")}</button>
      <button className={button} onClick={() => canvas.current && saveCard(canvas.current, file)}>{t("保存图片", "Save image")}</button>
      <p className="gs-note" role="status">{note}</p>
    </div>
  </section>;
}
