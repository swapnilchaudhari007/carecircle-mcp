# Friction log (optional, worth up to a +10% judging bonus), TEMPLATE + DRAFT ENTRIES

> Keep only entries you actually hit, and add your own while deploying to AWS and recording the demo. Fill in every field.

| # | Task attempted | Steps taken | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|---|
| 1 | Run a Streamable HTTP MCP server on Lambda | Built Express + `StreamableHTTPServerTransport`, deployed behind a Function URL | Session-based example works on Lambda | Session state is lost between invocations, so stateful sessions break | Medium | Stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) with a new server per request | Add a "serverless deployment" section to the MCP + Alexa+ docs |
| 2 | Test the MCP server against Alexa+ | Looked for a developer test console | A way to register a dev MCP endpoint and talk to it | No self-serve test path for independent developers | High | Built a web simulator that acts as an MCP client with Bedrock tool use | Provide an Alexa+ MCP sandbox / simulator |
| 3 | Call Bedrock from the agent | Set `modelId` to the base Nova model ID | Converse call succeeds | *(record the exact error you see, e.g. on-demand throughput not supported)* | Low | Used the `us.` inference profile ID | Show the correct inference-profile ID in the console model page |
| 4 | *(your entry: SAM deploy / SNS SMS / model access…)* | | | | | | |
