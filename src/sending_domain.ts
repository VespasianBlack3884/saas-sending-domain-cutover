import { createHash } from "node:crypto";
import { z } from "zod";
import { InfraiClient } from "./infrai_client.ts";

export const onboardingBody = z.object({
  tenant_id: z.string().min(1),
  domain: z.string().min(3),
  vendor: z.string().min(1).optional(),
  account_id: z.string().min(1).optional(),
  spf_include: z.string().min(1),
  dmarc_rua: z.string().email(),
  ttl: z.number().int().min(60).max(86_400).default(300),
});

export const domainBody = z.object({ domain: z.string().min(3) });
export type OnboardingInput = z.infer<typeof onboardingBody>;

type Zone = { zone_id: string };
type Verification = { verification: { status: string } };

export type OnboardingResult = {
  tenant_id: string;
  domain: string;
  zone_id: string;
  state: "verified" | "verification_pending";
  dns_status: unknown;
  email_status: string;
};

// Capability map: infrai.dns.domain.add, infrai.dns.record.upsert,
// infrai.dns.domain.verify, infrai.email.domain.verify,
// infrai.email.domain.rotate_dkim, infrai.dns.domain.delete.
export class SendingDomainManager {
  private readonly client: InfraiClient;

  constructor(client: InfraiClient) {
    this.client = client;
  }

  async onboard(input: OnboardingInput): Promise<OnboardingResult> {
    const key = stableKey(input.tenant_id, input.domain);
    const zone = await this.client.request<Zone>({
      method: "POST",
      path: "/v1/dns/domain/add",
      body: {
        domain: input.domain,
        ...(input.vendor ? { vendor: input.vendor } : {}),
        ...(input.account_id ? { account_id: input.account_id } : {}),
        metadata: { tenant_id: input.tenant_id, lifecycle: "onboarding" },
      },
      idempotencyKey: `${key}:zone`,
      retry: true,
    });

    await this.publishTxt(zone.zone_id, "@", `v=spf1 include:${input.spf_include} -all`, input.ttl, `${key}:spf`);
    await this.publishTxt(
      zone.zone_id,
      "_dmarc",
      `v=DMARC1; p=quarantine; rua=mailto:${input.dmarc_rua}`,
      input.ttl,
      `${key}:dmarc`,
    );

    const dnsStatus = await this.client.request<unknown>({
      method: "POST",
      path: "/v1/dns/domain/verify",
      body: { domain: input.domain },
      idempotencyKey: `${key}:dns-verify`,
      retry: true,
    });
    const mail = await this.client.request<Verification>({
      method: "POST",
      path: "/v1/email/domain/verify",
      body: { domain: input.domain },
      idempotencyKey: `${key}:mail-verify`,
      retry: true,
    });

    return {
      tenant_id: input.tenant_id,
      domain: input.domain,
      zone_id: zone.zone_id,
      state: mail.verification.status === "verified" ? "verified" : "verification_pending",
      dns_status: dnsStatus,
      email_status: mail.verification.status,
    };
  }

  async rotateDkim(domain: string): Promise<unknown> {
    return this.client.request({
      method: "POST",
      path: `/v1/email/domain/rotate_dkim/${encodeURIComponent(domain)}`,
      idempotencyKey: `${stableKey("dkim", domain)}:rotate`,
      retry: true,
    });
  }

  async retire(domain: string): Promise<unknown> {
    return this.client.request({
      method: "DELETE",
      path: "/v1/dns/domain/delete",
      query: { domain },
    });
  }

  private async publishTxt(zoneId: string, name: string, content: string, ttl: number, idempotencyKey: string) {
    return this.client.request({
      method: "PUT",
      path: "/v1/dns/record/upsert",
      body: { zone_id: zoneId, record_type: "TXT", name, content, ttl },
      idempotencyKey,
      retry: true,
    });
  }
}

function stableKey(tenantId: string, domain: string): string {
  return createHash("sha256").update(`${tenantId}:${domain}`).digest("hex").slice(0, 32);
}
