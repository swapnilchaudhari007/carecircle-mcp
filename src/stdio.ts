// stdio entry point (for MCP clients/registries that launch the server as a subprocess, e.g. Glama).
// stdout is reserved for JSON-RPC, so all logs go to stderr.
console.log = console.error;
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { CareService } = await import("./care.js");
const { createStore } = await import("./store.js");
const { FamilyNotifier } = await import("./notify.js");
const { buildMcpServer } = await import("./mcp.js");
const { seedDemo } = await import("./seed.js");

const store = createStore();
const care = new CareService(store, new FamilyNotifier());
await seedDemo(store);
const server = buildMcpServer(care);
await server.connect(new StdioServerTransport());
console.error("CareCircle MCP server running on stdio");

export {};
