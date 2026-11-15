/**
 * Role-family classification. A job's family comes from what the job *is* (its title, then the JD when the
 * title is generic), never from how many of the user's skill keywords it happens to mention: a maintenance
 * engineer JD that says "Java" and "SQL" is still a maintenance role.
 *
 * Nothing here is user-specific. Which families the user wants is derived from preferences.targetRoles (or the
 * explicit preferences.targetRoleFamilies) by classifying those role names with the same rules.
 */

export const JOB_FAMILIES = [
  "SOFTWARE_ENGINEERING", "FRONTEND", "BACKEND", "FULLSTACK", "DEVOPS", "DATA", "AI_ML", "QA", "SECURITY",
  "EMBEDDED", "ENTERPRISE_PLATFORM", "SUPPORT", "PRODUCT", "DESIGN", "HARDWARE", "MECHANICAL", "ELECTRICAL",
  "CIVIL", "FINANCE", "HR", "SALES", "OTHER",
] as const;
export type JobFamily = (typeof JOB_FAMILIES)[number];

export interface RoleClassification {
  jobFamily: JobFamily;
  targetRoleCompatible: boolean;
  reason: string;
  /** 0–1: how strong the evidence for jobFamily is (title rule 0.9, JD-refined 0.7, JD-only 0.6, unknown 0.3). */
  confidence: number;
  /** The terms that decided the family. */
  evidence: string[];
}

const SOFTWARE_WORDS = /\b(software|developer|programmer|sde|swe|full ?stack|backend|back end|frontend|front end|site reliability)\b/;

/** Title rules, first match wins. Specific non-web domains come before the generic software rules. */
const TITLE_RULES: Array<{ family: JobFamily; re: RegExp; unless?: RegExp }> = [
  { family: "QA", re: /\b(engineer in test|sdet)\b/ },
  { family: "EMBEDDED", re: /\b(embedded|firmware|autosar|bootloader|fbl|bsw|microcontroller|mcu|rtos|ecu|bsp|device drivers?|can bus|model based|simulink|steering)\b/ },
  { family: "HARDWARE", re: /\b(hardware|hw|vlsi|asic|fpga|pcb|rtl|silicon|semiconductor|analog|rf engineer|ethernet validation|sdv|brak(e|es|ing)|powertrain|chassis)\b/ },
  { family: "ENTERPRISE_PLATFORM", re: /\b(sap|salesforce|servicenow|itsm|apriso|mes engineer|dynamics 365|oracle (ebs|apps|fusion)|workday|guidewire|pega|sharepoint|netsuite)\b/ },
  { family: "SECURITY", re: /\b(security|cyber ?security|soc analyst|penetration|pentest|identity and access|iam engineer)\b/ },
  { family: "AI_ML", re: /\b(machine learning|ml engineer|mlops|ml ops|ai engineer|ai agent|applied ai|ai expert|artificial intelligence|deep learning|nlp|computer vision|data scientist|generative ai|genai|llm|research scientist)\b/ },
  { family: "DATA", re: /\b(data engineer(ing)?|data analyst|analytics engineer|business intelligence|bi developer|etl|data platform|data reliability|data migration|database administrator|dba)\b/ },
  { family: "DEVOPS", re: /\b(devops|devsecops|site reliability|sre|platform engineer(ing)?|infrastructure|cloud operations|cloud engineer|cloud network|network engineer|systems administrator|system administrator|sysadmin|release engineer|build engineer|production engineering)\b/ },
  { family: "QA", re: /\b(qa|quality assurance|quality engineer|test engineer|testing engineer|engineer testing|test developer|automation test(ing)?|tester|validation engineer|verification engineer)\b/ },
  { family: "SUPPORT", re: /\b(support engineer|technical support|technical services engineer|customer experience engineer|customer success engineer|escalation engineer|application support|help ?desk|service desk)\b/ },
  { family: "SALES", re: /\b(sales|account executive|business development|solutions? engineer|solutions consultant|pre ?sales|field engineer|customer success manager)\b/ },
  { family: "PRODUCT", re: /\b(product manager|product owner|program manager|project manager|project management|scrum master|business analyst|product analyst|requirements (management|engineer(ing)?))\b/ },
  { family: "DESIGN", re: /\b(designer|ux|ui\/ux|ui ux|design engineer|product design)\b/ },
  { family: "HR", re: /\b(recruit(er|ing|ment)?|talent acquisition|human resources|hr business partner|hrbp|people operations)\b/ },
  { family: "FINANCE", re: /\b(finance|financial analyst|accountant|accounting|audit(or)?|tax|treasury|payroll|controller)\b/, unless: SOFTWARE_WORDS },
  { family: "CIVIL", re: /\b(civil|structural engineer|construction|site engineer|surveyor)\b/ },
  { family: "ELECTRICAL", re: /\b(electrical|power systems|substation|instrumentation|control systems|plc|scada)\b/ },
  { family: "MECHANICAL", re: /\b(mechanical|maintenance|hvac|piping|plant engineer|manufacturing|production engineer|industrial engineer|fea|tooling|mould|mold|welding|cnc|fire safety|safety officer|hse|ehs)\b/, unless: SOFTWARE_WORDS },
  { family: "FULLSTACK", re: /\b(full ?stack|mern|mean stack)\b/ },
  { family: "FRONTEND", re: /\b(frontend|front end|ui developer|react developer|angular developer|web developer|javascript developer)\b/ },
  { family: "BACKEND", re: /\b(backend|back end|server side|api developer)\b|\b(java|golang|python|node|nodejs|dotnet|scala|kotlin|php|ruby)\b.*\b(developer|development|engineer|programmer)\b|\b(developer|development|engineer|programmer)\b.*\b(java|golang|python|node|nodejs|dotnet|scala|kotlin|php|ruby)\b/ },
  { family: "SOFTWARE_ENGINEERING", re: /\b(software|sw|sde|swe|developer|programmer|member (of )?technical staff|mts|application engineer|product engineer|engineering manager|director of engineering)\b/ },
];

