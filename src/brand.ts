// This instance's logo, from config/logo.svg (bundled at build time).
// No file there → the built-in check-mark logo. It's also used as the browser tab icon.
const found = import.meta.glob('../config/logo.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
export const LOGO_URL: string | null = Object.values(found)[0] ?? null;

/** Points the tab icon at the configured logo. */
export function applyFavicon() {
  if (!LOGO_URL) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = LOGO_URL;
}
