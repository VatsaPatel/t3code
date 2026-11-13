import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, HomeIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { useSidebar } from "~/components/ui/sidebar";

type UtilityItem = ComponentType<{ icon: ReactNode; label: string; onClick: () => void }>;

/** Fork-only sidebar entries; takes the upstream item component so SidebarChrome stays a one-line diff. */
export function PersonalSidebarItems({ Item }: { readonly Item: UtilityItem }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const go = (to: "/home" | "/routines") => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };
  return (
    <>
      <Item icon={<HomeIcon />} label="Home" onClick={() => go("/home")} />
      <Item icon={<CalendarClockIcon />} label="Routines" onClick={() => go("/routines")} />
    </>
  );
}
