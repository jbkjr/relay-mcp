// The registry of hosts. Adding one is a module beside claude.ts and a line here.
import { claudeDesktopHost } from "./claude-desktop.js";
import { claudeHost } from "./claude.js";
import { codexHost } from "./codex.js";
import { HOST_IDS, type HostDef, type HostId } from "./types.js";

export { briefSkill, HOST_IDS, type AdapterContext, type DoctorReport, type HostDef, type HostId, type SkillText } from "./types.js";

export const HOSTS: readonly HostDef[] = [claudeHost, codexHost, claudeDesktopHost];
if (HOSTS.map((h) => h.id).join() !== HOST_IDS.join()) throw new Error("relay's host registry does not match HOST_IDS");

export const isHost = (id: unknown): id is HostId => typeof id === "string" && (HOST_IDS as readonly string[]).includes(id);
export const hostDef = (id: HostId): HostDef => HOSTS.find((h) => h.id === id)!;
