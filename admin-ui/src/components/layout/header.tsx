import { useState } from "react";
import { Link } from "@/lib/router-compat";
import { Button } from "@/components/ui/button";
import BrandLogo from "@/components/BrandLogo";
import { ROUTES } from "@/lib/constants";
import { Menu, X } from "lucide-react";

export default function Header({ onSignOut }: { onSignOut: () => void }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 w-full z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="container mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
        <Link
          to={ROUTES.DASHBOARD}
          className="flex items-center gap-2 transition-opacity duration-300 hover:opacity-80"
        >
          <BrandLogo className="text-xl" />
        </Link>

        <nav className="hidden md:flex items-center space-x-6">
          <Link
            to={ROUTES.DASHBOARD}
            className="text-sm font-medium text-foreground hover:text-primary transition-colors"
          >
            Overview
          </Link>
          <Link
            to={ROUTES.COURSES}
            className="text-sm font-medium text-foreground hover:text-primary transition-colors"
          >
            Courses
          </Link>
          <Link
            to={ROUTES.LEARNERS}
            className="text-sm font-medium text-foreground hover:text-primary transition-colors"
          >
            Learners
          </Link>
        </nav>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>

        <button
          className="md:hidden text-foreground hover:text-primary transition-colors"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {mobileMenuOpen && (
        <nav className="md:hidden pt-4 pb-2 border-b animate-fade-in bg-background">
          <div className="flex flex-col space-y-4 px-4">
            <Link
              to={ROUTES.DASHBOARD}
              className="text-sm font-medium text-foreground hover:text-primary transition-colors py-2"
              onClick={() => setMobileMenuOpen(false)}
            >
              Overview
            </Link>
            <Link
              to={ROUTES.COURSES}
              className="text-sm font-medium text-foreground hover:text-primary transition-colors py-2"
              onClick={() => setMobileMenuOpen(false)}
            >
              Courses
            </Link>
            <Link
              to={ROUTES.LEARNERS}
              className="text-sm font-medium text-foreground hover:text-primary transition-colors py-2"
              onClick={() => setMobileMenuOpen(false)}
            >
              Learners
            </Link>
            <Button variant="outline" onClick={() => { setMobileMenuOpen(false); onSignOut(); }} className="w-full mt-4">
              Sign out
            </Button>
          </div>
        </nav>
      )}
    </header>
  );
}
