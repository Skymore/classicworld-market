// Items through the shared entity components (entity-ref.tsx).
import type { ReactNode } from "react";
import { EntityLink, EntityTag } from "./entity-ref";

export { itemIconUrl, itemPath } from "./entity-ref";

/** A link to the item page. */
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
  return (
    <EntityLink kind="item" id={id} variant={variant} className={"item-link" + (className ? " " + className : "")}>
      {children}
    </EntityLink>
  );
}

/** Item strip: icon and name in one link; `children` follow the name. */
export function ItemTag({
  id,
  name,
  icon,
  className,
  children,
}: {
  id: number;
  name: ReactNode;
  icon?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <EntityTag kind="item" id={id} name={name} icon={icon} className={className}>
      {children}
    </EntityTag>
  );
}
