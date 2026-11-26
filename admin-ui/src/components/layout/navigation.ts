import type { AdminRole } from "@/api/admin";

export interface NavigationItem {
  label: string;
  to: string;
}

const managementNavigation: NavigationItem[] = [
  { label: "Courses", to: "/dashboard" },
  { label: "Learners", to: "/learners" },
  { label: "Broadcasts", to: "/broadcasts" },
  { label: "Schedules", to: "/schedules" },
  { label: "Delivery", to: "/delivery" },
  { label: "Failures", to: "/failures" },
  { label: "Certificates", to: "/certificates" },
  { label: "Broadcast", to: "/broadcast" },
  { label: "Users and API keys", to: "/users" },
  { label: "Status", to: "/status" },
];

export function navigationForRole(role: AdminRole): NavigationItem[] {
  return role === "instructor"
    ? managementNavigation.slice(0, 2)
    : managementNavigation;
}
