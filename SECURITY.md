# Security Policy

## Supported versions

Only the latest code on `main` is supported.

## Reporting a vulnerability

**Please don't open a public issue.** Use the repo's **Security** tab → **Report a vulnerability**, or contact [@swapnilchaudhari007](https://github.com/swapnilchaudhari007).

Include a description, the impact, steps to reproduce and any suggested fix. You'll get an acknowledgement within 72 hours and an initial assessment within 7 days. Reporters are credited unless they'd rather stay anonymous.

## What we especially care about in CareCircle

- **Medication safety:** anything that could cause a double dose to be allowed, a missed dose to go unreported, or the server to give medical advice
- **Health data exposure:** medication schedules, names or contacts leaking through logs, alerts or MCP responses
- **Prompt injection:** spoken input or stored notes that steer the model into unintended tool calls
- **AWS credentials:** IAM keys, over-broad IAM roles or public DynamoDB/SNS resources
- **Alert spoofing:** ways to trigger or suppress family alerts without authorisation

## For contributors

- Never commit secrets: use `.env` files (git-ignored) or GitHub Actions secrets
- Keep real personal data out of code, tests, issues and screenshots
- Treat all user input, and anything passed to an AI model, as untrusted
