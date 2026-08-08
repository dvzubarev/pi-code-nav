// Shared setup for Bash code_search_symbol end-to-end scenarios.

import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const bashOk = SHOULD_RUN_E2E ? await serverAvailable("bash") : false;
const unavailable = skip || !bashOk;

export const bashScenario = (name, spec) => scenario(name, { skip: unavailable, ...spec });

export { nav };
