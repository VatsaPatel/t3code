import { createPersonalOrganizationAtoms } from "@t3tools/client-runtime/personal/organizationAtoms";

import { connectionAtomRuntime } from "../connection/runtime";

export const personalOrganizationEnvironment =
  createPersonalOrganizationAtoms(connectionAtomRuntime);
