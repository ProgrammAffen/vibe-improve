export type Language = 'zh-CN' | 'en';

export function readLanguage(): Language {
  const native = (window as unknown as {vibeNative?: {preferences?: {language?: unknown}}}).vibeNative;
  if (native?.preferences?.language === 'en' || native?.preferences?.language === 'zh-CN') return native.preferences.language;
  try { return localStorage.getItem('vibe-improve.language') === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}

export function translate(language: Language, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}

export function dateLabel(value: unknown, language: Language): string {
  if (!value || typeof value !== 'string') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(language, {year: 'numeric', month: 'short', day: 'numeric'}).format(date);
}
