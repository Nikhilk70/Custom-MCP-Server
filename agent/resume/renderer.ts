import type { ResumeConfig } from "../core/config.ts";
import type { Profile, Skill, SkillCategory } from "../profile/profile.ts";
import { latexEscape as e, latexUrl } from "./latex.ts";
import type { ResumePlan } from "./planner.ts";

/**
 * Renders MY_DATA into the user's template macros (\resumeSubheading, \resumeItem, \resumeProjectHeading,
 * \resumeProjectTech, \resumeCertHeading). Only MY_DATA text is emitted; every string is LaTeX-escaped.
 */

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  languages: "Programming",
  frontend: "Frontend",
  backend: "Backend \\& APIs",
  frameworks: "Frameworks",
  databases: "Databases",
  ai: "AI \\& Data",
  devops: "DevOps \\& Cloud",
  tools: "Tools",
  other: "Software Engineering",
};

function monthName(ym: string | null): string | null {
  if (!ym) return null;
  const [y, m] = ym.split("-");
  if (!m) return y ?? null;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

function dateRange(start: string | null, end: string | null, current: boolean): string {
  const s = monthName(start);
  const en = current ? "Present" : monthName(end);
  if (s && en) return `${s} -- ${en}`;
  return s ?? en ?? "";
}

const href = (url: string, label: string) => `\\href{${latexUrl(url)}}{${e(label)}}`;
const displayUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function skillLabel(s: Skill): string {
  if (s.level === "basic") return `${e(s.name)} (Basics)`;
  if (s.level === "learning") return `${e(s.name)} (Learning)`;
  return e(s.name);
}

function reorder<T>(items: T[], order: number[] | undefined): T[] {
  if (!order || order.length !== items.length) return items;
  return order.map((i) => items[i]).filter((x): x is T => x !== undefined);
}

/** Identity block: verbatim from MY_DATA/Personal, in the template's icon style. Never tailored. */
export function renderHeader(p: Profile): string {
  const pr = p.personal;
  const place = [pr.city, pr.state].filter(Boolean).join(", ");
  const line1 = [pr.phone ? `\\faPhone\\ ${e(pr.phone)}` : null, pr.email ? `\\faEnvelope\\ ${href(`mailto:${pr.email}`, pr.email)}` : null, place ? `\\faMapMarker*\\ ${e(place)}` : null].filter(Boolean);
  const line2 = [
    pr.linkedin ? `\\faLinkedin\\ ${href(pr.linkedin, displayUrl(pr.linkedin))}` : null,
    pr.github ? `\\faGithub\\ ${href(pr.github, displayUrl(pr.github))}` : null,
    pr.portfolio ? `\\faGlobe\\ ${href(pr.portfolio, displayUrl(pr.portfolio))}` : null,
  ].filter(Boolean);
  return [
    "\\begin{center}",
    `    {\\Huge \\textbf{${e((pr.fullName ?? "").toUpperCase())}}}`,
    "    \\vspace{3pt}",
    "",
    line1.length ? `    \\small\n    ${line1.join("\n    \\hspace{8pt}\n    ")}` : null,
    "",
    "    \\vspace{2pt}",
    "",
    line2.length ? `    \\small\n    ${line2.join("\n    \\hspace{8pt}\n    ")}` : null,
    "\\end{center}",
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

export function renderSummary(p: Profile, plan: ResumePlan | null, override?: string): string {
  if (override) return e(override);
  return reorder(p.professional.summaryFacts, plan?.summaryAdjustments[0]?.order).map(e).join(" ");
}

export function renderSkills(p: Profile, plan: ResumePlan | null, rules: ResumeConfig["generationRules"]): string {
  const order = rules.reorderSkills && plan ? plan.skillCategoryOrder : (Object.keys(CATEGORY_LABELS) as SkillCategory[]);
  const lines: string[] = [];
  for (const cat of order) {
    let skills = p.skills[cat].filter((s) => rules.includeLearningSkills || s.level !== "learning");
    if (!skills.length) continue;
    if (rules.reorderSkills && plan) {
      const rankOf = (s: Skill) => {
        const i = plan.skillsToEmphasize.indexOf(s.name);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      skills = skills.map((s, i) => ({ s, i })).sort((a, b) => rankOf(a.s) - rankOf(b.s) || a.i - b.i).map((x) => x.s);
    }
    lines.push(`\\noindent\n\\textbf{${CATEGORY_LABELS[cat]}:}\n${skills.map(skillLabel).join(", ")}\n\\par`);
  }
  return lines.join("\n\n");
}

export function renderExperience(p: Profile, plan: ResumePlan | null, rules: ResumeConfig["generationRules"]): string {
  const bulletOrder = (id: string) => (rules.reorderExperienceBullets ? plan?.experienceBulletsToEmphasize.find((x) => x.experienceId === id)?.order : undefined);
  // Employment first, then internships/training — labels come from MY_DATA and are never upgraded.
  const entries = [...p.experience.filter((x) => x.type === "professional"), ...p.experience.filter((x) => x.type !== "professional")];
  const blocks = entries.map((x) =>
    [
      "\\resumeSubheading",
      `{${e(x.company)}}`,
      `{${e(dateRange(x.startDate, x.endDate, x.current))}}`,
      `{${e(x.role)}}`,
      `{${e(x.location ?? "")}}`,
      "",
      "\\resumeItemListStart",
      ...reorder(x.verifiedResponsibilities, bulletOrder(x.id)).map((r) => `\\resumeItem{${e(r)}}`),
      "\\resumeItemListEnd",
    ].join("\n"),
  );
  return ["\\resumeSubHeadingListStart", "", ...blocks.map((b) => `${b}\n`), "\\resumeSubHeadingListEnd"].join("\n");
}

export function renderProjects(p: Profile, plan: ResumePlan | null, rules: ResumeConfig["generationRules"]): string {
  let projects = p.projects;
  if (plan) {
    const order = plan.projectsToPrioritize.map((x) => x.projectId);
    const ranked = order.map((id) => projects.find((x) => x.id === id)).filter((x): x is (typeof projects)[number] => !!x);
    const rest = projects.filter((x) => !order.includes(x.id));
    projects = rules.dropIrrelevantProjects ? ranked : [...ranked, ...rest];
  }
  if (rules.maxProjects > 0 && rules.dropIrrelevantProjects) projects = projects.slice(0, rules.maxProjects);
  const blocks = projects.map((x) =>
    [
      "\\resumeProjectHeading",
      `{\\textbf{${e(x.name)}}}`,
      `{${x.links[0] ? `\\href{${latexUrl(x.links[0])}}{\\underline{Source Code}}` : ""}}`,
      "",
      `\\resumeProjectTech{${e(x.technologies.join(", "))}}`,
      "",
      "\\resumeProjectItemListStart",
      ...reorder(x.achievements, plan?.projectBulletOrder[x.id]).map((a) => `\\resumeItem{${e(a)}}`),
      "\\resumeProjectItemListEnd",
    ].join("\n"),
  );
  return ["\\resumeSubHeadingListStart", "", ...blocks.map((b) => `${b}\n`), "\\resumeSubHeadingListEnd"].join("\n");
}

export function renderEducation(p: Profile): string {
  const blocks = p.education.map((x) =>
    ["\\resumeSubheading", `{${e(x.institution)}}`, `{${e([x.startDate, x.endDate].filter(Boolean).join(" -- "))}}`, `{${e(x.degree)}}`, `{${e(x.cgpaOrPercentage ?? "")}}`].join("\n"),
  );
  return ["\\resumeSubHeadingListStart", "", ...blocks.map((b) => `${b}\n`), "\\resumeSubHeadingListEnd"].join("\n");
}

/** Certifications only (the template has no achievements section; achievements are not relabelled as certifications). */
export function renderCertifications(p: Profile): string {
  return p.certifications.entries
    .map((c) => {
      const left = [e(c.name), c.issuer ? e(c.issuer) : null, c.date ? e(c.date) : null].filter(Boolean).join(" -- ");
      return `\\resumeCertHeading\n{${left}}\n{${c.credentialUrl ? `\\href{${latexUrl(c.credentialUrl)}}{\\underline{LINK}}` : ""}}`;
    })
    .join("\n\n");
}

export function renderAll(p: Profile, plan: ResumePlan | null, cfg: ResumeConfig, summaryOverride?: string): Record<string, string> {
  const rules = cfg.generationRules;
  return {
    HEADER: renderHeader(p),
    SUMMARY: renderSummary(p, plan, summaryOverride),
    SKILLS: renderSkills(p, plan, rules),
    EXPERIENCE: renderExperience(p, plan, rules),
    PROJECTS: renderProjects(p, plan, rules),
    EDUCATION: renderEducation(p),
    CERTIFICATIONS: renderCertifications(p),
  };
}

/** MY_DATA content the current template has no section for — recorded in metadata, never silently dropped. */
export function omittedByTemplate(p: Profile): string[] {
  return [
    ...(p.personal.headline ? [`headline: ${p.personal.headline}`] : []),
    ...p.certifications.achievements.map((a) => `achievement: ${a.name} — ${a.context} (${a.date ?? ""})`),
    ...p.professional.softSkills.map((s) => `additional: ${s}`),
  ];
}
