// The narrow shared policy: owner hashing and durable evidence that room text was given.
// These helpers never start a transaction; callers can compose them with their writer lock.
import crypto from "node:crypto";
import { db, now } from "./db.js";
import { ROOM_OWNER_DOMAIN } from "./room-types.js";

/** Pass inst.token, including the resolved owner value of a carried shared-session token. */
export function roomOwnerHash(token: string): string {
  return crypto.createHash("sha256").update(ROOM_OWNER_DOMAIN).update(token).digest("hex");
}

/** Record the first exposure, before returning external text; retries never clear or move it. */
export function markRoomExposure(ownerHash: string, givenAt: number = now()): void {
  db().prepare("INSERT OR IGNORE INTO room_exposures (owner_hash, given_at) VALUES (?, ?)").run(ownerHash, givenAt);
}

/** Use inside approvals.decide's existing transaction to close its race with exposure. */
export function roomOwnerExposed(ownerHash: string): boolean {
  return db().prepare("SELECT 1 FROM room_exposures WHERE owner_hash = ?").get(ownerHash) !== undefined;
}