/** JD signal terms, used only when the title is generic. Distinct hits are counted, not repetitions. */
const JD_SIGNALS: Partial<Record<JobFamily, string[]>> = {
  SOFTWARE_ENGINEERING: ["rest api", "restful", "microservice", "spring boot", "spring", "java", "javascript", "typescript", "react", "angular", "node.js", "web application", "backend", "frontend", "full stack", "sql", "api", "object-oriented", "data structures", "algorithms", "code review", "git", "ci/cd", "unit test"],
  EMBEDDED: ["embedded", "firmware", "autosar", "bootloader", "microcontroller", "rtos", "ecu", "can bus", "lin", "misra", "embedded c", "bare metal", "device driver", "uds", "diagnostics stack", "vector tools", "canoe", "canalyzer"],
  HARDWARE: ["pcb", "schematic", "fpga", "asic", "verilog", "vhdl", "oscilloscope", "hardware design", "signal integrity", "vehicle", "braking", "automotive ethernet", "hil"],
  MECHANICAL: ["preventive maintenance", "breakdown", "plant maintenance", "machinery", "mechanical", "hvac", "utilities", "compressor", "boiler", "tpm", "shop floor", "production line", "spare parts", "lubrication"],
  ELECTRICAL: ["electrical", "switchgear", "transformer", "plc", "scada", "wiring", "motor control"],
  DEVOPS: ["kubernetes", "terraform", "monitoring", "on-call", "incident", "infrastructure as code", "sre", "observability", "ansible", "helm"],
  DATA: ["data pipeline", "etl", "data warehouse", "spark", "airflow", "dbt", "snowflake", "bigquery", "data modeling"],
  AI_ML: ["machine learning", "deep learning", "model training", "pytorch", "tensorflow", "llm", "nlp", "computer vision", "rag"],
  QA: ["test cases", "test plan", "regression testing", "selenium", "test automation", "manual testing", "defect"],
  ENTERPRISE_PLATFORM: ["servicenow", "sap", "abap", "salesforce", "apex", "itsm", "erp", "mes"],
  SALES: ["quota", "pipeline generation", "prospects", "closing deals", "revenue target", "customer demos"],
  SUPPORT: ["ticket", "customer issues", "troubleshoot customer", "sla", "escalation"],
};

/** Families a target role accepts. General domain knowledge (a full-stack developer can take a backend role), not user data. */
const ACCEPTS: Partial<Record<JobFamily, JobFamily[]>> = {
  FULLSTACK: ["FULLSTACK", "FRONTEND", "BACKEND", "SOFTWARE_ENGINEERING"],
  BACKEND: ["BACKEND", "FULLSTACK", "SOFTWARE_ENGINEERING"],
  FRONTEND: ["FRONTEND", "FULLSTACK", "SOFTWARE_ENGINEERING"],
  SOFTWARE_ENGINEERING: ["SOFTWARE_ENGINEERING", "BACKEND", "FRONTEND", "FULLSTACK"],
};

export const normalizeRoleTitle = (t: string) => t.toLowerCase().replace(/[_/|:–—,()[\]-]+/g, " ").replace(/\s+/g, " ").trim();

