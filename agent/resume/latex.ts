import { AgentError } from "../core/errors.ts";

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** Escapes plain text for LaTeX body use. All MY_DATA text goes through this. */
export function latexEscape(s: string): string {
  return s
    .replace(/[\\&%$#_{}~^]/g, (c) => ESCAPES[c] ?? c)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•/g, "\\textbullet{}");
}

/** URLs inside \href need %, # and \ escaped but must otherwise stay intact. */
export function latexUrl(url: string): string {
  return url.replace(/\\/g, "/").replace(/([%#])/g, "\\$1");
}

const MARKER_RE = /^% === AUTO: ([A-Z_]+) (START|END) ===\s*$/;

export interface MarkerBlock {
  name: string;
  startLine: number; // index of START marker line
  endLine: number; // index of END marker line
}

export function findMarkers(tex: string): MarkerBlock[] {
  const lines = tex.split(/\r?\n/);
  const blocks: MarkerBlock[] = [];
  let open: { name: string; line: number } | null = null;
  lines.forEach((line, i) => {
    const m = MARKER_RE.exec(line.trim());
    if (!m) return;
    const [, name = "", kind] = m;
    if (kind === "START") {
      if (open) throw new AgentError("VALIDATION_FAILED", `marker ${name} START at line ${i + 1} while ${open.name} is still open`);
      open = { name, line: i };
    } else {
      if (!open || open.name !== name) throw new AgentError("VALIDATION_FAILED", `marker ${name} END at line ${i + 1} without matching START`);
      blocks.push({ name, startLine: open.line, endLine: i });
      open = null;
    }
  });
  if (open) throw new AgentError("VALIDATION_FAILED", `marker ${(open as { name: string }).name} is never closed`);
  const names = blocks.map((b) => b.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new AgentError("VALIDATION_FAILED", `marker ${dup} appears more than once`);
  return blocks;
}

/** Replaces the content between each named marker pair. Lines outside markers are untouched. */
export function patchMarkers(tex: string, contents: Record<string, string>): string {
  const eol = tex.includes("\r\n") ? "\r\n" : "\n";
  const lines = tex.split(/\r?\n/);
  const blocks = findMarkers(tex);
  for (const name of Object.keys(contents)) {
    if (!blocks.some((b) => b.name === name)) throw new AgentError("VALIDATION_FAILED", `template has no AUTO marker for ${name}`);
  }
  // Apply bottom-up so earlier line indexes stay valid.
  for (const b of [...blocks].sort((a, z) => z.startLine - a.startLine)) {
    const content = contents[b.name];
    if (content === undefined) continue;
    const body = content.replace(/\s+$/, "").split(/\r?\n/);
    lines.splice(b.startLine + 1, b.endLine - b.startLine - 1, ...body);
  }
  return lines.join(eol);
}

/** Text with every marker body removed — used to prove only marker regions changed. */
export function outsideMarkers(tex: string): string {
  const lines = tex.split(/\r?\n/);
  const blocks = findMarkers(tex);
  const keep = lines.map(() => true);
  for (const b of blocks) for (let i = b.startLine + 1; i < b.endLine; i++) keep[i] = false;
  return lines.filter((_, i) => keep[i]).join("\n");
}

export function markerContent(tex: string, name: string): string {
  const lines = tex.split(/\r?\n/);
  const b = findMarkers(tex).find((x) => x.name === name);
  return b ? lines.slice(b.startLine + 1, b.endLine).join("\n") : "";
}

/** Strips LaTeX comments (unescaped %) for structural checks. */
function stripComments(tex: string): string {
  return tex
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^\\])%.*$/, "$1"))
    .join("\n");
}

export interface LatexValidation {
  ok: boolean;
  errors: string[];
  sections: string[];
}

/** Structural validation without a TeX engine: braces, environments, document body, markers, duplicate sections. */
export function validateLatex(tex: string): LatexValidation {
  const errors: string[] = [];
  const body = stripComments(tex);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++; // skip escaped char (\{ \} \\ etc.)
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) {
        errors.push(`unbalanced '}' near offset ${i}`);
        depth = 0;
      }
    }
  }
  if (depth !== 0) errors.push(`${depth} unclosed '{'`);

  const stack: string[] = [];
  for (const m of body.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    const [, kind, env = ""] = m;
    if (kind === "begin") stack.push(env);
    else if (stack.pop() !== env) errors.push(`\\end{${env}} does not match the open environment`);
  }
  if (stack.length) errors.push(`unclosed environments: ${stack.join(", ")}`);
  if (!/\\documentclass/.test(body)) errors.push("missing \\documentclass");
  if (!/\\begin\{document\}/.test(body) || !/\\end\{document\}/.test(body)) errors.push("missing document environment");
  try {
    findMarkers(tex);
  } catch (err) {
    errors.push((err as Error).message);
  }
  const sections = [...body.matchAll(/\\section\*?\{([^}]*)\}/g)].map((m) => (m[1] ?? "").replace(/\\&/g, "&").trim());
  const dup = sections.find((s, i) => sections.indexOf(s) !== i);
  if (dup) errors.push(`duplicate section '${dup}'`);
  return { ok: errors.length === 0, errors, sections };
}

/** Minimal line diff (LCS) producing unified-style output. Adequate for resume-sized files. */
export function lineDiff(a: string, b: string, labels = { a: "master.tex", b: "resume.tex" }): string {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out = [`--- ${labels.a}`, `+++ ${labels.b}`];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      out.push(`+${B[j]} (line ${j + 1})`);
      j++;
    } else {
      out.push(`-${A[i]} (line ${i + 1})`);
      i++;
    }
  }
  return out.join("\n") + "\n";
}
