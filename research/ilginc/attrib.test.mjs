import { test } from "node:test";
import assert from "node:assert/strict";
import { attribute } from "./attrib.mjs";
const sell = (tok, sol) => ({ tok: -BigInt(tok), solDelta: sol });
const buy = (tok, sol) => ({ tok: BigInt(tok), solDelta: -sol });

test("LP 1000 + separate buy 1000 + sale 2000 is NOT comparable (no netting)", () => {
  // before: tok = 1000 + 1000 − 2000 = 0 and net sold 1000 = received → wrongly "comparable"
  assert.equal(attribute(1000n, 1000n, [buy(1000, 5), sell(2000, 12)]).status, "external_buy");
});
test("LP 1000 fully sold is comparable, proceeds are the sales only", () => {
  const r = attribute(1000n, 1000n, [sell(400, 2), sell(600, 3)]);
  assert.equal(r.status, "ok");
  assert.equal(r.soldLamports, 5);
});
test("selling more than the LP gave is mixed; leaving >0.5% is unsold", () => {
  assert.equal(attribute(1000n, 1000n, [sell(2000, 9)]).status, "mixed");
  assert.equal(attribute(1000n, 1000n, [sell(900, 4)]).status, "unsold");
  assert.equal(attribute(1000n, 1000n, [sell(996, 4)]).status, "ok"); // dust
});
