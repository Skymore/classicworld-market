// One way to show a game thing anywhere on the site: item, monster, map, NPC
// or skill. `EntityRow` is a whole clickable row (icon, name, details, value),
// `EntityTag` the same icon and name inline, `EntityLink` just the link.
// Use these instead of hand-built `/item/<id>` links or bare names, so
// everything shown can be opened and every list looks alike (`.drow`, base.css).
// The collector window (frontend/desktop) builds this file too, without the
// site's router or period setting: the website registers both in main.tsx
// with setSiteLinks, and anywhere else links open the public site.
import type React from "react";
import type { ComponentType, ReactNode } from "react";
import { embeddedHost, embeddedLocal } from "../lib/embed";

export type EntityKind = "item" | "mob" | "map" | "npc" | "skill";

const SITE = "https://mxd.ruit.me";
const ICONS = "/web/img/grind-icons";

type Anchor = ComponentType<React.ComponentProps<"a"> & { href: string }>;
let site: { Link: Anchor; period: () => string } | null = null;
/** The website's in-app link and the visitor's price period (main.tsx). */
export function setSiteLinks(Link: Anchor, period: () => string) {
  site = { Link, period };
}

import { itemIconUrl } from './client-icons';
export { itemIconUrl };

/** The item page, over the period the visitor picked. */
export const itemPath = (id: number, variant?: number | null) =>
  `/item/${id}?hours=${site?.period() ?? "72"}${variant ? `&variant=${variant}` : ""}`;

/** The page of a thing, or null when it has none (skills). */
export function entityPath(kind: EntityKind, id: number, variant?: number | null): string | null {
  switch (kind) {
    case "item":
      return itemPath(id, variant);
    case "mob":
    case "map":
    case "npc":
      return `/${kind}/${id}`;
    default:
      return null;
  }
}

/** A default icon; maps and NPCs have none and get a glyph. */
export function entityIcon(kind: EntityKind, id: number): string | null {
  switch (kind) {
    case "item":
      return itemIconUrl(id);
    case "mob":
      return `${ICONS}/monsters/${id}.png`;
    case "skill":
      return `${ICONS}/skills/${id}.png`;
    default:
      return null;
  }
}

/**
 * A link to the thing's page. Clicks do not reach a clickable row around it.
 * A collector tab of its own (摆摊) has no site navigation to come back
 * with, so there the public page opens in a new window. Things without a
 * page render as a plain span with the same class.
 */
export function EntityLink({
  kind,
  id,
  variant,
  className,
  title,
  style,
  children,
}: {
  kind: EntityKind;
  id: number;
  variant?: number | null;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const path = id ? entityPath(kind, id, variant) : null;
  const props = {
    className: (path ? "entity-link" : "entity-plain") + (className ? " " + className : ""),
    title,
    style,
    "data-entity": kind,
    "data-entity-id": id,
    ...(kind === "item" ? { "data-item-link": id } : {}),
  };
  if (!path) return <span {...props}>{children}</span>;
  const stop = (event: React.MouseEvent) => event.stopPropagation();
  if (!site || embeddedHost || embeddedLocal)
    return (
      <a href={SITE + path} target="_blank" rel="noopener" onClick={stop} {...props}>
        {children}
      </a>
    );
  const { Link } = site;
  return (
    <Link href={path} onClick={stop} {...props}>
      {children}
    </Link>
  );
}

function Glyph({ kind }: { kind: EntityKind }) {
  return (
    <span className="glyph" aria-hidden="true">
      {kind === "map" ? "图" : kind === "npc" ? "N" : "?"}
    </span>
  );
}

/** The icon of a row or tag; hidden when the picture is missing. */
export function EntityIcon({ kind, id, icon }: { kind: EntityKind; id: number; icon?: string | null }) {
  const url = icon === undefined ? entityIcon(kind, id) : icon;
  if (!url) return kind === "map" || kind === "npc" ? <Glyph kind={kind} /> : <span className="eicon" aria-hidden="true" />;
  return (
    <span className="eicon" aria-hidden="true">
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
        }}
      />
    </span>
  );
}

/**
 * A whole clickable row: icon, name (with an inline `note`), an optional
 * second line `sub`, and `value` at the right edge.
 */
export function EntityRow({
  kind,
  id,
  name,
  icon,
  note,
  sub,
  value,
  variant,
  className,
  title,
}: {
  kind: EntityKind;
  id: number;
  name?: ReactNode;
  icon?: string | null;
  note?: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  variant?: number | null;
  className?: string;
  title?: string;
}) {
  return (
    <EntityLink kind={kind} id={id} variant={variant} title={title} className={"drow" + (className ? " " + className : "")}>
      <EntityIcon kind={kind} id={id} icon={icon} />
      <span className="t">
        <b>{name || `#${id}`}</b>
        {note != null && note !== false && <small className="n">{note}</small>}
        {sub != null && sub !== false && <span className="s">{sub}</span>}
      </span>
      {value != null && value !== false ? <span className="r">{value}</span> : <span />}
    </EntityLink>
  );
}

/** Icon and name inline, in one link; `children` follow the name. */
export function EntityTag({
  kind,
  id,
  name,
  icon,
  className,
  children,
}: {
  kind: EntityKind;
  id: number;
  name: ReactNode;
  icon?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <EntityLink kind={kind} id={id} className={"entity-tag" + (className ? " " + className : "")}>
      <EntityIcon kind={kind} id={id} icon={icon} />
      <span className="entity-tag-name">{name}</span>
      {children}
    </EntityLink>
  );
}
