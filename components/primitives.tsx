import Link from "next/link";
import { Reveal } from "./Reveal";
import { navItems } from "./nav-items";

export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  flush = false,
}: {
  id?: string;
  eyebrow?: string;
  title?: string;
  lede?: string;
  children?: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section id={id} className={`section${flush ? " section--flush" : ""}`}>
      <div className="shell">
        {(eyebrow || title || lede) && (
          <Reveal as="header" className="section__head">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h2 className="section__title">{title}</h2>}
            {lede && <p className="lede">{lede}</p>}
          </Reveal>
        )}
        {children && <Reveal delay={80}>{children}</Reveal>}
      </div>
    </section>
  );
}

export function PageHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede: string;
}) {
  return (
    <div className="shell">
      <Reveal className="pagehead">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
      </Reveal>
    </div>
  );
}

export function Code({ label, children }: { label?: string; children: string }) {
  return (
    <div className="code">
      {label && <div className="code__label">{label}</div>}
      <pre>{children}</pre>
    </div>
  );
}

export function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KeyValues({ items }: { items: { k: string; v: React.ReactNode }[] }) {
  return (
    <div className="kv">
      {items.map((item) => (
        <div className="kv__row" key={item.k}>
          <div className="kv__k">{item.k}</div>
          <div className="kv__v">{item.v}</div>
        </div>
      ))}
    </div>
  );
}

export function Flow({ steps }: { steps: { title: string; body: React.ReactNode }[] }) {
  return (
    <div className="flow">
      {steps.map((step, i) => (
        <div className="flow__step" key={step.title}>
          <div className="flow__num" aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </div>
          <div>
            <h3 className="flow__title">{step.title}</h3>
            <p className="flow__body">{step.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Tiles({ items }: { items: { title: string; body: React.ReactNode }[] }) {
  return (
    <div className="grid grid--3">
      {items.map((item, i) => (
        <div className="tile" key={item.title}>
          <span className="tile__index">{String(i + 1).padStart(2, "0")}</span>
          <h3 className="tile__title">{item.title}</h3>
          <p className="tile__body">{item.body}</p>
        </div>
      ))}
    </div>
  );
}

export function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export function Callout({ children }: { children: React.ReactNode }) {
  return <p className="callout">{children}</p>;
}

export function Pager({ current }: { current: string }) {
  const index = navItems.findIndex((item) => item.href === current);
  const prev = index > 0 ? navItems[index - 1] : null;
  const next = index >= 0 && index < navItems.length - 1 ? navItems[index + 1] : null;

  return (
    <div className="shell">
      <div className="pager">
        {prev ? (
          <Link className="pager__link" href={prev.href}>
            <small>Previous</small>
            {prev.label} — {prev.blurb}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link className="pager__link" href={next.href} style={{ textAlign: "right" }}>
            <small>Next</small>
            {next.label} — {next.blurb}
          </Link>
        )}
      </div>
    </div>
  );
}
