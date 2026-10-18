import { useQuery } from "@tanstack/react-query";
import { adminApi } from "./admin";
import { useAuth } from "./auth-context";

export function useSession() {
  return useAuth().session;
}

export function useCourses(status?: "draft" | "published", organization?: string) {
  return useQuery({
    queryKey: ["courses", organization, status],
    queryFn: () => adminApi.courses.list(status),
  });
}

export function useOrganisations(enabled: boolean) {
  return useQuery({
    queryKey: ["organisations"],
    queryFn: adminApi.organisations,
    enabled,
  });
}
