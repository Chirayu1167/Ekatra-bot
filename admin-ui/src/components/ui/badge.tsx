import * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = (props: {
  variant?: "default" | "secondary" | "destructive" | "outline";
}) => {
  const { variant = "default" } = props;
  return cn(
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
    variant === "default"
      ? "bg-primary text-primary-foreground"
      : variant === "secondary"
      ? "bg-secondary text-secondary-foreground"
      : variant === "destructive"
      ? "bg-destructive text-destructive-foreground"
      : variant === "outline"
      ? "border-input bg-transparent"
      : ""
  );
};

const Badge = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "secondary" | "destructive" | "outline" }
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(badgeVariants({ variant }), className)}
    {...props}
  />
));
Badge.displayName = "Badge";

export { Badge, badgeVariants };
