/**
 * Router-compat shim — bridges @/lib/router-compat v6 call sites to
 * @tanstack/react-router without hand-rewriting every component.
 */
import {
  useNavigate as tsNavigate,
  useLocation as tsLocation,
  useParams as tsParams,
  useRouter,
  Link as TSLink,
  Navigate as TSNavigate,
} from "@tanstack/react-router";
import { useCallback, forwardRef, type ComponentProps, type ReactNode, type Ref } from "react";

/** TanStack router hooks need <RouterProvider>; console components can render without one, so probe first. */
function useHasRouterContext(): boolean {
  return useRouter({ warn: false }) != null;
}

function parseTo(to: string): { pathname: string; search?: Record<string, string>; hash?: string } {
  const hashSplit = (to ?? "").split("#");
  const beforeHash = hashSplit[0] ?? "";
  const hashStr = hashSplit[1];
  const [pathname, searchStr] = beforeHash.split("?");
  return {
    pathname: pathname || ".",
    search: searchStr ? Object.fromEntries(new URLSearchParams(searchStr)) : undefined,
    hash: hashStr || undefined,
  };
}

type NavigateOptions = { replace?: boolean; state?: unknown };

type NavigateFn = {
  (to: string | number, options?: NavigateOptions): void;
  (delta: number): void;
};

export function useNavigate(): NavigateFn {
  const tsNav = tsNavigate();
  const router = useRouter();
  return useCallback((to: string | number, options?: NavigateOptions) => {
    if (typeof to === "number") {
      router.history.go(to);
      return;
    }
    const { pathname, search, hash } = parseTo(to);
    tsNav({
      to: pathname,
      search: search as never,
      hash,
      state: options?.state as never,
      replace: options?.replace,
    });
  }, [tsNav, router]) as NavigateFn;
}

export function useLocation() {
  if (useHasRouterContext()) {
    const loc = tsLocation();
    return {
      pathname: loc.pathname,
      search: loc.searchStr ? `?${loc.searchStr}` : "",
      hash: loc.hash ?? "",
      state: (loc.state ?? null) as unknown,
    };
  }
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    state: (window.history.state ?? null) as unknown,
  };
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  return tsParams({ strict: false } as never) as T;
}

type LinkProps = Omit<ComponentProps<typeof TSLink>, "to"> & {
  to: string;
  replace?: boolean;
  state?: unknown;
  children?: ReactNode;
};

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { to, replace, state, children, ...rest },
  ref,
) {
  const { pathname, search, hash } = parseTo(to);
  if (!useHasRouterContext()) {
    const query = search && Object.keys(search).length > 0 ? `?${new URLSearchParams(search).toString()}` : "";
    return (
      <a ref={ref as Ref<HTMLAnchorElement>} href={`${pathname}${query}${hash ? `#${hash}` : ""}`} {...(rest as ComponentProps<"a">)}>
        {children}
      </a>
    );
  }
  return (
    <TSLink
      ref={ref as never}
      to={pathname as never}
      search={search as never}
      hash={hash}
      replace={replace}
      state={state as never}
      {...((rest ?? {}) as Record<string, unknown>)}
    >
      {children}
    </TSLink>
  );
});

export function Navigate({ to, replace, state }: { to: string; replace?: boolean; state?: unknown }) {
  const { pathname, search, hash } = parseTo(to);
  return <TSNavigate to={pathname as never} search={search as never} hash={hash} state={state as never} replace={replace} />;
}

export const Outlet = TSNavigate;
