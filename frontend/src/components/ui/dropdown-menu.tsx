import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export function DropdownMenuContent({
  className,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={4}
        align="end"
        className={cn("sortmenu ui-sortmenu", className)}
        {...props}
      />
    </Menu.Portal>
  );
}
export function DropdownMenuRadioItem({
  className,
  ...props
}: ComponentProps<typeof Menu.RadioItem>) {
  return <Menu.RadioItem className={cn("ui-sortitem", className)} {...props} />;
}
