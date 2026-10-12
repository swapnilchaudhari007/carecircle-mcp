# Contributing to CareCircle

Thanks for helping improve **CareCircle**, an Alexa+ MCP server that helps older adults manage medicines, with dose logging, a double-dose guard, family alerts and multilingual digests.

## Ways to contribute

- Report a bug or suggest an idea in [Issues](https://github.com/swapnilchaudhari007/carecircle-mcp/issues/new/choose)
- Pick up an issue labelled `good first issue` or `help wanted`
- Improve docs, examples or translations
- Review open pull requests

## Local setup

```bash
git clone https://github.com/<your-username>/carecircle-mcp.git
cd carecircle-mcp
npm install
npm run dev
npm run typecheck && npm test
```

Run the tests before opening a PR:

```bash
npm test
```

## Workflow

1. Fork the repo and create a branch: `git checkout -b feat/short-description`
2. Keep each PR focused on one change
3. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
4. Open a PR against `main` and fill in the template

## Areas you can work on

- MCP tools
- Dose logging & double-dose guard
- Missed-dose / refill alerts (SNS)
- Daily digests & translations
- AWS deployment (SAM template)

## AI-assisted contributions

AI tools are welcome. You are responsible for every line you submit: review it, test it and say in the PR if AI helped.

## Code of conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
