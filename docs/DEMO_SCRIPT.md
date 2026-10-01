# Demo video script (target 2:45, hard limit 3:00)

Record at 1440×900. Open the simulator in Chrome with voice on. Click **Reset**, then the **8:40 AM** clock chip.
Judges may stop at 3:00, so the strongest moments (double-dose guard + family alert) land before 1:15.

| Time | On screen | Voiceover / action |
|---|---|---|
| 0:00–0:15 | Title card, then the dashboard | "My mother takes three medicines a day. I live in another city. Every night I ask: did you take your tablet? CareCircle is an Alexa+ MCP server that answers that for me and keeps her safe." |
| 0:15–0:35 | Device: say **"Good morning"** | Alexa reads the plan and plays Priya's message. Point at the MCP inspector: `get_todays_plan`, `check_messages` going over Streamable HTTP. |
| 0:35–0:50 | Say **"I took my sugar tablet"** | It works out that "sugar tablet" means Metformin and logs the 8:30 slot. The timeline turns green and the pill count drops. |
| 0:50–1:15 | Say **"I took my metformin"** | **Double-dose guard.** Alexa says don't take another. The dashboard shows an urgent alert and "family notified" (SNS). Pause on it. |
| 1:15–1:35 | Say **"I'm feeling a bit lonely today"** | It's the third low day, so the low-mood alert fires: "asked the family to call". Show the mood chart. |
| 1:35–1:50 | Say **"I feel dizzy, I need help"** | Urgent alert to everyone, with 112 advice. |
| 1:50–2:15 | Switch to **Son (caregiver)**: "How is Aai doing today?", then click **हिंदी** in the digest | Bedrock digest, then the Hindi version. "My sister reads it in Marathi." |
| 2:15–2:30 | Click **12:30 PM** | Missed-dose + refill alerts come from the proactive scan with no one talking. Mention EventBridge running the scan every 30 min. |
| 2:30–2:45 | Architecture slide (README diagram) | "14 MCP tools with annotations, stateless Streamable HTTP on Lambda, Bedrock, DynamoDB, SNS. One SAM deploy, MIT licensed. CareCircle: Alexa+ that keeps the family close." |

Tips: show the MCP inspector at least twice, because judges score how well you use the required tech. Avoid copyrighted music. Upload as public YouTube in English.
