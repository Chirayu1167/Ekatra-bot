import { createFileRoute } from "@tanstack/react-router";
import { BroadcastScreen } from "@/components/console/operations-screens";

export const Route = createFileRoute("/broadcast")({ component: BroadcastScreen });
