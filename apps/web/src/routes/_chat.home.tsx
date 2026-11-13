import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../personal/HomePage";

export const Route = createFileRoute("/_chat/home")({
  component: HomePage,
});
