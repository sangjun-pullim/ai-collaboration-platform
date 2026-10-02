import { createClient } from "@supabase/supabase-js";
import { ConnectionError } from "./contracts.ts";

export function deviceClient(url: string, key: string) {
  let upstream: URL;
  try { upstream = new URL(url); } catch { throw new ConnectionError("UNAVAILABLE"); }
  if (upstream.username || upstream.password || upstream.search || upstream.hash || (url !== upstream.origin && url !== `${upstream.origin}/`) || !(upstream.protocol === "https:" || upstream.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(upstream.hostname))) throw new ConnectionError("UNAVAILABLE");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) },
  });
}
