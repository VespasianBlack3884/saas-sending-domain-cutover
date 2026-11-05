import { createServer, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { InfraiClient, InfraiError } from "./infrai_client.ts";
import { domainBody, onboardingBody, SendingDomainManager } from "./sending_domain.ts";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

const manager = new SendingDomainManager(new InfraiClient(apiKey));
const port = Number(process.env.PORT ?? 3000);

createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/tenants/sending-domain") {
      const input = onboardingBody.parse(await readJson(request));
      return send(response, 201, await manager.onboard(input));
    }
    if (request.method === "POST" && request.url === "/admin/sending-domain/rotate-dkim") {
      const { domain } = domainBody.parse(await readJson(request));
      return send(response, 200, await manager.rotateDkim(domain));
    }
    if (request.method === "DELETE" && request.url === "/admin/sending-domain") {
      const { domain } = domainBody.parse(await readJson(request));
      return send(response, 200, await manager.retire(domain));
    }
    send(response, 404, { error: "route_not_found" });
  } catch (error) {
    if (error instanceof ZodError) return send(response, 400, { error: "invalid_request", issues: error.issues });
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      return send(response, status, { error: error.code, message: error.message });
    }
    send(response, 500, { error: "service_error" });
  }
}).listen(port, () => console.log(`Sending-domain service listening on http://localhost:${port}`));

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
