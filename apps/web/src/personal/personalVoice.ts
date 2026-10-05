import { createPersonalVoiceEnvironmentAtoms } from "@t3tools/client-runtime/personal/voice";

import { connectionAtomRuntime } from "../connection/runtime";

export const personalVoiceEnvironment = createPersonalVoiceEnvironmentAtoms(connectionAtomRuntime);
