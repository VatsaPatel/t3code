import { createPersonalTodayAtoms } from "@t3tools/client-runtime/personal/todayAtoms";

import { connectionAtomRuntime } from "../connection/runtime";

/** Today host state: to-dos, Hermes routines and the brief, read from the primary environment. */
export const personalTodayEnvironment = createPersonalTodayAtoms(connectionAtomRuntime);
