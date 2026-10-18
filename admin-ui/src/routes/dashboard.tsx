import { createFileRoute } from "@tanstack/react-router";
import { CoursesScreen } from "@/components/console/courses-screen";

export const Route = createFileRoute("/dashboard")({
  component: CoursesScreen,
});
