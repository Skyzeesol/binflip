import type { DecodedEvent, DecodedIx } from "@binflip/core";

/**
 * A leader transaction, decoded, as the events the service acts on. Pure: the decoder's output
 * goes in, so tests can feed synthetic decodes.
 *
 * Opens are matched strictly: every initialize_position* instruction of the tx (not only the
 * first) whose `owner` account IS the leader; its funding is read only from events of THAT
 * position (AddLiquidity / Rebalancing with data.position == the new position) in the same pool.
 * side: "sol" (SOL = Y in > 0, token in = 0), "token" (the reverse), "two_sided", or "empty".
 */
export type LeaderEvent =
  | { kind: "rebalance"; position: string; pool: string; active: number; old: { lower: number; upper: number }; next: { lower: number; upper: number; side: "sol" | "token" } }
  | { kind: "close"; position: string }
  | { kind: "open"; position: string; pool: string; lower: number; width: number; side: "sol" | "token" | "two_sided" | "empty"; amountX: bigint; amountY: bigint };

const str = (v: unknown) => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58: () => string }).toBase58() : String(v));
const big = (v: unknown) => {
  try {
    return BigInt(String(v ?? 0));
  } catch {
    return 0n;
  }
};

export function leaderEvents(decoded: Array<DecodedIx | DecodedEvent>, leader: string): LeaderEvent[] {
  const dlmm = decoded.filter((d) => d.protocol === "dlmm");
  const ixs = dlmm.filter((d): d is DecodedIx => d.kind === "ix");
  const evs = dlmm.filter((d): d is DecodedEvent => d.kind === "event");
  const out: LeaderEvent[] = [];

  for (const e of evs) {
    const d = e.data as Record<string, unknown>;
    if (e.name === "Rebalancing" && str(d.owner) === leader) {
      out.push({
        kind: "rebalance",
        position: str(d.position),
        pool: str(d.lb_pair),
        active: Number(d.active_bin_id),
        old: { lower: Number(d.old_min_id), upper: Number(d.old_max_id) },
        next: { lower: Number(d.new_min_id), upper: Number(d.new_max_id), side: big(d.x_added_amount) > 0n ? "token" : "sol" },
      });
    } else if (e.name === "PositionClose" && str(d.owner) === leader) {
      out.push({ kind: "close", position: str(d.position) });
    }
  }

  for (const ix of ixs.filter((i) => i.name.startsWith("initialize_position"))) {
    const position = ix.accounts.position, pool = ix.accounts.lb_pair, owner = ix.accounts.owner;
    if (!position || !pool || owner !== leader) continue; // someone else's position (e.g. a router's)
    const lower = Number(ix.args.lower_bin_id), width = Number(ix.args.width);
    if (!Number.isFinite(lower) || !(width > 0)) continue;
    let x = 0n, y = 0n;
    for (const e of evs) {
      const d = e.data as Record<string, unknown>;
      if (str(d.position) !== position || str(d.lb_pair) !== pool) continue;
      if (e.name === "AddLiquidity") {
        const a = (d.amounts as unknown[] | undefined) ?? [];
        x += big(a[0]);
        y += big(a[1]);
      } else if (e.name === "Rebalancing") {
        x += big(d.x_added_amount);
        y += big(d.y_added_amount);
      }
    }
    const side = x === 0n && y === 0n ? "empty" : x === 0n ? "sol" : y === 0n ? "token" : "two_sided";
    out.push({ kind: "open", position, pool, lower, width, side, amountX: x, amountY: y });
  }
  return out;
}

/**
 * May a decoded open start a LIVE copy? Only a SOL-only open whose block time is known and
 * recent, seen in order (not a late retry of an older tx).
 */
export function liveOpenAllowed(ev: Extract<LeaderEvent, { kind: "open" }>, blockTime: number | undefined, nowSec: number, late: boolean, maxAgeSec = 120): boolean {
  return ev.side === "sol" && !late && blockTime !== undefined && blockTime > 0 && nowSec - blockTime >= -5 && nowSec - blockTime < maxAgeSec;
}
