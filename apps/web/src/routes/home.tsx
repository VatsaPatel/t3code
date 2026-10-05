import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../personal/home/HomePage";

export const Route = createFileRoute("/home")({
  component: HomePage,
});
