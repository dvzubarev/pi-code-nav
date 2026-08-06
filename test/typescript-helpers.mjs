// Shared setup for TypeScript end-to-end scenarios.

import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const tsOk = SHOULD_RUN_E2E ? await serverAvailable("typescript") : false;
const unavailable = skip || !tsOk;

export const runOrSkip = (name, fn) => (unavailable ? test.skip(name, fn) : test(name, fn));
export const typescriptScenario = (name, spec) => scenario(name, { skip: unavailable, ...spec });

export { nav, resolve, scenario, withWorkspace, writeFile };
