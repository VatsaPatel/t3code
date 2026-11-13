import { createFileRoute } from "@tanstack/react-router";

import { RoutinesPage } from "../personal/RoutinesPage";

export const Route = createFileRoute("/_chat/routines")({
  component: RoutinesPage,
});
