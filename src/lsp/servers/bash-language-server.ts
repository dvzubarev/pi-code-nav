import type { ServerConfig } from "../server-config";

export const BASH_CONFIG: ServerConfig = {
    command: "bash-language-server",
    args: ["start"],
    initOptions: {},
};
