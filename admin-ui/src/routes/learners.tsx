import { createFileRoute } from "@tanstack/react-router";
import { LearnersScreen } from "@/components/console/learners-screen";

export const Route = createFileRoute("/learners")({
  component: LearnersScreen,
});
