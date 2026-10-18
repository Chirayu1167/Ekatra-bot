import { createFileRoute } from "@tanstack/react-router";
import { UsersAuditScreen } from "@/components/console/operations-screens";

export const Route = createFileRoute("/users")({ component: UsersAuditScreen });
