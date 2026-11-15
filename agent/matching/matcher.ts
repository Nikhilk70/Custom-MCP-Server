import type { MatchingConfig } from "../core/config.ts";
import type { JobRecord, JobRequirements, MatchResult, SkillLevel } from "../core/schemas.ts";
import { normalizeCompany, normalizeTitle, tokenSet } from "../core/text.ts";
import { professionalMonths, SkillIndex, type Profile } from "../profile/profile.ts";
import { catalogEntry } from "./skillCatalog.ts";
import { locationMatches } from "./location.ts";
import { classifyRole } from "./roleClassifier.ts";

type Component = { weight: number; score: number; detail: string };

function lookupSkill(index: SkillIndex, jdSkill: string) {
  const entry = catalogEntry(jdSkill);
  for (const name of [jdSkill, ...(entry?.aliases ?? [])]) {
    const hit = index.lookup(name);
    if (hit) return hit;
  }
  return null;
}

function skillCoverage(skills: string[], index: SkillIndex, credit: MatchingConfig["proficiencyCredit"]) {
  const matched: MatchResult["matchedSkills"] = [];
  const missing: string[] = [];
  let total = 0;
  for (const sk of skills) {
    const hit = lookupSkill(index, sk);
    if (!hit) {
      missing.push(sk);
      continue;
    }
    const level: SkillLevel = hit.level;
    total += credit[level];
    matched.push({ skill: sk, level, profileSkill: hit.skill.name, contexts: hit.skill.contexts });
  }
  return { matched, missing, ratio: skills.length ? total / skills.length : null };
}

function titleScore(jobTitle: string, targetRoles: string[]): { score: number; best: string | null } {
  const job = tokenSet(normalizeTitle(jobTitle));
  let best = 0;
  let bestRole: string | null = null;
  for (const role of targetRoles) {
    const target = tokenSet(normalizeTitle(role));
    if (target.size === 0) continue;
    let hit = 0;
    for (const t of target) if (job.has(t)) hit++;
    const containment = hit / target.size; // share of the target role's words present in the job title
    if (containment > best) {
      best = containment;
      bestRole = role;
    }
  }
  return { score: best, best: bestRole };
}

function educationScore(reqs: string[], profile: Profile): { score: number | null; detail: string; risk: string | null } {
  if (reqs.length === 0) return { score: null, detail: "no education requirement stated", risk: null };
  const text = reqs.join(" ").toLowerCase();
  const levels = new Set(profile.education.map((e) => e.level));
  if (/master|m\.?\s?tech|m\.?\s?s\b|ph\.?\s?d|mca/.test(text) && !/bachelor|b\.?\s?e\b|b\.?\s?tech|or equivalent/.test(text)) {
    return levels.has("masters") || levels.has("doctorate")
      ? { score: 1, detail: "postgraduate degree required and held", risk: null }
      : { score: 0, detail: "postgraduate degree required; profile has none", risk: "requires a master's/PhD" };
  }
  if (!levels.has("bachelors")) return { score: 0.3, detail: "degree required; no bachelor's in profile", risk: "degree requirement not met" };
  const degree = profile.education.find((e) => e.level === "bachelors")?.degree ?? "";
  if (/computer science|\bcs\b|information technology|software/.test(text) && !/computer|information|software/i.test(degree)) {
    return { score: 0.7, detail: `JD asks for CS/IT-type degree; profile degree is '${degree}'`, risk: `degree field differs from JD (${degree})` };
  }
  return { score: 1, detail: `bachelor's degree held (${degree})`, risk: null };
}

/**
 * Explainable match score. Every component reports its weight, score and why.
 * Only skills present in MY_DATA earn credit; basic/learning skills earn partial credit.
 * Hard constraints are evaluated separately and override the score.
 */
