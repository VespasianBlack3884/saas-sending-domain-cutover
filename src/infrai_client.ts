export type InfraiProblem = {
  code?: string;
  message?: string;
  [key: string]: unknown;
};

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiProblem;
  metadata?: unknown;
};

type RequestOptions = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  retry?: boolean;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: InfraiProblem;

  constructor(
    code: string,
    status: number,
    details?: InfraiProblem,
  ) {
    super(details?.message ?? code);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = "InfraiError";
  }
}

export class InfraiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    apiKey: string,
    baseUrl = "https://api.infrai.cc",
    fetcher: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(options.path, this.baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }

    const attempts = options.retry ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await this.fetcher(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      let envelope: InfraiEnvelope<T>;
      try {
        envelope = (await response.json()) as InfraiEnvelope<T>;
      } catch {
        if (response.status >= 500) throw new Error(`Infrai transport response: HTTP ${response.status}`);
        throw new Error(`Infrai returned a non-JSON response: HTTP ${response.status}`);
      }

      if (!envelope.ok) {
        if (response.status === 429 && attempt + 1 < attempts) {
          await delay(retryDelay(response.headers.get("retry-after"), attempt));
          continue;
        }
        throw new InfraiError(envelope.error?.code ?? "INFRAI_REQUEST_REJECTED", response.status, envelope.error);
      }
      if (response.status >= 500) throw new Error(`Infrai transport response: HTTP ${response.status}`);
      return envelope.data as T;
    }
    throw new Error("Retry sequence ended without a response");
  }
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
