import type { MediaDescriptor } from "./sync-protocol";

export type CatalogFilm = MediaDescriptor & {
  id: string;
  kind: "catalog";
  year: number;
  durationLabel: string;
  blurb: string;
  src: string;
  fallbackSrc?: string;
  poster: string;
  fallbackPoster?: string;
  credit: string;
  license: string;
};

/** Free Creative Commons / open-movie catalogue — no paid hosting required. */
export const CATALOG: CatalogFilm[] = [
  {
    id: "big-buck-bunny",
    kind: "catalog",
    title: "Big Buck Bunny",
    year: 2008,
    durationLabel: "~10 min",
    blurb: "A giant rabbit's day of revenge — Blender Foundation open movie.",
    src: "https://www.w3schools.com/html/mov_bbb.mp4",
    fallbackSrc: "/samples/bbb.mp4",
    poster: "https://peach.blender.org/wp-content/uploads/poster_bunny_small.jpg",
    fallbackPoster: "/samples/bbb-poster.jpg",
    credit: "Blender Foundation / Peach Open Movie Project",
    license: "CC BY 3.0",
  },
  {
    id: "elephants-dream",
    kind: "catalog",
    title: "Elephants Dream",
    year: 2006,
    durationLabel: "~11 min",
    blurb: "The first open movie from the Orange project — surreal and short.",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    fallbackSrc: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    poster: "https://orange.blender.org/wp-content/themes/orange/images/common/ed_header.jpg",
    fallbackPoster: "/samples/bbb-poster.jpg",
    credit: "Blender Foundation / Orange Open Movie Project",
    license: "CC BY 3.0",
  },
  {
    id: "sintel",
    kind: "catalog",
    title: "Sintel trailer",
    year: 2010,
    durationLabel: "short",
    blurb: "A durable public MP4 sample of the Durian open movie aesthetic.",
    src: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    fallbackSrc: "https://www.w3schools.com/html/mov_bbb.mp4",
    poster: "https://durian.blender.org/wp-content/uploads/2010/06/sintel_poster.jpg",
    fallbackPoster: "/samples/bbb-poster.jpg",
    credit: "MDN CC0 sample / Blender Durian poster",
    license: "CC0 / CC BY 3.0",
  },
  {
    id: "tears-of-steel",
    kind: "catalog",
    title: "Tears of Steel (sample)",
    year: 2012,
    durationLabel: "sample",
    blurb: "Mango open movie — using a free public sample clip for reliable playback.",
    src: "https://www.w3schools.com/html/mov_bbb.mp4",
    fallbackSrc: "/samples/bbb.mp4",
    poster: "https://mango.blender.org/wp-content/uploads/2012/05/tos-poster-small.jpg",
    credit: "Blender Foundation / Mango Open Movie Project",
    license: "CC BY 3.0",
  },
];

/** @deprecated use CATALOG[0] — kept for older imports */
export const SAMPLE_FILM = CATALOG[0];

const WORDS = [
  "dusk",
  "ember",
  "velvet",
  "harbor",
  "lantern",
  "cedar",
  "mirage",
  "opal",
  "willow",
  "cobalt",
  "amber",
  "sienna",
  "nova",
  "plume",
  "folio",
  "atlas",
];

export function createRoomCode(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = Math.floor(10 + Math.random() * 89);
  return `${word}-${num}`;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
}

export function getCatalogFilm(id: string): CatalogFilm | undefined {
  return CATALOG.find((f) => f.id === id);
}

export function isDirectMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return /\.(mp4|webm|ogg|mov)(\?|$)/i.test(u.pathname) || /gtv-videos-bucket|w3schools|mozilla\.net|blob:/i.test(url);
  } catch {
    return false;
  }
}
