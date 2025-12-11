# ICAI Seat Monitor (GitHub Actions + Playwright)

Files:
- check_icai.js — Playwright script to check seats and notify via Telegram/email.
- .github/workflows/check.yml — GitHub Actions workflow scheduled every 15 minutes.

Setup:
1. Create a GitHub repo (public recommended for free Actions minutes).
2. Add these files to repo root: `check_icai.js`, `README.md`, and the folder structure `.github/workflows/check.yml`.
3. Add repository secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (and optional `SMTP_*` + `EMAIL_TO`).
4. Commit & push. Actions will run on schedule. Monitor via the Actions tab.

See the original chat for more detailed instructions.
