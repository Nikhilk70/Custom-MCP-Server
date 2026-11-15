# AUTO-JOB-AGENT — Architecture

## 1. Overview

```
                        ┌──────────────────────────── config/*.json + .env ────────────────────────────┐
                        │                                                                               │
  Companies/**/company.json ──► companyScanner ──► CompanyCareerAdapter ──┬─ Greenhouse / Lever /      │
                                                    (CompanySource)       │  Ashby / SmartRecruiters   │
                                                                          └─ Firecrawl (careers page,  │
  LinkedIn / portals (JobSource) ── NOT CONFIGURED / UNSUPPORTED             evidence-verified)        │
                        │                                                                               │
                        ▼                                                                               │
     normalize ─► dedupe/upsert ─► Google Sheet (the only database) ◄──── state machine + Timeline ───┤
                        │                    │   ▲                                                      │
                        ▼                    │   │                                                      │
     JD fetch (source JD │ Firecrawl) ─► jdAnalyzer ─► matcher (explainable, hard constraints)          │
                        │                                                                               │
                        ▼                                                                               │
   planner ─► renderer (MY_DATA only) ─► patch master.tex AUTO markers ─► tex checks                    │
                        │                                                                               │
                        ▼                                                                               │
   ResumeProvider: Overleaf MCP (NOT CONFIGURED) │ local pdfLaTeX ─► PDF checks ─► Generated/…          │
                        │                                                                               │
                        ▼                                                                               │
   Playwright: locate application form ─► classify fields ─► question bank (trust levels) ─► fill       │
              ─► validate ─► submission gate (mode, dry run) ─► submit ─► evidence ─► APPLIED/UNVERIFIED│
                        │                                                                               │
                        ▼                                                                               │
   Dashboard = the jobs tab itself (no separate sync)   Daily report (tab + Applications/Reports)   MCP ─┘
```

**Layers**
- `agent/`: business logic. It depends only on the interfaces in `agent/core/interfaces.ts`.
- `integrations/`: adapters for external systems (ATS APIs, Firecrawl, Playwright, Sheets, LaTeX, Overleaf, AI, LinkedIn, portals).
- `mcp/auto-job-agent/`: the orchestration MCP server (stdio).
- `agent/orchestration/container.ts`: the only place that picks concrete implementations.

## 2. Module responsibilities

| Module | Responsibility |
|---|---|
| `agent/core` | env and config validation (zod), paths, structured JSONL logger with secret masking, error codes, bounded retry, HTTP client, text normalization, domain schemas, adapter interfaces |
| `agent/store` | Google Sheets store: typed tables over tabs (`table.ts`), tab schemas plus batched open/flush, lock and sequences (`sheetStore.ts`), the job state machine and timeline, repositories |
| `agent/profile` | MY_DATA loading and validation, the skill evidence index, and **source verification**: every fact must appear in the resume text |
| `agent/discovery` | company directory scan, company search, relevance filter, raw persistence, ingestion |
| `agent/normalization` | canonical identity (company/title/location/URL/JD hash) and the dedupe/upsert logic with provenance |
| `agent/matching` | skill catalog, JD requirement extraction, location rules, the explainable matcher, the JD-fetch and match services |
| `agent/resume` | LaTeX primitives (escape, markers, validation, diff), template baseline guard, planner, renderer, validators, generator |
| `agent/questions` | question bank loading, matching (patterns + autocomplete), answer resolution with trust levels |
| `agent/application` | form detection (DOM/accessibility), application-form isolation, field classification, filling, the engine |
| `agent/validation` | button classification, the submission gate, submission evidence |
| `agent/reporting` | the daily report (Markdown/JSON files plus a row in the `Daily Reports` tab) |
| `agent/orchestration` | DI container, runs and steps (resumable), daily run, scheduler, preflight |

## 3. Database: Google Sheets only

There is no SQLite and no local database file. The spreadsheet at `GOOGLE_SHEETS_SPREADSHEET_ID` is the only database.

