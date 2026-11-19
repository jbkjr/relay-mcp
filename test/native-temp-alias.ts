import fs from "node:fs";
import path from "node:path";

/** Only unlink our scratch home's alias, never follow it or remove another fixture's entry. */
export function removeTestNativeTempAlias(home: string, parent = "/Users/Shared"): void {
  const me = process.getuid?.() ?? 0;
  const alias = path.join(parent, `.rn-${me}`);
  const st = fs.lstatSync(alias, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && st.uid === me && fs.readlinkSync(alias) === path.join(home, ".rn")) fs.unlinkSync(alias);
}