export function titleFamily(title: string): { family: JobFamily; term: string } | null {
  // "Java Full Stack Developer with DevOps experience": the clause is a requirement, not the role.
  const t = normalizeRoleTitle(title).replace(/\s(with|having)\s.*\b(experience|expertise|knowledge|exposure|background|skills?)\b.*$/, "");
  for (const r of TITLE_RULES) {
    const m = r.re.exec(t);
    if (m && !(r.unless && r.unless.test(t))) return { family: r.family, term: m[0] };
  }
  return null;
}

function jdSignals(jd: string): Array<{ family: JobFamily; hits: string[] }> {
  const text = ` ${jd.toLowerCase().replace(/\s+/g, " ")} `;
  const has = (term: string) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
  return (Object.entries(JD_SIGNALS) as Array<[JobFamily, string[]]>)
    .map(([family, terms]) => ({ family, hits: terms.filter(has) }))
    .sort((a, b) => b.hits.length - a.hits.length);
}

/** Families the user targets: explicit targetRoleFamilies, else the families of the targetRoles names. */
export function targetFamilies(prefs: { targetRoles: string[]; targetRoleFamilies?: string[] | null }): Set<JobFamily> {
  const explicit = (prefs.targetRoleFamilies ?? []).filter((f): f is JobFamily => (JOB_FAMILIES as readonly string[]).includes(f));
  const base = explicit.length ? explicit : prefs.targetRoles.map((r) => titleFamily(r)?.family).filter((f): f is JobFamily => !!f);
  return new Set(base.flatMap((f) => ACCEPTS[f] ?? [f]));
}

export function classifyRole(
  job: { jobTitle: string; jdText: string | null },
  prefs: { targetRoles: string[]; targetRoleFamilies?: string[] | null; excludedRolePatterns?: string[] },
): RoleClassification {
  const accepted = targetFamilies(prefs);
  const byTitle = titleFamily(job.jobTitle);
  const signals = jdSignals(job.jdText ?? "");
  const sw = signals.find((s) => s.family === "SOFTWARE_ENGINEERING")?.hits ?? [];

  let family: JobFamily;
  let confidence: number;
  let evidence: string[];
  let basis: string;
  if (byTitle && byTitle.family !== "SOFTWARE_ENGINEERING") {
    ({ family } = byTitle);
    confidence = 0.9;
    evidence = [`title: '${byTitle.term}'`];
    basis = `title '${job.jobTitle}' names a ${family} role`;
  } else {
    // Generic software title ("Software Engineer", "SW Engineer") or no title rule: let a JD that is clearly
    // about another domain override it. Requires ≥4 distinct domain terms and more than the software terms.
    const other = signals.find((s) => s.family !== "SOFTWARE_ENGINEERING" && s.hits.length >= 4 && s.hits.length > sw.length);
    if (other) {
      family = other.family;
      confidence = byTitle ? 0.7 : 0.6;
      evidence = other.hits.slice(0, 6).map((h) => `JD: '${h}'`);
      basis = `${byTitle ? "generic title" : "title gives no role"}; JD is dominated by ${family} terms`;
    } else if (byTitle) {
      family = "SOFTWARE_ENGINEERING";
      confidence = 0.9;
      evidence = [`title: '${byTitle.term}'`];
      basis = `title '${job.jobTitle}' names a software role`;
    } else if (sw.length >= 4) {
      family = "SOFTWARE_ENGINEERING";
      confidence = 0.6;
      evidence = sw.slice(0, 6).map((h) => `JD: '${h}'`);
      basis = "title gives no role; JD describes software work";
    } else {
      family = "OTHER";
      confidence = 0.3;
      evidence = [];
      basis = `role family could not be established from title '${job.jobTitle}' or the JD`;
    }
  }

  const title = normalizeRoleTitle(job.jobTitle);
  const excluded = (prefs.excludedRolePatterns ?? []).find((p) => {
    try {
      return new RegExp(p, "i").test(title);
    } catch {
      return title.includes(p.toLowerCase());
    }
  });
  if (excluded) return { jobFamily: family, targetRoleCompatible: false, reason: `title matches excludedRolePatterns '${excluded}'`, confidence, evidence };
  const compatible = accepted.has(family);
  return {
    jobFamily: family,
    targetRoleCompatible: compatible,
    reason: `${basis}; ${compatible ? "accepted" : "not accepted"} by target roles (${[...accepted].join(", ") || "none configured"})`,
    confidence,
    evidence,
  };
}
