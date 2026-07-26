/** Lightweight co-browse presets. Many streaming sites block iframes (X-Frame-Options). */

export type BrowsePreset = {
  id: string;
  label: string;
  url: string;
  note?: string;
};

export const BROWSE_PRESETS: BrowsePreset[] = [
  {
    id: "netflix",
    label: "Netflix",
    url: "https://www.netflix.com/",
    note: "Blocks embedding — both of you open the same tab; use this as a shared start point.",
  },
  {
    id: "youtube",
    label: "YouTube",
    url: "https://www.youtube.com/",
    note: "Home page may be limited in-frame; video embeds often work better.",
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    url: "https://en.wikipedia.org/",
  },
  {
    id: "example",
    label: "Example.com",
    url: "https://example.com/",
    note: "Reliable iframe demo.",
  },
];

export function normalizeBrowseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function browseTitleFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || "Website";
  } catch {
    return "Website";
  }
}

export function siteLikelyBlocksEmbed(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return [
      "netflix.com",
      "disneyplus.com",
      "hulu.com",
      "max.com",
      "primevideo.com",
      "amazon.com",
      "spotify.com",
      "twitch.tv",
      "instagram.com",
      "facebook.com",
      "x.com",
      "twitter.com",
    ].some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
