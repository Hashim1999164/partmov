/** Free, redistributable sample film used by the live demo room. */
export const SAMPLE_FILM = {
  id: "big-buck-bunny",
  title: "Big Buck Bunny",
  year: 2008,
  durationLabel: "10 min",
  blurb:
    "An open movie by the Blender Foundation — free to watch, share, and remix under Creative Commons.",
  /**
   * Progressive MP4 — Blender Foundation short (CC BY 3.0).
   * Primary URL is a widely mirrored public copy; /samples is used locally when present.
   */
  src: "https://www.w3schools.com/html/mov_bbb.mp4",
  fallbackSrc: "/samples/bbb.mp4",
  poster: "https://peach.blender.org/wp-content/uploads/poster_bunny_small.jpg",
  fallbackPoster: "/samples/bbb-poster.jpg",
  credit: "Blender Foundation / Peach Open Movie Project",
  license: "CC BY 3.0",
} as const;

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

/** Short, speakable room codes like dusk-42. */
export function createRoomCode(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = Math.floor(10 + Math.random() * 89);
  return `${word}-${num}`;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
}
