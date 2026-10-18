import { createFileRoute } from "@tanstack/react-router";
import { FailuresScreen } from "@/components/console/operations-screens";

export const Route = createFileRoute("/failures")({ component: FailuresScreen });
