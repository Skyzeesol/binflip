import { describe, expect, it } from "vitest";
import { dammRemoveShare } from "./dammRemove.js";

describe("DAMM V2 partial remove share", () => {
  it("10 removed with 90 left = 10%", () => {
    expect(dammRemoveShare(10n, { status: "ok", liquidity: 90n })).toEqual({ ok: true, bps: 1000 });
  });
  it("a verified empty position = 100%", () => {
    expect(dammRemoveShare(10n, { status: "ok", liquidity: 0n })).toEqual({ ok: true, bps: 10_000 });
  });
  it("an RPC error never becomes a full withdraw", () => {
    expect(dammRemoveShare(10n, { status: "error", message: "429" })).toEqual({ ok: false, reason: "ratio_read_failed", detail: "429" });
  });
  it("a position closed later is left to its close event", () => {
    expect(dammRemoveShare(10n, { status: "missing" })).toEqual({ ok: false, reason: "leader_position_gone" });
  });
});
