"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

type Cur = "sol" | "usd";
const Ctx = createContext<{ cur: Cur; setCur: (c: Cur) => void; solUsd: number | null }>({ cur: "sol", setCur: () => {}, solUsd: null });

/** LP Agent's "$" toggle: every amount switches between SOL and USD. Remembered on this device. */
export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [cur, setCurState] = useState<Cur>("sol");
  const [solUsd, setSolUsd] = useState<number | null>(null);
  useEffect(() => {
    try {
      if (localStorage.getItem("binflip.currency") === "usd") setCurState("usd");
    } catch {
      /* storage blocked */
    }
    const load = () => void api<{ usd: number | null }>("/v1/prices/sol").then((r) => setSolUsd(r.usd)).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  const setCur = (c: Cur) => {
    setCurState(c);
    try {
      localStorage.setItem("binflip.currency", c);
    } catch {
      /* storage blocked */
    }
  };
  return <Ctx.Provider value={{ cur, setCur, solUsd }}>{children}</Ctx.Provider>;
}

export const useCurrency = () => useContext(Ctx);
