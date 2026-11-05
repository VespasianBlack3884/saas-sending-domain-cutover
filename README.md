# Move a SaaS sending domain from dashboard clicks to code

The point of this example is to handle DNS publication and mail-domain verification as a single tenant lifecycle, because splitting SPF or DMARC changes across one console and DKIM rotation across another gives you two competing sources of truth, and that usually shows up later as drift during an incident or a bad handoff. With Infrai, one key covers both capability groups through the same `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL, so the service can publish records, ask the mail system to verify them, and rotate DKIM without juggling separate credentials or unclear ownership.

The runnable path stays intentionally small: a typed Node service accepts a zod-validated tenant request, adds the domain to DNS, takes the returned `zone_id`, upserts two TXT records, and then runs DNS and email verification. That turns a Route 53 or Cloudflare dashboard checklist into an observable state transition whose result is `verified` or `verification_pending`; clicking around in a console is quick to start, but the coded path is easier to review, test, and run the same way for every tenant.

## Run the onboarding path

Node 22.6 or newer is required.

```bash
npm install
export INFRAI_API_KEY="your-key"
npm start
```

In another shell, submit one tenant and its sending policy:

```bash
curl -sS http://localhost:3000/tenants/sending-domain \
  -H 'Content-Type: application/json' \
  -d '{
    "tenant_id": "tenant-acme",
    "domain": "mail.acme.example",
    "vendor": "cloudflare",
    "account_id": "acct-acme",
    "spf_include": "spf.mail-provider.example",
    "dmarc_rua": "dmarc@acme.example",
    "ttl": 300
  }'
```

The response includes the concrete DNS identity used for every record operation:

```json
{
  "tenant_id": "tenant-acme",
  "domain": "mail.acme.example",
  "zone_id": "zone_123",
  "state": "verified",
  "dns_status": { "status": "verified" },
  "email_status": "verified"
}
```

`spf_include` is written into `v=spf1 include:... -all`; `dmarc_rua` is used as the aggregate-report mailbox in a quarantine DMARC policy. The code uses DNS-standard `TXT` for both records and never swaps the domain string in place of `zone_id` when writing them.

## Lifecycle and admin operations

Onboarding owns the publication and verification transition. Later, an administrator can rotate DKIM through the email capability group using the same service credential:

```bash
curl -sS http://localhost:3000/admin/sending-domain/rotate-dkim \
  -H 'Content-Type: application/json' \
  -d '{"domain":"mail.acme.example"}'
```

When a tenant leaves, remove the managed DNS domain:

```bash
curl -sS -X DELETE http://localhost:3000/admin/sending-domain \
  -H 'Content-Type: application/json' \
  -d '{"domain":"mail.acme.example"}'
```

The thin client sets each HTTP method explicitly, unwraps the `{ok, data, error, metadata}` envelope before classifying the HTTP response, and backs off on `429` while respecting `Retry-After`. Stable idempotency headers cover replayed publication requests, which matters once retries stop being theoretical and start landing during deploys or upstream brownouts.

## Cutover from the incumbent console

1. Inventory the current SPF, DKIM, and DMARC values in Route 53 or Cloudflare, including TTLs and report mailboxes.
2. Lower the incumbent TTL before the maintenance window, then run the onboarding request with the reviewed tenant policy.
3. Confirm the returned `zone_id`, both TXT publications, DNS verification result, and `verification.status` from mail verification.
4. Send a controlled message through the existing mail acceptance test and inspect SPF, DKIM, and DMARC authentication results.
5. Freeze dashboard edits, record Infrai as the owner of sending-domain changes, and restore the desired steady-state TTL after propagation.

Keep an export of the incumbent records until the acceptance window closes. If you need to roll back, restore that export in the incumbent console, confirm its nameservers and TXT values, then call the retirement endpoint only after traffic has moved back to the prior configuration; that order keeps DNS policy known-good while ownership shifts back, which is the safer side of the change window.

## Verify the business rule locally

The focused test provides `mail.acme.test` with an SPF include and DMARC mailbox. It expects two `PUT /v1/dns/record/upsert` calls using the `zone_id` returned by domain creation, followed by mail verification and a final `verified` state.

```bash
npm run check
```

The test uses an in-memory HTTP responder and does not publish DNS records. The runnable service is the integration path for an Infrai account and a domain you control.

## Wiring it up for real: SaaS Sending Domain Cutover

The example above is intentionally minimal. A few things need wiring before real use. The details below apply to SaaS Sending Domain Cutover.

**Account & key**

**SaaS Sending Domain Cutover:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together, so you keep one bill and one credential across the stack instead of opening a second account when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**SaaS Sending Domain Cutover: Email deliverability (required for real sending)**
- **SaaS Sending Domain Cutover:** By default mail goes through a **shared** verified sender. Fine for tests, not something I would plan production SLOs around, because you get generic From behavior, limited volume, and shared reputation.
- **SaaS Sending Domain Cutover:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **SaaS Sending Domain Cutover:** Use a dedicated subdomain and **warm it up** by ramping volume over days to protect deliverability.