**Tabs.** The jobs table **is your dashboard tab** (`GOOGLE_SHEETS_TAB`, otherwise the first non-system tab):
- Your 14 columns (Date Added … Status) stay exactly where they are.
- System columns are appended to the right: Job ID, External Job ID, JD Hash, Resume Version, Resume File, Application Attempts, Last Attempt, Applied Date, Requires Human, Block Reason, Last Error, Job URL, Company ID, Company Domain, Created At, Updated At.

System tabs are created automatically on first use:

| Tab | Key | Contents |
|---|---|---|
| Job Details | Job ID | full JD text, extracted requirements JSON, latest match JSON (kept out of the dashboard to keep it readable) |
| Job Sources | Source Key | provenance: every source that listed the job, first/last seen, seen count |
| Companies | Company ID | mirror of `Companies/`, ATS, board token, last successful search |
| Company Searches | ID | one row per company per search: status, found, relevant, new, duplicates, error |
| Timeline | ID | append-only STATUS transitions and TIMELINE milestones (the queryable history) |
| Resume Versions | Resume Version ID | status, paths, compiler, template SHA, validation checks |
| Applications | Job ID | one per job: mode, attempts, timestamps, evidence, form report, screenshot path |
| Answer Log | ID | every field decision (answer preview masked for sensitive/legal fields) |
| Runs / Run Steps | Run ID / Step Key | run bookkeeping for resumable runs |
| Errors | ID | every recorded failure with its code |
| Daily Reports | ID | one row per run |
| Meta | Name | counters (`seq:job`, `seq:resume`) and the advisory `lock` |

**How reads and writes work** (`agent/store/sheetStore.ts`):
- **Open:** one `listTabs`, one `addTabs` if any are missing, and **one batched read of every tab**. All queries then run in memory.
- **Flush** happens at checkpoints: after every run step, after every resume and application, and at least every 30 s inside long loops. It is one batched key-column read to re-locate rows, one batched cell write, and one append per tab with new rows. Flushes are serialized.
- **Only cells whose value changed are written.** Columns you add, and cells you edit in other columns, are never overwritten.
- **Rows are re-located by key before writing**, so sorting, filtering or inserting rows in the sheet can't cause a write to the wrong row. A row you deleted is re-appended, with a warning.
- **Crash safety:** changes are snapshotted when a flush is planned, and restored if the write fails. Edits made while a write is in flight are kept for the next flush.
- **Your own rows:** a dashboard row you typed yourself with the same Apply Link and no Job ID is **adopted**, not duplicated.
- **Manual edits:** if you type an unknown value into Status, that job becomes NEEDS_HUMAN, with a warning.
- **Formulas:** values are written RAW, so text from a job posting can never become a formula.
- **Cell limit:** cells are capped below Sheets' 50,000-character limit. Very long JDs are truncated, with a marker saying so.
- **Quota:** Sheets allows about 60 requests/min, so calls are throttled to at least 1.1 s apart and retried with backoff on 429/5xx.
- **Locking:** an advisory lock in `Meta` stops a scheduled run and a manual or MCP write from running at the same time. A lock older than 2 h is treated as stale.

**Not in the database:** files that are artifacts rather than records. That means raw source payloads (`Jobs/Raw`, kept as evidence), generated resumes, screenshots, logs, report files, and the question bank and MY_DATA, which are your hand-edited inputs.

## 4. State machine

```
DISCOVERED → NORMALIZED → JD_FETCHED → MATCHED → READY_FOR_RESUME → RESUME_GENERATING → RESUME_GENERATED → READY_TO_APPLY
                                     ↘ NOT_MATCHED                        ↘ BLOCKED (no compiler / template changed)
                                                                           ↘ FAILED (compile / validation)
READY_TO_APPLY → APPLYING → FORM_DETECTED → FORM_FILLED → SUBMITTING → APPLIED            (confirmation verified)
                    ↘ NEEDS_HUMAN (CAPTCHA/OTP/login/no form)  ↘ VALIDATION_FAILED → NEEDS_HUMAN  ↘ SUBMISSION_UNVERIFIED
                                                   FORM_FILLED → READY_TO_APPLY (dry run)   ↘ NEEDS_HUMAN (review mode / gate)
```
`match --rematch` re-evaluates every job that hasn't been submitted. A job that is no longer ELIGIBLE moves to `NOT_MATCHED` from wherever it is in the queue (READY_FOR_RESUME, RESUME_GENERATED, READY_TO_APPLY, NEEDS_HUMAN, BLOCKED, FAILED).

