// An unrelated peer deliberately given a turn's exact bearer secret. It reports successful
// connect separately from any reply, so a sandbox denial cannot masquerade as broker rejection.
import net from "node:net";
const out = (r) => process.stdout.write(JSON.stringify(r) + "\n");
out({ ready: true, pid: process.pid });
process.stdin.once("data", () => {
  const socket = net.connect(process.argv[2]);
  let data = "", connected = false, error;
  const timer = setTimeout(() => socket.destroy(), 4000);
  socket.on("connect", () => {
    connected = true;
    socket.write(JSON.stringify({ relay_bridge_secret: process.argv[3] }) + "\n");
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "outsider", version: "0" },
    } }) + "\n");
  });
  socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) socket.destroy(); });
  socket.on("error", (err) => { error = err.code; });
  socket.on("close", () => { clearTimeout(timer); out({ connected, data, error }); });
});
