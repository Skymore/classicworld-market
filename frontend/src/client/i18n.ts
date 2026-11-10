// The collector panes use `tr("中文", "English")` outside React hooks; the page language
// is the one the site already applied to <html lang>.
import { words } from "../providers";

export type Lang = "zh" | "en" | "ko";
export const language = (): Lang => {
  const code = document.documentElement.lang.toLowerCase();
  return code.startsWith("en") ? "en" : code.startsWith("ko") ? "ko" : "zh";
};
export const tr = (zh: string, en: string): string => words(language(), zh, en);
