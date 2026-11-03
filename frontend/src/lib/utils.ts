import { clsx, type ClassValue } from "clsx";
// The components combine the site's own classes (btn, tab, stall…), never
// conflicting Tailwind utilities, so joining them is all tailwind-merge did.
// web/tests/class-names.test.mjs checks every call site still agrees with it.
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs).split(/\s+/).filter(Boolean).join(" ");
}
