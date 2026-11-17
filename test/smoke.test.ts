import { test } from "node:test";
import assert from "node:assert/strict";
import { TkSharedDocError } from "../src/types.ts";

test("toolchain runs TS tests", () => {
  assert.ok(new TkSharedDocError("x") instanceof Error);
});
