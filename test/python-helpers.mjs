// Shared setup for Python end-to-end scenarios.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const tyOk = SHOULD_RUN_E2E ? await serverAvailable("python") : false;
const unavailable = skip || !tyOk;

async function thirdPartyAvailable() {
    if (!tyOk) return false;
    let roots;
    try {
        roots = await nav.discoverThirdPartyRoots("python", process.cwd());
    } catch {
        return false;
    }
    const someExists = async (paths) => {
        for (const path of paths) {
            try {
                await stat(path);
                return true;
            } catch {}
        }
        return false;
    };
    return (
        roots.length > 0 &&
        (await someExists(roots.map((root) => resolve(root, "typing.py")))) &&
        (await someExists(
            roots.flatMap((root) => [resolve(root, "cbor2"), resolve(root, "cbor2.py")]),
        )) &&
        (await someExists(roots.map((root) => resolve(root, "aiohttp"))))
    );
}

const thirdPartyUnavailable = unavailable || !(await thirdPartyAvailable());

export const pythonScenario = (name, spec) => scenario(name, { skip: unavailable, ...spec });
export const thirdPartyScenario = (name, spec) =>
    scenario(name, { skip: thirdPartyUnavailable, ...spec });
export const project = (main) => ({
    files: {
        "pyproject.toml": "[project]\nname='t'\nversion='0'",
        "main.py": main,
    },
});

export { nav };
