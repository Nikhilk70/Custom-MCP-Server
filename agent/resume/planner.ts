import type { JobRequirements, MatchResult } from "../core/schemas.ts";
import { SKILL_CATEGORIES, SkillIndex, type Profile, type SkillCategory } from "../profile/profile.ts";
import { detectSkills } from "../matching/skillCatalog.ts";

export interface ResumePlan {
  jobId: string;
  jobTitle: string;
  companyName: string;
  summaryAdjustments: Array<{ action: "reorder"; order: number[]; reason: string }>;
  skillsToEmphasize: string[];
  skillCategoryOrder: SkillCategory[];
  projectsToPrioritize: Array<{ projectId: string; relevance: number; matchedSkills: string[] }>;
  experienceBulletsToEmphasize: Array<{ experienceId: string; order: number[]; matchedSkills: string[] }>;
  projectBulletOrder: Record<string, number[]>;
  skillsNotSupported: string[];
  forbiddenClaims: string[];
  sourceTrace: Array<{ element: string; source: "USER_PROFILE" | "JOB_DESCRIPTION" | "CONFIG" | "DETERMINISTIC_TRANSFORMATION"; detail: string }>;
}

/** JD skills translated to the user's own skill names (only those MY_DATA supports). */
function jdSkillsInProfileTerms(reqs: JobRequirements, match: MatchResult): { required: Set<string>; all: Set<string> } {
  const required = new Set<string>();
  const all = new Set<string>();
  for (const m of match.matchedSkills) {
    all.add(m.profileSkill);
    if (reqs.requiredSkills.includes(m.skill)) required.add(m.profileSkill);
  }
  return { required, all };
}

function relevanceOfText(text: string, index: SkillIndex, wanted: Set<string>): { score: number; skills: string[] } {
  const skills = detectSkills(text)
    .map((s) => index.lookup(s)?.skill.name)
    .filter((s): s is string => !!s && wanted.has(s));
  return { score: new Set(skills).size, skills: [...new Set(skills)] };
}

/** Stable order: higher score first, original index as tiebreaker (never reshuffles irrelevant items). */
function rank(scores: number[]): number[] {
  return scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.i);
}

export function buildResumePlan(job: { jobId: string; jobTitle: string; companyName: string }, reqs: JobRequirements, match: MatchResult, profile: Profile, rules: { maxProjects: number }): ResumePlan {
  const index = new SkillIndex(profile);
  const { required, all } = jdSkillsInProfileTerms(reqs, match);
  const trace: ResumePlan["sourceTrace"] = [];

  const summaryScores = profile.professional.summaryFacts.map((f) => relevanceOfText(f, index, all).score);
  const summaryOrder = rank(summaryScores);
  trace.push({ element: "summary", source: "USER_PROFILE", detail: "sentences copied from professional.summaryFacts; order by JD skill overlap" });

  const skillsToEmphasize = [...required, ...[...all].filter((s) => !required.has(s))];
  const catScores = SKILL_CATEGORIES.map((c) => profile.skills[c].filter((s) => all.has(s.name)).length);
  const skillCategoryOrder = rank(catScores).map((i) => SKILL_CATEGORIES[i] as SkillCategory);
  trace.push({ element: "skills", source: "USER_PROFILE", detail: "only MY_DATA skills rendered; JD-matched skills listed first" });

  const projects = profile.projects.map((p) => {
    const skills = p.technologies.filter((t) => all.has(index.lookup(t)?.skill.name ?? t));
    const bulletRel = p.achievements.map((a) => relevanceOfText(a, index, all).score);
    return { projectId: p.id, relevance: skills.length + bulletRel.reduce((a, b) => a + b, 0) * 0.5, matchedSkills: skills, bulletOrder: rank(bulletRel) };
  });
  const projectsToPrioritize = [...projects].sort((a, b) => b.relevance - a.relevance).slice(0, Math.max(rules.maxProjects, 0) || projects.length);
  trace.push({ element: "projects", source: "USER_PROFILE", detail: "projects copied verbatim from projects.json; ordered by technology overlap" });

  const experienceBulletsToEmphasize = profile.experience.map((e) => {
    const rel = e.verifiedResponsibilities.map((r) => relevanceOfText(r, index, all));
    return { experienceId: e.id, order: rank(rel.map((r) => r.score)), matchedSkills: [...new Set(rel.flatMap((r) => r.skills))] };
  });
  trace.push({ element: "experience", source: "USER_PROFILE", detail: "responsibilities copied verbatim; bullet order by JD relevance" });
  trace.push({ element: "relevance", source: "JOB_DESCRIPTION", detail: `JD skills: ${[...reqs.requiredSkills, ...reqs.preferredSkills].join(", ") || "none detected"}` });

  const unsupported = match.missingSkills;
  return {
    jobId: job.jobId,
    jobTitle: job.jobTitle,
    companyName: job.companyName,
    summaryAdjustments: [{ action: "reorder", order: summaryOrder, reason: "most JD-relevant verified sentence first" }],
    skillsToEmphasize,
    skillCategoryOrder,
    projectsToPrioritize: projectsToPrioritize.map(({ projectId, relevance, matchedSkills }) => ({ projectId, relevance, matchedSkills })),
    experienceBulletsToEmphasize,
    projectBulletOrder: Object.fromEntries(projects.map((p) => [p.projectId, p.bulletOrder])),
    skillsNotSupported: unsupported,
    forbiddenClaims: unsupported.map((s) => `Do not claim ${s}: not present in MY_DATA`),
    sourceTrace: trace,
  };
}
