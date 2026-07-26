export type NavItem = {
  href: string;
  label: string;
  /** Short description used by the sequential pager at the bottom of each page. */
  blurb: string;
};

export const navItems: NavItem[] = [
  { href: "/", label: "Overview", blurb: "The product in one page" },
  { href: "/watch", label: "Watch", blurb: "Live demo room with a sample film" },
  { href: "/product", label: "Product", blurb: "Vision, flows, room experience" },
  { href: "/architecture", label: "Architecture", blurb: "Services, stack, media pipeline" },
  { href: "/sync", label: "Sync", blurb: "Canonical clock and drift correction" },
  { href: "/data", label: "Data model", blurb: "Entities and PostgreSQL schema" },
  { href: "/api-spec", label: "API", blurb: "REST surface and realtime events" },
  { href: "/security", label: "Privacy", blurb: "Access control and data minimisation" },
  { href: "/ops", label: "Operations", blurb: "Observability, backups, scaling" },
  { href: "/mvp", label: "Roadmap", blurb: "MVP scope and what comes next" },
];
