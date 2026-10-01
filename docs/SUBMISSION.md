# Devpost submission copy — CareCircle

> ⚠️ The "Inspiration" section is a draft written in your voice. Rewrite it with your real story; judges can tell.

**Project name:** CareCircle
**Tagline:** Alexa+ that keeps Aai's medicines on track and the family close.
**Track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP)
**Mini challenges:** AWS Builder · Open Source
**Built with:** typescript, node.js, model-context-protocol, alexa, amazon-bedrock, amazon-nova, aws-lambda, amazon-dynamodb, amazon-sns, amazon-eventbridge, aws-sam, web-speech-api

---

## Inspiration
My mother takes three medicines a day. I live in a different city, so every evening I call her with the same question: "Aai, did you take your tablet?" Sometimes she isn't sure. Once she took her sugar tablet twice. Pill apps don't help her because they need a smartphone, small text and tapping. She talks to Alexa every day, though. So I built a way for her to talk to Alexa about her medicines, and a way for Alexa to quietly tell us when something isn't right.

## What it does
CareCircle is an MCP server that gives Alexa+ a care plan, safety guardrails and a line to the family.

- **Talk, don't tap.** "I took my sugar tablet" → Alexa matches the spoken name to *Metformin 500 mg*, logs the 8:30 AM dose and updates the pill count.
- **Double-dose guard.** If she says it again: "Wait, you already took it at 8:40. Please don't take another one." The family gets an urgent alert.
- **Early-dose confirmation.** If a dose is more than 2 hours early, Alexa asks before logging it.
- **Wellbeing check-ins.** Mood and pain go into a trend. After three low days in a row, CareCircle asks her children to call. It doesn't nag her.
- **Proactive safety scan** after every interaction and every 30 minutes: missed doses, repeated misses, a "silence signal" (nothing heard from her by 11 AM), high pain and refill forecasts.
- **Two-way family messages.** "Tell Priya to bring vegetables" goes to Priya by SMS or email. Priya's "I'll call at 7" is read aloud to Aai at her next interaction.
- **Help.** "I feel dizzy, I need help" alerts everyone right away and points to 112 when it sounds like an emergency.
- **Caregiver digest.** "Alexa, how is Aai doing?" gets a 120-word update written by Bedrock, in **English, Hindi or Marathi**, with urgent items first.

## How we built it
- **MCP server** in TypeScript with `@modelcontextprotocol/sdk` 1.31 (protocol `2025-11-25`), served over **stateless Streamable HTTP**. A fresh server and transport handles each request, so it runs on Lambda without sticky sessions. It requires Bearer auth and validates Origin.
- **14 tools** with annotations and `structuredContent`, plus 1 resource, 2 prompts and server `instructions` that encode the safety rules. Every result includes a `speak` field written for an elderly listener: short sentences and no jargon.
- **Domain engine** (`care.ts`): time-zone-aware dose slots (IST), fuzzy matching of spoken names (purpose aliases like "BP"/"sugar" plus bigram similarity for speech-to-text errors like "met forming"), adherence and streaks, the alert rules, and refill forecasting.
- **AWS:** Lambda (container image + Lambda Web Adapter + Function URL), **DynamoDB** single-table store, **Amazon Bedrock** (Nova via the Converse API) for the multilingual digest and the simulator's tool-use agent, **SNS** for SMS/email to the family, **EventBridge Scheduler** for the 30-minute safety scan. Everything is in one **SAM** template.
- **Alexa+ simulator:** an Echo-Show-style web app with Web Speech voice in and out. It is a real MCP client: Bedrock picks tools and the client calls them over HTTP. An **MCP inspector** panel shows every `tools/call` as it happens.
- **12 unit tests** cover matching, the double-dose guard, early confirmation, skipped doses, missed/silence/low-mood/repeat alerts, adherence and refills.

## Challenges we ran into
- **Time is the hardest part of medication logic.** "I took it", said at 11:50 PM, could belong to tonight's or tomorrow's slot. We match against yesterday, today and tomorrow and pick the nearest open slot. The double-dose guard looks at the nearest slot *before* anything gets logged.
- **Speech-to-text names.** Elders say "my sugar tablet", "BP goli" or "met forming". Matching combines aliases from the medicine's purpose with bigram similarity.
- **Alerting without nagging.** Every alert has a dedupe key, so a 30-minute scan never spams the family.
- **Stateless Streamable HTTP on Lambda:** JSON response mode plus a per-request server keeps it simple and cheap.

## Accomplishments that we're proud of
- A safety feature that prevents real harm (the double-dose guard), not just reminders.
- Hindi and Marathi digests, because the family speaks those languages.
- It runs fully offline for demos and becomes AI-powered when you set one environment variable.

## What we learned
MCP tool design for voice is a different craft from tool design for chat. Results need a speakable sentence, not just data. Annotations and server instructions matter as much as the schemas.

## What's next for CareCircle
- Certify with the Alexa+ developer program and add proactive Alexa notifications at dose times.
- Pharmacy reorder integration when stock drops below 5 days.
- Caregiver-shared "circles" with roles (doctor read-only view, home nurse).
- Ring integration: if the front door hasn't opened by noon and nothing has been heard from her, escalate.

## If the project existed before the hackathon
It didn't. All code was written during the submission window.

---

## Open Source mini challenge fields
- **Repo URL:** https://github.com/swapnilchaudhari007/carecircle-mcp
- **License:** MIT
- **GitHub username:** swapnilchaudhari007
- **Description:** CareCircle is an open-source, self-hostable MCP server for elder medication care. It covers spoken-name dose logging with a double-dose guard, wellbeing trend detection, family messaging and multilingual digests. Anyone can deploy it to their own AWS account with one SAM command, which keeps sensitive health data under the family's control. Families caring for aging parents get a voice-first tool that respects privacy, and developers get a reference for building safe, voice-first MCP tools.

## AWS Builder mini challenge fields
- **Services:** Amazon Bedrock (Nova Pro via Converse API + tool use), AWS Lambda (container + Lambda Web Adapter + Function URL), Amazon DynamoDB, Amazon SNS, Amazon EventBridge Scheduler, AWS SAM / CloudFormation, Amazon ECR.
- **Where in code:** `src/ai.ts` (Bedrock Converse), `src/agent.ts` (Bedrock tool-use loop over MCP tools), `src/store.ts` (DynamoDB), `src/notify.ts` (SNS), `template.yaml` (all infra + scheduler).
