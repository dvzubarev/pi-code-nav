import type { ServerConfig } from "../server-config";

/**
 * TypeScript/JavaScript: typescript-language-server wrapping tsserver. One
 * server covers both .ts and .tsx — the languageId sent in didOpen
 * distinguishes them ("typescript"/"typescriptreact"). The server implements
 * workspace/symbol, hover, definition, references, rename, and the pull
 * diagnostic model.
 */
export const TYPESCRIPT_CONFIG: ServerConfig = {
    command: "typescript-language-server",
    args: ["--stdio"],
    initOptions: {
        // Let the server locate the local tsconfig.json / jsconfig.json and
        // honor the project's compiler options.
        hostInfo: "pi-code-nav",
    },
};
