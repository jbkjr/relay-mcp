// The Claude desktop app's own relay entry: its name, the name it had before, and what it is, for
// install and doctor to say (README, "Claude desktop app and Cowork").
//
// Seen 2026-10-16 (Claude.app 2.42304.0, Claude Code 2.1.299 in the app): the app starts relay from
// its entry outside any project, once for its chats and once for Cowork and the Code tab together,
// and passes the second one's tools into each of those sessions as a server named after the entry.
// Nothing the app sends tells the sessions apart over one connection, so each conversation's model
// carries a session token relay issued it (docs/d9-isolation-plan.md). Under the name `relay` those tools hid
// the ones of the relay Claude Code starts in a Code tab session from its own registration, hence
// the entry's own name. The app's tool calls time out after 60 s, and a timeout restarts the shared
// relay for every session, so waits there end sooner (src/mcp/host.ts DESKTOP_WAIT_S).
import { DESKTOP_WAIT_S } from "../mcp/host.js";
import { SHARED_REASON } from "../core/identity.js";

/** The entry's name under mcpServers. */
export const DESKTOP_ENTRY = "relay-desktop";
/** The name relay's entry had before (0.2.0 and the 0.9 release candidates). Install moves it. */
export const DESKTOP_OLD_ENTRY = "relay";

export const DESKTOP_SHARED =
  `${DESKTOP_ENTRY} is the desktop app's own relay, and is shared. ${SHARED_REASON} The token is a bearer key its model holds: it separates conversations that use relay honestly. ` +
  "Configuration describes the topology; doctor does not observe calls or verify which conversation used it. Claude.app 2.42304.0's code was checked on 2026-10-17: neither process forwards per-conversation metadata. Pass cwd on merge and on starts (a new ask without it consults in a new, empty directory of its own); " +
  `no session on this shared entry gets an approval dialog, confirm or notices, and its waits end after ${DESKTOP_WAIT_S} s, under the app's 60 s tool timeout (README, "Claude desktop app and Cowork").`;
