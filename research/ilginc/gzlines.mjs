// Stream the lines of a (possibly multi-member) gzip file without loading it into one string.
// Tolerates a truncated last member (crash mid-write).
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";
export async function* gzLines(file) {
  const gz = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const src = fs.createReadStream(file);
  src.pipe(gz);
  gz.on("error", () => gz.end()); // truncated tail: keep what decoded so far
  const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}
