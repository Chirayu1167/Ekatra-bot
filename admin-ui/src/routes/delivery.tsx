import { createFileRoute } from "@tanstack/react-router";
import { DeliveryScreen } from "@/components/console/operations-screens";

export const Route = createFileRoute("/delivery")({ component: DeliveryScreen });
