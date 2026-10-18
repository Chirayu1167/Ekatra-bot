import { createFileRoute } from "@tanstack/react-router";
import { SchedulesScreen } from "@/components/console/schedules-screen";

export const Route = createFileRoute("/schedules")({
  component: SchedulesScreen,
});
