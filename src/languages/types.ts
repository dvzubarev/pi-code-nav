/**
 * Type-only re-export facade for the neutral `Lang` type.
 *
 * The `Lang` UNION itself is defined in `./catalog.ts` (derived from the
 * `LANGUAGES` registry — see there for the details). This module exists so
 * consumers import `Lang` from a stable, transport-neutral path
 * (`./languages/types`) without coupling to the catalog's value exports.
 *
 * The import below is type-only: it is erased at runtime, so this module has
 * no runtime dependency and no circular import with `catalog.ts` (which never
 * imports this file).
 */

import type { Lang } from "./catalog";

export type { Lang };
