# TODO

## Needs you (credentials, decisions, installs)
- [ ] **Rotate the secrets pasted into chat after testing** (you said these are test accounts, so this can wait) (LinkedIn password, `li_at` cookie, Gemini key, Firecrawl key, Overleaf session and Git token, and the Google service-account private key). They are now in the conversation transcript.
- [x] **Resume compiler**: MiKTeX 25.12 installed (user scope), silent package install on, `LOCAL_LATEX_COMMAND` pinned to `pdflatex.exe` because `latexmk` needs Perl. The template test-compiled to a 1-page PDF.
- [ ] **Google Sheets (required: it is the database)**: put a service-account key (share the sheet with its `client_email` as Editor) or an OAuth Desktop client at `config/google-credentials.json`. For OAuth, then run `npm run sheets:auth`. Next run `npm run db:init`. Set `GOOGLE_SHEETS_TAB` if your job table isn't the first tab. **Until this is done, discover, match, generate-resumes, apply and daily-run all stop with NOT_CONFIGURED.**
- [x] **Companies**: 32 added (every board checked live through its public ATS API on 2026-09-30 and had India engineering openings then). Add more under `Companies/` (see `_TEMPLATE`), and set `"enabled": false` to skip one.
- [ ] **Unknown profile values** (`npm run preflight` lists them): salary expectation, notice period, relocation, hybrid/onsite preference, Maruti Flex location, Techbyheart dates. Add them to MY_DATA if you want them used.
- [ ] **Question bank**: answer work authorization, sponsorship, current CTC and "how did you hear" in `Application_Questions/*` (`"answer"` plus `"verified": true`) if you want them auto-filled. Confirm the derived last name (`"M P"`) by setting `sensitivity` to `"normal"` in `Personal/personal.json`.
- [ ] Decide whether the template should show the headline, the "1st Place" achievement and the soft-skills section. The uploaded template has no section for them, so they are omitted and listed in `metadata.json` → `omittedBecauseTemplateHasNoSection`.

## Integrations not configured (adapter boundaries exist)
- [ ] **Overleaf MCP**: none is installed. `git ls-remote` for project `6abbd1b24439af1dcdc1683e` reports *no git access* (wrong project ID, or Git integration not enabled on the plan). Once an MCP is added: `npm run mcp:inspect -- overleaf`, then implement `OverleafAdapter.compile`.
- [ ] **LinkedIn MCP**: the repository mentioned in the requirements isn't in the workspace. Add it to `config/mcp-servers.json`, inspect it, then implement `LinkedInAdapter.search`.
- [ ] **Job portals** (Naukri, Indeed, Internshala, Glassdoor, Unstop): enabled in `.env` but there is no adapter or MCP. Register tested adapters in `integrations/portals/registry.ts`.
- [ ] **Firecrawl MCP**: the REST API is used directly (verified). Switch to the MCP only if you prefer that transport.
- [ ] OpenAI / Anthropic AI adapters (only Gemini is implemented).
- [ ] Workday / SuccessFactors / iCIMS listing adapters (currently a careersUrl through Firecrawl, or `UNSUPPORTED`).

## Found in the first live test (2026-09-30)
- [x] Role-family gate: non-software roles (Maintenance Engineer, 74) are now `ROLE_FAMILY_INCOMPATIBLE` whatever their technical score. See ARCHITECTURE §6a.
- [x] Autocomplete inputs: the agent types and picks the matching list option (verified on the Lever fixture).
- [ ] **Decide:** ServiceNow ITSM (78), SAP BTP Full Stack (70), Salesforce (62) are rejected as ENTERPRISE_PLATFORM, and "AI Agent Engineer"/"GenAI Solutions Developer" as AI_ML. To accept them, set `targetRoleFamilies` in `Preferences/preferences.json`, e.g. `["FULLSTACK","BACKEND","FRONTEND","SOFTWARE_ENGINEERING","ENTERPRISE_PLATFORM"]`, then `npm run match -- --rematch`.
- [ ] **Fill `Application_Answers.txt`** (project root). `npm run preflight` lists what is still unknown.
  - To unblock MindTickle: Notice Period, Current CTC, Expected CTC, Willing to Relocate to Pune, SaaS Experience.
  - To unblock MongoDB: Preferred Name, Require Sponsorship, plus lines you add for "Have you worked at MongoDB before" and gender. The demographic-consent checkbox stays with you.
  - To unblock Rubrik: Codeforces Rating, CodeChef Rating, Past Internships.
  - Your pasted template said "Highest Education: MCA, 2024", but your resume says BE ECE, KVGCE, 2021–2025. Education is left blank, so the resume's values are used. If the resume is out of date, update `Data_Resume/MY_DATA` first.
- [ ] **Sign in to Google once in the agent's profile:** `npm run browser:login` (close your other Chrome windows that use this profile first). Set `GOOGLE_SIGNIN_ACCOUNT` in `.env` if the account differs from your resume email.
- [x] Greenhouse forms embedded on company sites (MongoDB) are opened; react-select dropdowns are selected and verified (live: Country "India +91", Location "Bengaluru, Karnataka, India", Resume/CV attached).
- [ ] SmartRecruiters (Bosch, ServiceNow, Freshworks, Experian) shows a DataDome slider CAPTCHA to the automated browser, so those applications always need you.

## Engineering follow-ups
- [x] Google adapter verified against the real spreadsheet: `db:init` created the 13 system tabs and header columns (grid auto-grows past column Z), a second run was a no-op, and preflight PASS.
- [ ] Exercise a real discover run against the sheet and check the flushed rows. Watch quota: about 60 requests/min.
- [ ] Very large histories (Timeline/Answer Log): archive old rows to a second spreadsheet if the sheet approaches Google's 10M-cell limit.
- [ ] Multi-step application forms: currently `stopOnMultiStepForm=true`. Add per-ATS step handling (Workday, Greenhouse multi-page) with tests against real pages.
- [ ] Per-ATS application form profiles (Ashby, Lever, Greenhouse) with recorded fixtures of their real markup.
- [ ] Optional AI-assisted JD requirement extraction, validated against the JD text the way Firecrawl extraction is.
- [ ] `maxJobAgeDays` (30) filters out long-open roles (e.g. Sarvam's April postings). Decide the window you want.
- [ ] A small web view of NEEDS_HUMAN jobs with screenshots.
