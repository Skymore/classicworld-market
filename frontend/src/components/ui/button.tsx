import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("btn", {
  variants: {
    variant: { default: "", primary: "primary", ghost: "ui-ghost" },
    size: { default: "", icon: "ui-icon-button" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
type Props = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };
export function Button({
  asChild,
  className,
  variant,
  size,
  type = "button",
  ...props
}: Props) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      type={asChild ? undefined : type}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
