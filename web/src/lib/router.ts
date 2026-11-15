import { useEffect, useState } from "react";

/** Hash routing ("#/jobs", "#/applications/JOB-000009") — no server routes needed, deep links work. */
export function useRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, "") || "/overview";
    const [p = "/overview", q = ""] = raw.split("?");
    return { path: p, parts: p.split("/").filter(Boolean), query: new URLSearchParams(q) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith("#") ? to : `#${to}`;
}