The allowed transitions live in `agent/store/stateMachine.ts`. Anything else throws `INVALID_TRANSITION`. Every transition writes an event. `APPLIED` is terminal and is reachable only from `SUBMITTING` with verified confirmation, or through `mark-applied`, which is your own confirmation of a manual submission and requires evidence text.

## 5. MCP architecture

`mcp/auto-job-agent/server.ts` uses `@modelcontextprotocol/server` v2 (stdio) with zod schemas. It exposes 16 tools: `get_integration_status`, `search_companies`, `discover_jobs`, `match_jobs`, `get_job`, `get_matching_jobs`, `analyze_job`, `generate_resume`, `compile_resume`, `match_application_questions`, `inspect_application`, `validate_application` (always dry run), `submit_application` (needs `confirm: true` and `DRY_RUN=false`), `get_application_status`, `get_run_status`, `get_report`. `fill_application` is not exposed separately because `validate_application` does fill-plus-validate without submitting. stdout carries only protocol messages; logs go to stderr and `Applications/Logs`. Outputs pass through the secret masker.

External MCPs (LinkedIn, Overleaf, Firecrawl) are **clients** declared in `config/mcp-servers.json`. `npm run mcp:inspect -- <name>` lists their real tools before any adapter is written.

## 6. Source adapters

| Source | Status | How |
|---|---|---|
| Greenhouse / Lever / Ashby / SmartRecruiters | working (verified live) | public JSON job-board APIs. A structured API is the only case where zero jobs counts as `SUCCESS_NO_JOBS` |
| Arbitrary careers page | working (verified live) | Firecrawl REST `scrape` with JSON extraction. A job is kept only if its title is in the page text **and** its URL is among the page links. An empty result is `PARSER_FAILED`, not success |
| Workday / SuccessFactors / iCIMS | `UNSUPPORTED` (detected) | falls back to careersUrl via Firecrawl if one is given |
| LinkedIn | `NOT_CONFIGURED` | no LinkedIn MCP on this machine. Password/cookie login is deliberately not implemented |
| Naukri, Indeed, Internshala, Glassdoor, Unstop | `UNSUPPORTED` | enabled in `.env`, but no adapter or MCP exists. See `integrations/portals/registry.ts` |

## 6a. Matching and eligibility

```
JD → role classification → role gate → experience gate → mandatory requirements → technical score → FINAL ELIGIBILITY → resume
```

- **Role classification** (`agent/matching/roleClassifier.ts`) assigns one of SOFTWARE_ENGINEERING, FRONTEND, BACKEND, FULLSTACK, DEVOPS, DATA, AI_ML, QA, SECURITY, EMBEDDED, ENTERPRISE_PLATFORM, SUPPORT, PRODUCT, DESIGN, HARDWARE, MECHANICAL, ELECTRICAL, CIVIL, FINANCE, HR, SALES or OTHER.
  - The **title** decides first (confidence 0.9); specific domains such as embedded, SAP or maintenance are checked before the generic software rules.
  - The JD is consulted only when the title is generic ("Software Engineer", "Engineer 3"). It can override the title only with ≥4 distinct domain terms that outnumber the software terms (confidence 0.7, or 0.6 with no usable title).
  - Keyword overlap with your skills never counts as role evidence.
