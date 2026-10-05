import { createFileRoute, redirect } from "@tanstack/react-router";

// The Today hub became Home; old links keep working.
export const Route = createFileRoute("/today")({
  beforeLoad: () => {
    throw redirect({ to: "/home", replace: true });
  },
});
