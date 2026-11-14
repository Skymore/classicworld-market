// One way to show an item anywhere on the site: its icon and name, linking to
// the item page. Use these instead of hand-built `/item/<id>` links or bare
// names, so every place an item appears can be opened.
import type React from "react";
import type { ReactNode } from "react";
import { readPeriod } from "/web/js/lib/period.js?v=20261022-regressions-1";
import { embeddedHost, embeddedLocal } from "../lib/embed";
import { Slot } from "./shared";
import { SiteLink } from "./shell";

const SITE = "https://mxd.ruit.me";

export const itemIconUrl = (id: number) => `https://mxdgcw.dvg.cn/dbsource/icon/item/${id}.png`;

/** The item page, over the period the visitor picked. */
export const itemPath = (id: number, variant?: number | null) =>
  `/item/${id}?hours=${readPeriod()}${variant ? `&variant=${variant}` : ""}`;

/**
 * A link to the item page. Clicks do not reach a clickable row around it. A
 * collector tab of its own (摆摊) has no site navigation to come back with,
 * so there the public item page opens in a new window.
 */
export function ItemLink({
  id,
  variant,
  className,
  children,
}: {
  id: number;
  variant?: number | null;
  className?: string;
  children: ReactNode;
}) {
  const props = {
    className: "item-link" + (className ? " " + className : ""),
    "data-item-link": id,
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
  };
  if (embeddedHost || embeddedLocal)
    return (
      <a href={SITE + itemPath(id, variant)} target="_blank" rel="noopener" {...props}>
        {children}
      </a>
    );
  return (
    <SiteLink href={itemPath(id, variant)} {...props}>
      {children}
    </SiteLink>
  );
}

/** Item strip: icon and name in one link; `children` follow the name. */
export function ItemTag({
  id,
  name,
  icon,
  size = 24,
  className,
  children,
}: {
  id: number;
  name: ReactNode;
  icon?: string | null;
  size?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <ItemLink id={id} className={"item-tag" + (className ? " " + className : "")}>
      <Slot url={icon || itemIconUrl(id)} size={size} />
      <span className="item-tag-name">{name}</span>
      {children}
    </ItemLink>
  );
}
