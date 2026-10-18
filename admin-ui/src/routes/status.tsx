import { createFileRoute } from "@tanstack/react-router";
import { StatusScreen } from "@/components/console/operations-screens";

export const Route = createFileRoute("/status")({ component: StatusScreen });