- **Accepted families** come from `preferences.targetRoles`, classified with the same rules, or from `preferences.targetRoleFamilies` if set.
  - General knowledge widens them: a full-stack target also accepts backend, frontend and generic software roles.
  - `preferences.excludedRolePatterns` (title regexes) always reject.
  - OTHER is rejected unless you target it.
- **Gates**, each stored separately in the match (`gates.role|experience|mandatory|technical`):

  | Gate | Fails on | Code |
  |---|---|---|
  | Role | family not accepted / excluded pattern | `ROLE_FAMILY_INCOMPATIBLE` / `ROLE_EXCLUDED_PATTERN` |
  | Experience | JD minimum years above the limit; seniority keyword in the title | `EXPERIENCE_INCOMPATIBLE` |
  | Mandatory | location, work mode, excluded company/technology, missing JD, required-skill coverage | `MANDATORY_REQUIREMENT_FAILED` |
  | Technical | weighted score below `minMatchScore` | `BELOW_TECHNICAL_THRESHOLD` |

- `technicalMatchScore` is always computed and stored, but it never overrides a failed gate. A 74 on a maintenance role stays `NOT_ELIGIBLE`.
- The first failing gate is `eligibilityReason`, and it is the prefix of the job's Match Reason in the sheet.
- Experience uses verified professional dates only. Years in a specific skill or domain ("3 years of Java", "SaaS experience") are never derived from total years: in matching they are a risk flag, and in application questions they need an explicit `<subject>_years` bank answer or a human.
- **Guards:** `generateResume` and `processApplication` both refuse any job whose stored match is not `ELIGIBLE`. So an ineligible job never gets a resume, an upload or a place in the queue, even if its status was set by hand.

## 6b. Daily report funnel

Every job created or listed on the report date falls in exactly one bucket, so each level of the funnel adds up to its parent. The report checks the sums itself and prints any mismatch under "Inconsistent counts":

- Unique Jobs = Missing JD + Valid JDs
- Valid JDs = Pending match + Role-Incompatible + Role-Compatible
- Role-Compatible = Experience-Incompatible + Experience-Compatible
- Experience-Compatible = Not Eligible (mandatory or technical) + Fully Eligible
- Fully Eligible = Resume Eligible (no resume yet) + Resumes Generated
- Resumes Generated = Applications Queued + Needs Human + Submitted + Submission Unverified + Failed/Skipped

Raw Jobs and Duplicates come from the day's searches. Technical Matches is a cross-cut, not a bucket: jobs that scored at or above the minimum before the gates were applied, plus how many of those the role gate stopped.

## 7. Resume flow

1. `templateGuard` checks `master.tex` against its SHA-256 baseline (`Resume_Template/.baseline/`). Any change stops generation until `npm run template:approve`.
2. `planner` builds a ResumePlan from the JD match: emphasized skills, category order, bullet and project order, `skillsNotSupported`, `forbiddenClaims`, and a source trace.
3. `renderer` emits LaTeX **only from MY_DATA**, using the user template's macros. Text is escaped and bullets are copied verbatim.
4. `patchMarkers` replaces the `% === AUTO: X START/END ===` regions only.
5. `.tex` checks: structure, text outside the markers byte-identical to master, no technology absent from MY_DATA, no template-owner identifiers.
6. Compile: Overleaf MCP if configured, otherwise local pdfLaTeX. If neither is available, the job becomes `BLOCKED` with reason `RESUME_COMPILER_NOT_CONFIGURED`, and the `.tex` is still saved.
7. PDF checks (PyMuPDF): `%PDF` header, page count, the user's name/email/phone present, no foreign emails/phones/profile handles, no template-owner identifiers, expected sections present once.
8. Output goes to `Data_Resume/Generated/YYYY-MM-DD/JOB-ID/RV-…/`: `resume.tex`, `Company_JobTitle_JobId.pdf`, `resume-plan.json`, `changes.diff`, `metadata.json`, `validation.json`, `compile.log`.

## 8. Application flow

