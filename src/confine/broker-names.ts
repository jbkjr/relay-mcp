// The names the brokers are known by in a launched agent's configuration and environment. They live
// apart from the brokers so that a backend can name them without loading a broker, and with it the
// MCP server and SDK, into every worker: a turn that opens no broker never loads one.

/** The MCP server name of the HTTP broker in a Codex turn's configuration (broker-http.ts). */
export const BROKER_SERVER_NAME = "relay_tools";
/** The variable that carries the HTTP broker's bearer token to the app server. */
export const BROKER_TOKEN_ENV = "RELAY_BROKER_TOKEN";
/** The variable that carries the turn's bridge secret to `relay bridge`, and nothing else (broker.ts). */
export const BRIDGE_SECRET_ENV = "RELAY_BRIDGE_SECRET";