export function matchJob(job: Pick<JobRecord, "jobTitle" | "companyName" | "location" | "workMode" | "jdText">, reqs: JobRequirements, profile: Profile, cfg: MatchingConfig, asOf = new Date()): MatchResult {
  const index = new SkillIndex(profile);
  const neutral = cfg.neutralScoreWhenUnknown;
  const risk: string[] = [];
  // Gates, in order. The technical score below is computed regardless and can never clear a failed gate.
  const role = classifyRole(job, profile.preferences);
  const gates: MatchResult["gates"] = { role: [], experience: [], mandatory: [], technical: [] };
  if (!role.targetRoleCompatible) gates.role.push(`${role.jobFamily}: ${role.reason}`);
  const hard = gates.mandatory;
  const evidence: string[] = [];
  const components: Record<string, Component> = {};

  // Skills
  const req = skillCoverage(reqs.requiredSkills, index, cfg.proficiencyCredit);
  const pref = skillCoverage(reqs.preferredSkills, index, cfg.proficiencyCredit);
  components.requiredSkills = {
    weight: cfg.weights.requiredSkills,
    score: req.ratio ?? neutral,
    detail: reqs.requiredSkills.length ? `${req.matched.length}/${reqs.requiredSkills.length} required skills evidenced` : "no recognizable required skills in JD",
  };
  components.preferredSkills = {
    weight: cfg.weights.preferredSkills,
    score: pref.ratio ?? neutral,
    detail: reqs.preferredSkills.length ? `${pref.matched.length}/${reqs.preferredSkills.length} preferred skills evidenced` : "no preferred skills listed",
  };
  if (!reqs.requiredSkills.length) risk.push("JD skills could not be identified; score is low-confidence");
  for (const m of [...req.matched, ...pref.matched]) {
    evidence.push(`${m.skill} ← MY_DATA skill '${m.profileSkill}' (${m.level}; ${m.contexts.join("/")})`);
    if (m.level !== "verified") risk.push(`${m.skill} is only '${m.level}' in profile`);
    else if (!m.contexts.some((c) => c === "professional" || c === "internship")) risk.push(`${m.skill} evidenced only via ${m.contexts.join("/")}, not employment`);
  }

  // Title
  const t = titleScore(job.jobTitle, profile.preferences.targetRoles);
  components.titleSimilarity = { weight: cfg.weights.titleSimilarity, score: t.score, detail: t.best ? `closest target role: ${t.best}` : "no target role overlap" };

  // Experience (professional months only, from verified dates)
  const exp = professionalMonths(profile, asOf);
  const userYears = exp.months / 12;
  let expScore = neutral;
  let expDetail = "JD states no experience requirement";
  if (reqs.minYearsExperience !== null) {
    const min = reqs.minYearsExperience;
    expScore = min <= userYears ? 1 : Math.max(0, 1 - (min - userYears) / 3);
    expDetail = `JD: '${reqs.experienceText ?? ""}' (min ${min}y); profile: ${userYears.toFixed(1)}y professional`;
    if (min > cfg.hardConstraints.maxRequiredYearsExperience) gates.experience.push(`requires ${min}+ years (limit ${cfg.hardConstraints.maxRequiredYearsExperience})`);
    else if (min > userYears) risk.push(`asks for ${min}y; profile has ${userYears.toFixed(1)}y professional (internship not counted)`);
    // "3 years of Java": total professional years are only an upper bound for years in one skill or domain.
    if (reqs.experienceText && /years?\b[^.]{0,40}\b(?:in|with|of|using)\s+(?!experience\b|professional\b|relevant\b|industry\b|software\b|work\b)[a-z]/i.test(reqs.experienceText)) {
      risk.push(`JD asks for years in a specific skill/domain ('${reqs.experienceText}'); only total professional years are verified`);
    }
  }
  components.experience = { weight: cfg.weights.experience, score: expScore, detail: expDetail };

  // Location
  const loc = locationMatches(job.location, job.workMode, profile.preferences.preferredLocations, profile.preferences.excludedLocations);
  components.location = { weight: cfg.weights.location, score: loc.matches ? 1 : 0, detail: loc.reason };
  if (!loc.matches && cfg.hardConstraints.requireLocationMatch) hard.push(loc.reason);

  // Work mode
  const wm = job.workMode;
  const wmPref = wm ? profile.preferences.workModePreferences[wm] : null;
  components.workMode = {
    weight: cfg.weights.workMode,
    score: wm === null || wmPref === null ? neutral : wmPref ? 1 : 0,
    detail: wm === null ? "work mode not stated" : wmPref === null ? `${wm}: preference unknown` : `${wm}: ${wmPref ? "accepted" : "not accepted"}`,
  };
  if (wm && wmPref === false) hard.push(`work mode ${wm} not accepted`);

  // Education
  const edu = educationScore(reqs.educationRequirements, profile);
  components.education = { weight: cfg.weights.education, score: edu.score ?? neutral, detail: edu.detail };
  if (edu.risk) risk.push(edu.risk);

  // Hard constraints from preferences
  const title = job.jobTitle.toLowerCase();
  if (cfg.hardConstraints.rejectExcludedTitleKeywords) {
    // excludedJobTitleKeywords is the seniority filter (senior, lead, manager…), so it belongs to the experience gate.
    const bad = profile.preferences.excludedJobTitleKeywords.find((k) => new RegExp(`(^|[^a-z])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(title));
    if (bad) gates.experience.push(`title contains excluded seniority keyword '${bad}'`);
  }
  if (cfg.hardConstraints.rejectExcludedCompanies) {
    const c = normalizeCompany(job.companyName);
    if (profile.preferences.companyPreferences.excludedCompanies.some((x) => normalizeCompany(x) === c)) hard.push(`company ${job.companyName} is excluded`);
  }
  if (cfg.hardConstraints.rejectExcludedTechnologies) {
    const ex = profile.preferences.excludedTechnologies.filter((x) => reqs.requiredSkills.some((r) => r.toLowerCase() === x.toLowerCase()));
    if (ex.length) hard.push(`requires excluded technologies: ${ex.join(", ")}`);
  }
  if (cfg.hardConstraints.rejectIfJdMissing && !job.jdText) hard.push("job description unavailable");
  if (reqs.requiredSkills.length >= 3 && req.ratio !== null && req.ratio < cfg.hardConstraints.minimumRequiredSkillCoverage) {
    hard.push(`required-skill coverage ${(req.ratio * 100).toFixed(0)}% < ${(cfg.hardConstraints.minimumRequiredSkillCoverage * 100).toFixed(0)}%`);
  }

  const totalWeight = Object.values(components).reduce((a, c) => a + c.weight, 0) || 1;
  const score = Math.round((Object.values(components).reduce((a, c) => a + c.weight * c.score, 0) / totalWeight) * 100);
  const minScore = profile.preferences.minMatchScore ?? cfg.minimumMatchScore;
  if (score < minScore) gates.technical.push(`technical score ${score} below minimum ${minScore}`);

  const excludedByPattern = !role.targetRoleCompatible && role.reason.startsWith("title matches excludedRolePatterns");
  const eligibilityReason: MatchResult["eligibilityReason"] = gates.role.length
    ? excludedByPattern ? "ROLE_EXCLUDED_PATTERN" : "ROLE_FAMILY_INCOMPATIBLE"
    : gates.experience.length ? "EXPERIENCE_INCOMPATIBLE"
    : gates.mandatory.length ? "MANDATORY_REQUIREMENT_FAILED"
    : gates.technical.length ? "BELOW_TECHNICAL_THRESHOLD"
    : null;
  const eligible = eligibilityReason === null;
  const blocking = [...gates.role, ...gates.experience, ...gates.mandatory];

  const reason = [
    eligibilityReason ?? "ELIGIBLE",
    `role ${role.jobFamily}`,
    `tech ${score}%`,
    reqs.requiredSkills.length ? `skills ${req.matched.map((m) => m.skill).join(", ") || "none"} of ${reqs.requiredSkills.length} required` : "skills unclear",
    req.missing.length ? `missing ${req.missing.slice(0, 6).join(", ")}` : null,
    t.best ? `title≈${t.best}` : null,
    reqs.minYearsExperience !== null ? `exp ${reqs.minYearsExperience}y+` : null,
    loc.reason,
    blocking.length ? `BLOCKED: ${blocking.join("; ")}` : score < minScore ? `below min ${minScore}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    score,
    technicalMatchScore: score,
    role,
    roleCompatibility: gates.role.length ? "INCOMPATIBLE" : "COMPATIBLE",
    experienceCompatibility: gates.experience.length ? "INCOMPATIBLE" : "COMPATIBLE",
    gates,
    eligibilityStatus: eligible ? "ELIGIBLE" : "NOT_ELIGIBLE",
    eligibilityReason,
    reason,
    matchedSkills: [...req.matched, ...pref.matched],
    missingSkills: [...req.missing, ...pref.missing],
    supportingEvidence: evidence,
    riskFlags: [...new Set(risk)],
    components,
    hardConstraintFailures: blocking,
    eligible,
  };
}
