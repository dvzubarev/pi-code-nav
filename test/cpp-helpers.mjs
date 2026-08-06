// Shared setup for C++ end-to-end scenarios.

import { resolve } from "node:path";
import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const unavailable = skip || !cppOk;

export const cppScenario = (name, spec) => scenario(name, { skip: unavailable, ...spec });
export const compileCommands =
    (source) =>
    ({ root }) =>
        JSON.stringify([
            {
                directory: root,
                command: `clang++ -std=c++17 -I. ${source}`,
                file: resolve(root, source),
            },
        ]);

export { nav };
