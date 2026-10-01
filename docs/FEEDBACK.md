# Product feedback (required field), DRAFT

> Edit this so it reflects *your* experience before you submit. Judges value specific, honest feedback.

## Model Context Protocol TypeScript SDK (1.31, protocol 2025-11-25)
- **Used for:** the CareCircle MCP server (tools, resource, prompts, instructions) and the simulator's MCP client.
- **Worked well:** `registerTool` with zod schemas plus annotations is concise. `StreamableHTTPServerTransport` in stateless JSON mode dropped straight into Express and Lambda. `structuredContent` let the server return both data and a spoken sentence.
- **Needs work:** stateless mode needs a new server per request, and the docs could say more clearly that this is the intended pattern. There's no first-class guidance on designing tool results for voice clients (for example a "speakable" summary convention).
- **Onboarding:** good. The examples folder was the fastest way in.
- **Would build again:** yes.

## Alexa+ (MCP integration path)
- **Used for:** the target client. We built against the documented Streamable HTTP requirements and simulated the Alexa+ side in a web app.
- **Needs work:** wider access to an Alexa+ test client so independent developers can try their MCP servers end to end. We'd also like docs on which MCP features Alexa+ supports (prompts? resources? elicitation?) and on proactive notifications triggered from MCP.
- **Would build again:** yes, voice is the right interface for elder care.

## Amazon Bedrock (Nova via Converse API)
- **Used for:** the multilingual caregiver digest (EN/HI/MR) and the tool-use loop in the simulator.
- **Worked well:** Converse's tool-use format maps almost 1:1 onto MCP `tools/list` JSON Schemas.
- **Needs work:** model access requests and inference-profile IDs (`us.` prefix) confuse first-time users.

## AWS Lambda + Lambda Web Adapter, DynamoDB, SNS, EventBridge Scheduler, SAM
- **Used for:** hosting, care data, family SMS/email, the 30-minute proactive safety scan, and infrastructure as code.
- **Worked well:** Lambda Web Adapter let the same container run locally and on Lambda unchanged. The LWA pass-through path makes scheduled invocations easy.
- **Needs work:** SNS SMS in India needs sender-ID / DLT registration, which isn't obvious from the console.