1. Open `applyUrl` in the agent's persistent profile. With `BROWSER_CHANNEL=chrome` that is your installed Google Chrome, on the agent's own profile (`runtime/browser-profile`), never your everyday profile.
2. **Blockers** (`blockerOf` + `clearBlockers` in `applicationEngine.ts`), checked on arrival, after the form is located, just before submit, and after submit:
   - **Payment** (a fee/pay-now text pattern, a card/UPI/bank field, or a visible payment-gateway frame; see `config/safety.json`): **hard stop**, `PAYMENT_REQUESTED`. Nothing is entered or authorized, and it is never waited out. Text patterns describe *paying*, not the topic, so fintech JDs that mention "payment gateway" or "UPI" don't trigger it.
   - **Visible CAPTCHA** (incl. DataDome/PerimeterX/Arkose sliders), **OTP**, **security/identity check**, **login**:
     - With a visible browser (`humanWait.enabled`, not headless), the agent logs "WAITING FOR YOU", polls until you've finished (up to `humanWait.timeoutMs`, 15 min), then **continues the same application from the page you left it on**.
     - Headless, or waiting turned off: `NEEDS_HUMAN` with a screenshot. Only that job pauses.
     - The agent never interacts with the CAPTCHA/OTP itself.
   - **Invisible CAPTCHA** (Lever's hidden hCaptcha, reCAPTCHA v3's badge): doesn't stop filling. With a visible browser a challenge appearing on submit is waited out as above; headless, the gate forbids automatic submit.
   - **Login → "Sign in with Google"** (`googleSignIn.ts`), when the site offers it:
     - The agent clicks the site's own button, picks `GOOGLE_SIGNIN_ACCOUNT` (default: MY_DATA email) in Google's account chooser only if it is listed, and clicks "Continue" only on a basic sign-in confirmation (name, email, language, picture).
     - It never types into a Google page. A password prompt, 2-step verification, "verify it's you", recovery, a chooser without the account, or extra permissions → you take over (waited for as above).
     - Success is verified on the site: no login prompt remains and no other account is shown. Then the same job's application continues.
     - The Google session comes from signing in once yourself with `npm run browser:login`: plain Chrome on the agent profile, no automation.
