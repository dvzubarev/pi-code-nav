import type { ServerConfig } from "../server-config";

/** C++ default (matches the user's Emacs config). */
export const CCLS_CONFIG: ServerConfig = {
    command: "ccls",
    args: [],
    initOptions: {
        cache: { directory: `${process.env.HOME}/.cache/ccls-pi` },
        compilationDatabaseDirectory: "build",
    },
};
