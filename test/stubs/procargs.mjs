// What any process can learn of another's command line and environment: the sysctl
// kern.procargs2 (CTL_KERN, KERN_PROCARGS2, pid), which holds the arguments and the environment the
// process was started with (ps reads it). Asked through osascript's JavaScript bridge, which every
// Mac has, as relay's canary asks its native checks (src/confine/canary.ts). Used by the stub Gemini
// agent, from inside relay's sandbox, on its own process; its positive control is a variable relay
// sets in that environment (GEMINI_CLI_HOME), which the read must show.
import { execFileSync } from "node:child_process";

const JXA = `ObjC.bindFunction("sysctl", ["int", ["void *", "unsigned int", "void *", "long *", "void *", "long"]]);
ObjC.bindFunction("malloc", ["void *", ["long"]]);
ObjC.bindFunction("__error", ["int *", []]);
function run(argv) {
  var mib = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
  var size = Ref();
  if ($.sysctl(mib.bytes, 3, null, size, null, 0) < 0) return JSON.stringify({ errno: $.__error()[0] });
  var buf = $.malloc(size[0]);
  if ($.sysctl(mib.bytes, 3, buf, size, null, 0) < 0) return JSON.stringify({ errno: $.__error()[0] });
  return JSON.stringify({ data: $.NSData.dataWithBytesLength(buf, size[0]).base64EncodedStringWithOptions(0).js });
}`;

/** `pid`'s start-up arguments and environment as one string, or the errno that refused them. */
export function procArgs(pid) {
  const mib = Buffer.from(new Int32Array([1, 49, pid]).buffer).toString("base64");
  try {
    const out = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA, mib], { encoding: "utf8", timeout: 20000 }));
    return out.errno !== undefined ? { errno: out.errno } : { text: Buffer.from(out.data, "base64").toString("latin1") };
  } catch (err) {
    return { error: String(err?.stderr ?? err?.message ?? err).slice(0, 300) };
  }
}
