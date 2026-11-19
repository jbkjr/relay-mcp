// Stands in for a worker serving one confined turn: opens the turn's broker, prints where it is,
// and closes it when told ("close" on stdin) or when stdin ends, as a worker does when the turn ends.
// usage: node broker-host.mjs '<{"nodeId","turnId","mayDelegate","mayAsk"}>'
import { openBroker } from "../../dist/confine/broker.js";
import { socketPeer } from "../../dist/confine/peer.js";

let broker;
const refusals = [];
const opts = JSON.parse(process.argv[3] ?? "{}");
try {
  broker = await openBroker(JSON.parse(process.argv[2]), {
    onRefusal: (reason) => refusals.push(reason),
    ...(opts.unknownPeer ? { peerIdentity: async () => { throw new Error("test: peer pid unavailable"); } } : {}),
    ...(opts.wrongUid || opts.stalePeer ? { peerIdentity: async (socket) => {
      const peer = await socketPeer(socket);
      return opts.wrongUid ? { ...peer, uid: peer.uid + 1 } : { ...peer, start: "an earlier occupant of this pid" };
    } } : {}),
  });
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ socketPath: broker.socketPath, dir: broker.dir, bridge: broker.bridgeCommand }) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  if (d.trim().startsWith("{")) {
    const cmd = JSON.parse(d);
    if (cmd.bind) {
      try {
        broker.bindHarness(cmd.bind);
        process.stdout.write(JSON.stringify({ bound: true }) + "\n");
      } catch (err) {
        process.stdout.write(JSON.stringify({ bound: false, error: err.message }) + "\n");
      }
    } else if (cmd.refusals) process.stdout.write(JSON.stringify({ refusals }) + "\n");
    else if (cmd.secretFile) {
      try {
        process.stdout.write(JSON.stringify({ file: broker.secretFile() }) + "\n");
      } catch (err) {
        process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
      }
    } else if (cmd.list) {
      // What a harness that discovers relay's tools is given (backends/gemini.ts writeGeminiToolFiles).
      try {
        process.stdout.write(JSON.stringify({ tools: await broker.listTools() }) + "\n");
      } catch (err) {
        process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
      }
    }
    return;
  }
  if (!d.includes("close")) return;
  await broker.close();
  process.stdout.write(JSON.stringify({ closed: true }) + "\n");
});
process.stdin.on("end", async () => {
  await broker.close();
  process.exit(0);
});
