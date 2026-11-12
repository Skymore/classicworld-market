// The collector window's language: the Windows display language (WebView2's
// navigator.languages) unless the player chose one (scanner state `language`).
// Korean comes from the site's dictionary, keyed by the Chinese text.
// @ts-expect-error The website's plain JS module has no declaration file.
import { koText, useKorean } from '../../web/js/lib/ko-text.js';

export type Lang = 'zh' | 'en' | 'ko';
export type LangChoice = Lang | 'system';
/** The client windows bundle the dictionary (the website loads its own on demand). */
export const installKorean = (dictionary: unknown) => useKorean(dictionary);

/** The system language; Chinese when Windows names none of zh / en / ko first. */
export function systemLanguage(): Lang {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags.filter(Boolean)) {
    const code = tag.toLowerCase();
    if (code.startsWith('zh')) return 'zh';
    if (code.startsWith('ko')) return 'ko';
    if (code.startsWith('en')) return 'en';
  }
  return tags.filter(Boolean).length ? 'en' : 'zh';
}

let current: Lang = systemLanguage();
export const language = () => current;

/** Applies a choice; returns the language now in use. */
export function applyLanguage(choice: LangChoice | undefined): Lang {
  current = !choice || choice === 'system' ? systemLanguage() : choice;
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : current;
  // Shared sweep labels read this (src/lib/sweep-labels.ts).
  (globalThis as any).cwmKorean = current === 'ko' ? koText : null;
  return current;
}

/** The language of tr() only, without touching the page: the website shows the
 * live view inside its own pages, whose language and Korean hook it manages itself. */
export function setTextLanguage(lang: Lang) {
  current = lang;
}

/** `tr("中文", "English")`: the text for the window's language (Korean falls back to English). */
export const tr = (zh: string, en: string): string =>
  current === 'zh' ? zh : current === 'en' ? en : koText(zh, en) ?? en;

/** The `Intl` locale of the window's language. */
export const locale = () => (current === 'en' ? 'en-US' : current === 'ko' ? 'ko-KR' : 'zh-CN');
