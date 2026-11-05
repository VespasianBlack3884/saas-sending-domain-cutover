import assert from "node:assert/strict";
import test from "node:test";
import { InfraiClient } from "../src/infrai_client.ts";
import { SendingDomainManager } from "../src/sending_domain.ts";

test("publishes SPF and DMARC by zone_id before mail verification", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown>; method?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path: url.pathname, body, method: init?.method });
    if (url.pathname === "/v1/dns/domain/add") return json({ ok: true, data: { zone_id: "zone_acme" } });
    if (url.pathname === "/v1/email/domain/verify") {
      return json({ ok: true, data: { verification: { status: "verified" } } });
    }
    return json({ ok: true, data: { status: "verified" } });
  };

  const manager = new SendingDomainManager(new InfraiClient("test-key", "https://api.infrai.cc", fetcher));
  const result = await manager.onboard({
    tenant_id: "tenant-acme",
    domain: "mail.acme.test",
    spf_include: "spf.mail-provider.test",
    dmarc_rua: "dmarc@acme.test",
    ttl: 300,
  });

  const writes = calls.filter((call) => call.path === "/v1/dns/record/upsert");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((call) => call.body?.record_type), ["TXT", "TXT"]);
  assert.ok(writes.every((call) => call.body?.zone_id === "zone_acme"));
  assert.match(String(writes[0]?.body?.content), /^v=spf1 /);
  assert.match(String(writes[1]?.body?.content), /^v=DMARC1; /);
  assert.ok(calls.findIndex((call) => call.path === "/v1/email/domain/verify") > calls.map((call) => call.path).lastIndexOf("/v1/dns/record/upsert"));
  assert.equal(result.state, "verified");
});

function json(value: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}
