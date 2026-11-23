"use client";

/** LP Agent "Position Sounds": a short chime when a position opens or closes. On by default, per device. */
export function soundsOn(): boolean {
  try {
    return localStorage.getItem("binflip.sounds") !== "off";
  } catch {
    return true;
  }
}

export function setSounds(on: boolean) {
  try {
    localStorage.setItem("binflip.sounds", on ? "on" : "off");
  } catch {
    /* storage blocked */
  }
  if (on) chime("open");
}

export function chime(kind: "open" | "close") {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === "open" ? [660, 880] : [880, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* no audio */
  }
}
