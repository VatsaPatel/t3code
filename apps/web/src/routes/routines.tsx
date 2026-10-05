import { createFileRoute } from "@tanstack/react-router";

import { RoutinesPage } from "../personal/routines/RoutinesPage";

export const Route = createFileRoute("/routines")({
  component: RoutinesPage,
});
