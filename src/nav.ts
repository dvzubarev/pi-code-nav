/**
 * Barrel re-export for the code-nav tool implementations.
 *
 * `index.ts` does `import * as nav from "./src/nav"` and the tests/CLI load
 * `"./src/nav.ts"`, then call `nav.<tool>(params, cwd, clientOf)`. Keeping a
 * single entry point preserves the old `./nav` surface (now `./src/nav`) so
 * callers don't need to know about the per-tool file split.
 *
 * Eight implementations live in their own files (seven registered agent tools
 * plus the internal scan implementation), sharing `nav-core.ts` (ClientProvider, ALL_LANGS, UnknownLanguageError,
 * awaitReadyForQuery) and `detect.ts` (project language detection):
 *   outline.ts   definition.ts   references.ts   symbol.ts
 *   rename.ts    hover.ts  scan.ts         diagnostics.ts
 */

export { ALL_LANGS, UnknownLanguageError } from "./nav-core";
export type { ClientProvider } from "./nav-core";
export { clearDetectedLanguagesCache, detectProjectLanguages } from "./detect";

export { outline } from "./outline";
export type { OutlineParams } from "./outline";

export { definition } from "./definition";
export type { DefinitionParams } from "./definition";

export { references } from "./references";
export type { ReferencesParams } from "./references";

export { symbol, discoverThirdPartyRoots } from "./symbol";
export type { SymbolParams } from "./symbol";

export { rename } from "./rename";
export type { RenameParams } from "./rename";

export { hover } from "./hover";
export type { HoverParams } from "./hover";

export { scan } from "./scan";
export type { ScanParams } from "./scan";

export { diagnostics } from "./diagnostics";
export type { DiagnosticsParams } from "./diagnostics";
