// client/src/components/read-only-action.tsx
//
// What a viewer sees where an administrator sees an action.
//
// These controls used to be hidden from viewers outright. On the public demo
// every visitor is a viewer, so hiding them hid the application: a rentals
// page with no way to create a rental, a maintenance log with no way to log
// maintenance. Each page read as a report rather than as a system with
// workflows behind it, and nothing told the visitor the workflows existed.
//
// A locked control says both things at once -- this can be done here, and
// here is who may do it. The server enforces the rule either way
// (requireAdmin on every write route); this is presentation only.
//
// The lock stands in for the action's own icon rather than living in a hover
// tooltip, because tooltips never open on a touch screen and the reason has
// to survive there too. The hover title is a courtesy on top. It sits on the
// wrapper because a disabled button takes no pointer events, so a title on
// the button itself would never show. For the same reason `className` styles
// the wrapper: it is the wrapper that takes part in the page's layout.
//
// Row-level edit and delete stay hidden. One locked control per page makes
// the point; a lock on every row of a table is noise.

import { Lock } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Same words the Setup page already shows under its disabled seed button. */
export const ADMIN_ONLY = "Admin role required";

type ReadOnlyActionProps = Omit<ButtonProps, "disabled" | "onClick" | "asChild">;

export function ReadOnlyAction({ children, className, ...props }: ReadOnlyActionProps) {
  return (
    <span title={ADMIN_ONLY} className={cn("inline-flex", className)}>
      <Button {...props} className="w-full" disabled>
        <Lock />
        {children}
        <span className="sr-only">({ADMIN_ONLY.toLowerCase()})</span>
      </Button>
    </span>
  );
}