3. `locateApplicationForm`: isolate the application form (the one with a resume upload, or ≥3 fields) from newsletter and search forms. If no form is found, open at most **one** navigation: an embedded ATS form's own URL (Greenhouse `#grnhse_iframe`, as on mongodb.com), else an "Apply" link. Neither is ever a submission.
4. Classify each field: `KNOWN_SAFE`, `KNOWN_REQUIRES_REVIEW`, `UNKNOWN`, `SENSITIVE`, `LEGAL_OR_ELIGIBILITY`, `CAPTCHA`, `OTP` or `FILE_UPLOAD`. Answers come from the question bank with trust `VERIFIED_USER_DATA`, `DETERMINISTIC_DERIVED`, `AI_SUGGESTED` or `UNKNOWN`. Unknown answers are never filled.
5. Fill through the accessible label when it is unique, otherwise id, otherwise the tagged node.
   - **Labels** come from visible text only, so hidden status text is ignored. Question text sitting next to a control (Lever custom questions) is used when its container holds only that control.
   - **Required** also covers `*`, `✱` and `.required` markers.
   - Every value is read back from the DOM, then **re-checked after the page settles**, because autocompletes clear typed text and resume parsers overwrite fields.
   - A cleared autocomplete is retyped key by key, and the one list option whose first part equals the answer is clicked (Lever: "Bengaluru" → "Bengaluru, Bengaluru Urban, Karnataka, IND").
   - **Uploads** are confirmed by a file input holding the file, or by the file name shown on the page. An upload input labelled only by its button ("Attach") is named after its block heading ("Resume/CV").
   - **Custom dropdowns** (`COMBOBOX`: `role=combobox`, e.g. Greenhouse's react-select) are never typed into as text:
     - The list is opened, and the one option matching the verified answer is clicked. Matching is exact, else a unique exact leading part ("India" → "India +91"), else nothing.
     - The widget must then show the choice, or a part of it no other option contains ("+91").
     - Hidden validation inputs aren't fields; they only mark their combobox required.
6. Validate: the job and company are confirmed on the page, no required field is empty, the resume is attached, no unresolved field remains, and there is exactly one final-submit button. "Apply", "Next" and "Subscribe" are never treated as final.
7. The gate decides by mode:
   - `REVIEW_ONLY`: never submits.
   - `AUTO_FILL_REVIEW_SUBMIT`: submits only after an explicit YES.
   - `FULL_AUTO`: submits only if every filled field is `KNOWN_SAFE`, high-confidence and verified.
   - `DRY_RUN`: always blocks submission.
8. Evidence after clicking: confirmation text, which may include a reference ID, gives `APPLIED`. Validation errors mean the site rejected the submission, which gives `NEEDS_HUMAN`. Anything else gives `SUBMISSION_UNVERIFIED`.

## 9. Error handling and retries

`AgentError` carries a code. `withRetry` applies bounded budgets: network and timeout errors get 3 attempts with backoff, rate limits get 3, browser errors get 2, and parser errors get 1 controlled retry. CAPTCHA, OTP, authentication errors and unknown questions are never retried. Each company, job and step is isolated: failures are written to `errors`, the job's `last_error` and the logs, and the run continues. `runStep` records each step in the Run Steps tab and flushes to the sheet when the step finishes, so a re-run the same day resumes the interrupted run and skips finished steps.

## 10. Scheduler

`DailyScheduler` computes the next `HH:MM` in the configured IANA timezone (DST-safe) and skips a run if the previous one is still going. It is independent of the business logic: `npm run scheduler` for in-process scheduling, or Windows Task Scheduler running `npm run daily-run` (see README).

## 11. Google Sheets as dashboard and database

There is no separate sync step: every write goes straight to the sheet, and the jobs tab is both the table the agent reads and the dashboard you look at. Section 3 explains how the store keeps your layout, columns and manual edits intact.

## 12. Security

- Secrets live only in `.env`, which is gitignored, as are `config/google-*.json`, `runtime/`, MY_DATA and `Data_Resume/Source`. The spreadsheet holds your job data, so share it only with the service account you use. `.env.example` has names only.
- `SecretMasker` replaces known secret values and secret-looking keys in every log line and MCP response.
- No password-based login or cookie replay (LinkedIn), and no CAPTCHA/OTP handling of any kind.
- LLM output is untrusted: extracted job listings must be evidenced on the scraped page, and AI summary text must pass the fact check.

## 12a. ApplyPilot (web control center)

```
web/ (React + Vite, no business logic)  ──HTTP + SSE──▶  server/ (node:http, 127.0.0.1)
                                                          ├─ api.ts        routes → runtime / services
                                                          ├─ runtime.ts    AgentRuntime: queue worker, pause/resume/stop,
                                                          │                hand-offs, sessions, settings, live-mode guard
                                                          ├─ queue.ts / humanTasks.ts / notifications.ts / events.ts (JSON under runtime/state/applypilot)
                                                          ├─ answerBank.ts Application_Answers.txt CRUD (backups, CLI-compatible)
                                                          ├─ knowledge.ts  RAG service (agent/rag)
                                                          └─ demo/         in-memory DB + local mock job site
                                                                 │
                                                                 ▼  same engine as the CLI
                     agent/application/applicationEngine.ts (+ optional HumanBridge), matching, discovery, store
```
- **HumanBridge** (`agent/application/humanBridge.ts`) is optional; the CLI does not use it. With it, the engine:
  - reports progress;
  - honours pause/stop checkpoints before filling and before submitting;
  - raises CAPTCHA/OTP/login hand-offs, which the user's **Continue** makes it re-check at once (it also re-checks on its own);
  - asks the user required questions it has no trusted answer for, re-planning the form with their answers.

  Nothing in it can solve a verification step.
- **Queue**: strictly sequential and persistent. A job is never queued twice. An item that was running when the process died is marked FAILED for review, never re-run. Before each job the runtime checks:
  - duplicates (the job itself, or the same posting under another id);
  - eligibility and allowed/blocked companies;
  - the daily live limit.

  A job without a resume first gets one generated.
- **Live mode**: `dryRun=false` is set only for a run started with `live:true`, `confirm:"LIVE"` and live mode armed for this server session. Review mode maps to `AUTO_FILL_REVIEW_SUBMIT` with `approve()` becoming a REVIEW_SUBMIT task; unticking review maps to `FULL_AUTO`, still under the unchanged submission gate.
- **Field sources**: every FieldPlan carries `source`, shown per field in the UI:
  - APPLICATION_ANSWERS, HUMAN_ANSWER;
  - PROFILE, RESUME, QUESTION_BANK;
  - RESUME_FILE, AI_SUGGESTED.
- **Evidence**: an explicit site error after submit ("There was an error processing your application") is REJECTED. Otherwise the existing VERIFIED/UNVERIFIED rules apply, so no confirmation page means no "confirmed".
- **RAG** (`agent/rag`), in three layers:
  - `corpus.ts` builds chunks from the user's own records only (answers, MY_DATA, resume.txt, past filled answers) and flags sensitive ones.
  - `retriever.ts` does BM25 plus optional embeddings, fused by reciprocal rank, cached by content hash. Sensitive chunks are never embedded.
  - `suggest.ts` does deterministic matches first (written or past answers, the same phrasings the matcher uses), then an optional AI draft from the retrieved, non-sensitive chunks. Every suggestion passes `grounded()`: a subject- or city-specific question needs evidence naming that subject or city, and every number must appear in the sources. AI drafts must also cite valid chunks and map onto the form's options.

  Suggestions are displayed only. The form is filled only with answers the user submits.
- **Security**:
  - host allow-list (DNS rebinding) and a per-session token (header, or query string only for EventSource/img/file links);
  - no CORS, CSP on the app, body limits, and client file paths confined to their folders;
  - uploads checked to be PDFs;
  - activity messages masked with `SecretMasker` and never containing answer values.

## 13. Testing

`npm test` runs Vitest:
- **Store tests (in-memory spreadsheet, same code path as Google):** tab and header creation, header order kept, typed round-trip, idempotent flush, batching, re-location after a user sort, re-adding a deleted row, no lost edits during an in-flight flush, restore on failed write, invalid Status, cell clipping, the lock, job-ID safety.
- **Unit tests:** dedupe (including adopting a user-typed row), ATS parsers against real captured samples, matching, LaTeX, template guard, the fabrication and owner-leak checks, the question bank, field, button and gate logic, the state machine, retry, masking, the scheduler, Sheets idempotency, profile verification, and the company scanner.
- **Integration tests:** real headless Chromium against local fixture forms (submit and evidence, CAPTCHA, unknown/legal/salary questions, review-only, dry run, unverified submission, newsletter-form regression, Apply-link navigation), plus an end-to-end daily run with fake HTTP and a clearly labelled test-double compiler (failure isolation, dedupe on re-run, a fresh process seeing identical state from the sheet, compiler-blocked, owner-leak rejection, interrupted-run resume).
- **ApplyPilot:**
  - `tests/unit/applypilot.test.ts`: queue, human tasks, Answer Bank, answer matching, security helpers.
  - `tests/unit/rag.test.ts`: retrieval, grounding guards, AI-draft validation, sensitive-data exclusion.
  - `tests/integration/applypilot-runtime.test.ts`: every control path with a fake engine.
  - `tests/e2e/applypilot-demo.test.ts`: HTTP API + real engine + headless Chromium on the mock site (dry run, new question, verification hand-off, live confirm and reject, duplicate protection).
  - `tests/e2e/applypilot-ui.test.ts`: the built UI driven like a user.
- **Live checks:** `scripts/mcp-smoke.ts` exercises the MCP server over stdio. `npm run preflight` makes live credential checks.
