// Test-only preload (node --import, through NODE_OPTIONS in a test harness's environment): puts the
// short link to ~/.rn in the test's own scratch directory (STUB_LINK_PARENT) instead of
// /Users/Shared. Production relay never loads this file.
import { setNativeTempAliasParentForTests } from "../../dist/confine/private-root.js";

if (process.env.STUB_LINK_PARENT) setNativeTempAliasParentForTests(process.env.STUB_LINK_PARENT);
