# ApplyPilot

You add jobs to a Google Sheet. For each job, ApplyPilot does three things:

1. Reads the job description from the job's Apply Link.
2. Tailors your LaTeX resume to that job description.
3. Fills in the application in a real Chrome window.

It stops for anything only you can do: CAPTCHAs, sign-ins, verification codes, and questions it has no answer for. It never guesses an answer, never pays, and never applies to the same job twice.

## Run it

```bash
npm install
npm start          # builds the UI and opens http://127.0.0.1:4317
```

Do these once:

- `npm run sheets:auth`: connect Google Sheets, if you use an OAuth client instead of a service account.
- `npm run browser:login`: sign in to Google in the agent's Chrome. This is for "Sign in with Google" buttons on job sites.

## Use it

1. **Resume** page:
   - Upload your resume PDF. Your details, experience, projects and skills are read from it and become your resume data.
   - Use **Edit details** to correct anything.
   - Use **Resume template** to change the LaTeX layout and preview it.
2. **Your Google Sheet**, **Jobs** tab:
   - Add one row per job with **Company**, **Job Title** and **Apply Link**. Location is optional.
   - Leave **Job ID** empty.
3. **Jobs** page:
   - Click **Sync sheet**. Each new row gets a Job ID, and its job description is read from the Apply Link.
   - Then click **Apply to all**, or select jobs and click **Tailor resume & apply**.
4. **Apply** page: watch the agent work. **Needs you** lists anything waiting on you.

**Dry runs and live runs:** every run is a dry run by default. A dry run tailors the resume and fills the form, but submits nothing. To submit for real:

1. In **Settings**, type `LIVE` to turn on live mode.
2. Choose **Live** when you start a run.

## Where the job description comes from

ApplyPilot tries these sources in order:

1. **The hiring platform's public API.** This works for Greenhouse, Lever, SmartRecruiters and Ashby, including company career pages that use them, such as `?gh_jid=` links.
2. **The page's structured job posting data**, which most career sites include.
3. **Firecrawl**, for pages that need JavaScript (requires `FIRECRAWL_API_KEY`).
4. **The page's visible text**, as a last resort.

If none of these work, the job is marked **Failed** with the reason. You can retry it from the job's page.

## Project layout

| Path | What |
|---|---|
| `server/` | Web server, agent runtime (queue, browser, human hand-offs), API |
| `web/` | The web app (Jobs, Apply, Needs you, Resume, Settings) |
| `agent/pipeline/sheetJobs.ts` | Sheet rows → jobs → job description read → ready for a resume |
| `agent/resume/` | Resume tailoring and LaTeX compile |
| `agent/application/` | Form detection, filling, verification, submission |
| `agent/matching/` | Job-description analysis; this only decides which of your skills the resume puts first |
| `integrations/jd/` | Job-description readers |
| `Data_Resume/MY_DATA/` | Your resume data |
| `Data_Resume/Resume_Template/master.tex` | Your LaTeX template |
| `Application_Answers.txt` | Your answers to application questions |

## Checks

```bash
npm run validate   # typecheck + lint + tests
```
