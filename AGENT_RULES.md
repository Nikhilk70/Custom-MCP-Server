# Agent rules

These are the rules the application agent follows, and where each one is enforced. Details are in [ARCHITECTURE.md](ARCHITECTURE.md) §6a and §8.

| Rule | How it is enforced |
|---|---|
| Use the configured answers; empty means **don't guess** | **`Application_Answers.txt`** (`Key : Value`) is where you answer. A filled value is an explicit verified answer. A blank value is never guessed: it falls back to MY_DATA (links, education) or stops for you when required. A value contradicting your resume data isn't used, and preflight reports it. Beneath that: MY_DATA and `Application_Questions/`. |
| Required question with no answer: **stop for a human** | `NEEDS_HUMAN` naming each field. Question text beside a control (Lever), `*` / `✱` / `.required` markers and hidden validation inputs all count as "required". |
| Last name, notice period, CTC, relocation, hybrid/onsite, SaaS years are **user-provided only** | Never derived. Fill them in `Preferences/preferences.json`, `Application_Questions/Personal` (Q-PER-003 last name), `Salary` (Q-SAL-002) and `Experience` (Q-EXP-004). |
| Technology-specific experience never uses total experience | "Years of experience in Java / with a SaaS firm" matches only an explicit `<subject>_years` record, else goes to you. It is never total years, and never "Yes". |
| Dropdowns: select the real option; don't type and assume | Native `<select>`: `selectOption` + read-back. Custom comboboxes: open, click the matching option, and confirm the widget shows it. Autocompletes: type, pick the matching suggestion, re-check. |
| Verify every field on the page | Each value is read back right after filling, and again after the page settles, since autocompletes clear text and resume parsers overwrite fields. |
| **CAPTCHA** / **OTP** / **security check**: stop, wait for the user, continue the same application | With a visible browser: "WAITING FOR YOU", poll until done (15 min max), continue from the current page. Headless: `NEEDS_HUMAN`. The CAPTCHA is never touched. |
| **Login / SSO**: wait for the user if no session | Prefers the site's own "Sign in with Google" (next row). Otherwise it waits for you to log in (visible browser), or stops. Site passwords are never stored or typed. |
| **Sign in with Google** | Uses the Google session in the agent's persistent Chrome profile: sign in once yourself with `npm run browser:login`. The agent picks `GOOGLE_SIGNIN_ACCOUNT` only if Google lists it, and confirms basic sign-in only (name/email/picture). Password, 2-step verification, "verify it's you", recovery or extra permissions → you. Success is checked on the site, and then the same job continues. |
| **Payment: stop immediately** | Fee text, card/UPI/bank fields, or a visible gateway frame → `PAYMENT_REQUESTED`. Nothing is entered, nothing is authorized, and it is never waited out. This is checked on arrival, after locating the form, before submit and after submit. |
| Final submit follows the mode | `REVIEW_ONLY` never submits. `AUTO_FILL_REVIEW_SUBMIT` submits only after your YES. `FULL_AUTO` submits only when every field is verified. `DRY_RUN` never submits. |
| Never report a false submission | `APPLIED` requires confirmation evidence on the page. Otherwise it is `SUBMISSION_UNVERIFIED` or `NEEDS_HUMAN`. |
| Ineligible jobs are never applied to | Resume generation and applying both refuse any job whose stored match is not `ELIGIBLE` (role → experience → mandatory → technical gates). |
