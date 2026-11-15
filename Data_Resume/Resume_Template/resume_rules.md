# Resume Generation Rules

These rules are enforced in code (`agent/resume/`). A rule marked **[validated]** is checked after
generation, and a failed check stops the resume from being marked `GENERATED`.

## Facts: never invent anything

1. Never invent skills. The generator only renders skills listed in `MY_DATA/Skills/skills.json`. **[validated]**: every technology the skill catalog finds in the generated sections must exist in MY_DATA.
2. Never invent work experience. Experience comes only from `MY_DATA/Experience/experience.json`.
3. Never invent projects. Projects come only from `MY_DATA/Projects/projects.json`.
4. Never invent dates. Dates are copied from MY_DATA. A missing date is left out, never estimated.
5. Never invent certifications. They come only from `MY_DATA/Certifications/certifications.json`.
6. Never invent achievements or metrics. Bullets are copied verbatim. Tailoring changes their order, not their words.
7. Never invent employment history. Internships and training stay labelled as internships and training.
8. Never claim professional experience for a technology MY_DATA doesn't support. Skill `contexts` (professional / internship / project / training / listed) are kept, and the matcher flags project-only skills.
9. Keep the basic/learning distinction. A skill at level `basic` renders as "(Basics)" and one at level `learning` renders as "(Learning)".
10. Never change identity. The HEADER is rendered verbatim from `MY_DATA/Personal/profile.json`. **[validated]**: the PDF text must contain the user's name, email and phone, and no other email address, phone number, or LinkedIn/GitHub handle.

## Template: structure only

11. Never alter the template layout unless you mean to. `master.tex` is protected by a SHA-256 baseline in `.baseline/`. If it changes, generation stops until `npm run template:approve` is run.
12. Never replace the whole document. Only the text between `% === AUTO: <NAME> START/END ===` markers is replaced.
13. Only change allowed content sections. SUMMARY, SKILLS, EXPERIENCE and PROJECTS may be reordered for the job. HEADER, EDUCATION, CERTIFICATIONS and ADDITIONAL are rendered from MY_DATA the same way every time. **[validated]**: the text outside the markers must be byte-identical to `master.tex`.
14. Keep packages, margins, fonts, section formatting and commands. This follows from rule 13.
15. Validate the LaTeX before compiling: balanced braces, matched `\begin`/`\end`, paired markers, and a document body. **[validated]**
16. Validate that the compiled PDF exists. **[validated]**: it must start with `%PDF`, open cleanly, and have no more than `maxPages` pages.
17. Save the final `.tex` for every generated resume in `Data_Resume/Generated/YYYY-MM-DD/JOB-ID/resume.tex`.
18. Save why the resume was tailored: `resume-plan.json`, `metadata.json`, `changes.diff` and `validation.json` are written next to it.

## What tailoring may do

- Reorder skill categories and the skills inside each category, putting the ones the job mentions first.
- Put the most relevant existing projects first, and drop projects beyond `maxProjects` only if `dropIrrelevantProjects=true`.
- Put the most relevant existing experience and project bullets first.
- Order the summary sentences by relevance. If `allowAiSummaryRewrite=true`, rephrase the summary with AI, but only when the result passes the fact check: every technology and number in it must already appear in MY_DATA.

## What tailoring must never do

Fabricate projects, years of experience, employment, certifications, technologies, metrics or responsibilities, or add a JD skill that MY_DATA doesn't contain. Such skills are listed in `resume-plan.json` as `skillsNotSupported` and `forbiddenClaims`.

## A generated resume is never a template

`Generated/**/resume.tex` is never copied back to `master.tex`.
