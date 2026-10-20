import { APP_NAME } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  className?: string;
  imageClassName?: string;
  compact?: boolean;
}

export default function BrandLogo({ className, imageClassName, compact = false }: BrandLogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg
        className={cn("h-9 w-9 shrink-0", imageClassName)}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="32" height="32" rx="8" fill="#25D366" />
        <path
          d="M10 11L10 21L16 16L10 11Z"
          fill="white"
        />
        <path
          d="M16 11L16 21L22 16L16 11Z"
          fill="white"
        />
      </svg>
      {!compact && (
        <span className="font-bold text-primary tracking-tight">{APP_NAME}</span>
      )}
    </span>
  );
}
