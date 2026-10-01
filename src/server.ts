import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const { app } = await createApp({ port });
app.listen(port, "0.0.0.0", () => {
  console.log(`CareCircle MCP server  → http://localhost:${port}/mcp  (Streamable HTTP, stateless)`);
  console.log(`Alexa+ simulator & family dashboard → http://localhost:${port}/`);
});
