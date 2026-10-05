/**
 * Client state for personal organization: folds the server's snapshot+delta
 * stream into one state per environment.
 */
import type {
  PersonalGroup,
  PersonalOrganizationSnapshot,
  PersonalOrganizationStreamEvent,
  PersonalOrganizerStatus,
  PersonalThreadPlacement,
} from "@t3tools/contracts";

export interface PersonalOrganizationState {
  readonly groupsById: Readonly<Record<string, PersonalGroup>>;
  readonly placementsByThreadId: Readonly<Record<string, PersonalThreadPlacement>>;
  readonly organizer: PersonalOrganizerStatus;
}

export function organizationStateFromSnapshot(
  snapshot: PersonalOrganizationSnapshot,
): PersonalOrganizationState {
  return {
    groupsById: Object.fromEntries(snapshot.groups.map((group) => [group.id, group])),
    placementsByThreadId: Object.fromEntries(
      snapshot.placements.map((placement) => [placement.threadId, placement]),
    ),
    organizer: snapshot.organizer,
  };
}

/** Applies one stream event; a delta before any snapshot is ignored. */
export function reducePersonalOrganization(
  state: PersonalOrganizationState | null,
  event: PersonalOrganizationStreamEvent,
): PersonalOrganizationState | null {
  if (event.type === "snapshot") return organizationStateFromSnapshot(event.snapshot);
  if (state === null) return null;
  let groupsById = state.groupsById;
  if (event.groups !== undefined || event.deletedGroupIds !== undefined) {
    const next: Record<string, PersonalGroup> = { ...groupsById };
    for (const group of event.groups ?? []) next[group.id] = group;
    for (const id of event.deletedGroupIds ?? []) delete next[id];
    groupsById = next;
  }
  let placementsByThreadId = state.placementsByThreadId;
  if (event.placements !== undefined || event.deletedPlacementThreadIds !== undefined) {
    const next: Record<string, PersonalThreadPlacement> = { ...placementsByThreadId };
    for (const placement of event.placements ?? []) next[placement.threadId] = placement;
    for (const threadId of event.deletedPlacementThreadIds ?? []) delete next[threadId];
    placementsByThreadId = next;
  }
  return {
    groupsById,
    placementsByThreadId,
    organizer: event.organizer ?? state.organizer,
  };
}
