import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig safety gates", () => {
  it("defaults to dry-run", () => {
    expect(loadConfig(base).mode).toBe("dry_run");
  });

  it("stays dry-run when only LIVE_CONFIRMED is set", () => {
    expect(loadConfig({ ...base, LIVE_CONFIRMED: "1" }).mode).toBe("dry_run");
  });

  it("refuses DRY_RUN=0 without LIVE_CONFIRMED=1", () => {
    expect(() => loadConfig({ ...base, DRY_RUN: "0" })).toThrow(ConfigError);
  });

  it("goes live only with both flags (the keystore is the executor's own check)", () => {
    const live = { ...base, DRY_RUN: "0", LIVE_CONFIRMED: "1" };
    expect(loadConfig(live).mode).toBe("live");
    expect(
      loadConfig({ ...live, KEYSTORE_PATH: "/keystore/agent.json", KEYSTORE_PASSPHRASE_FILE: "/run/secrets/p" }).mode,
    ).toBe("live");
  });

  it("rejects unknown flag values instead of guessing", () => {
    expect(() => loadConfig({ ...base, DRY_RUN: "no" })).toThrow(ConfigError);
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ ...base, DRY_RUN: "", HELIUS_API_KEY: "" }).mode).toBe("dry_run");
  });

  it("requires DATABASE_URL and REDIS_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
