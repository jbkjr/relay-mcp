// Loaded into a root relay server (NODE_OPTIONS=--import) for the idle-cost cell only: on SIGUSR2
// it appends this process's CPU time (user + system, microseconds) to $BENCH_CPU_FILE. Relay's
// workers and agents do not inherit NODE_OPTIONS, so only the root server is measured.
import fs from "node:fs";
const file = process.env.BENCH_CPU_FILE;
if (file) {
  process.on("SIGUSR2", () => {
    const u = process.cpuUsage();
    fs.appendFileSync(file, `${u.user + u.system}\n`);
  });
}
