import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import type { BrokenKind } from "@kalpix/core";
import { assertUrlAllowed, isIpAllowed, SsrfError, type UrlPolicy } from "./ssrf";

export interface TransportRequest {
  url: URL;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>; // lower-case names
  body: Buffer; // decompressed, at most maxBytes
  truncated: boolean;
  timeMs: number;
}

export class TransportError extends Error {
  constructor(
    readonly kind: BrokenKind,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/** One HTTP GET without following redirects. Injected so unit tests need no network. */
export interface HttpTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "EPROTO",
]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "ENODATA"]);

/** Maps a Node network error to a broken-site classification. */
export function classifyNetworkError(err: unknown): TransportError {
  if (err instanceof TransportError) return err;
  if (err instanceof SsrfError) return new TransportError("ssrf_blocked", err.message);
  const e = err as NodeJS.ErrnoException & { cause?: unknown };
  if (e?.cause instanceof SsrfError) return new TransportError("ssrf_blocked", e.cause.message);
  const code = e?.code ?? "";
  const msg = e?.message ?? String(err);
  if (DNS_CODES.has(code)) return new TransportError("dns", `DNS lookup failed (${code})`);
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL"))
    return new TransportError("tls", `TLS error (${code})`);
  if (code === "ETIMEDOUT") return new TransportError("timeout", "Connection timed out");
  return new TransportError("network", `Network error${code ? ` (${code})` : ""}: ${msg}`);
}

/**
 * DNS lookup that refuses names resolving to any non-public address (all records are checked).
 * Used as the socket `lookup`, so the check happens at connect time (no rebinding window).
 */
export function guardedLookup(
  policy: UrlPolicy,
  dnsLookup: typeof dns.lookup = dns.lookup,
): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      const cb = callback as unknown as (
        e: Error | null,
        a?: string | dns.LookupAddress[],
        f?: number,
      ) => void;
      if (err) return cb(err);
      const list = addresses as unknown as dns.LookupAddress[];
      const bad = list.find((a) => !isIpAllowed(a.address, policy));
      if (bad || list.length === 0)
        return cb(new SsrfError(`${hostname} resolves to a non-public address`));
      if ((options as dns.LookupOptions).all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

/**
 * node:http(s) transport with the SSRF guard enforced at connect time: the custom DNS lookup
 * rejects private addresses, so a hostname that resolves (or re-resolves) to an internal IP is
 * never connected to. Responses are decompressed with a byte cap (zip-bomb safe).
 */
export class NodeHttpTransport implements HttpTransport {
  private readonly lookup: LookupFunction;

  constructor(
    private readonly policy: UrlPolicy = {},
    dnsLookup: typeof dns.lookup = dns.lookup,
  ) {
    this.lookup = guardedLookup(policy, dnsLookup);
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const url = assertUrlAllowed(req.url, this.policy);
    const lib = url.protocol === "https:" ? https : http;
    const started = Date.now();
    return new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const r = lib.request(
        url,
        {
          method: "GET",
          headers: { ...req.headers, "accept-encoding": "gzip, deflate, br" },
          lookup: this.lookup,
          agent: false,
        },
        (res) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
          const enc = (headers["content-encoding"] ?? "").toLowerCase();
          const stream: NodeJS.ReadableStream =
            enc === "gzip" || enc === "x-gzip"
              ? res.pipe(zlib.createGunzip())
              : enc === "deflate"
                ? res.pipe(zlib.createInflate())
                : enc === "br"
                  ? res.pipe(zlib.createBrotliDecompress())
                  : res;
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const finish = () =>
            done(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers,
                body: Buffer.concat(chunks),
                truncated,
                timeMs: Date.now() - started,
              }),
            );
          stream.on("data", (c: Buffer) => {
            if (truncated) return;
            const room = req.maxBytes - size;
            if (c.length >= room) {
              chunks.push(c.subarray(0, Math.max(0, room)));
              size = req.maxBytes;
              truncated = true;
              finish();
              r.destroy();
              return;
            }
            chunks.push(c);
            size += c.length;
          });
          stream.on("end", finish);
          stream.on("error", (e: Error) => done(() => reject(classifyNetworkError(e))));
          res.on("aborted", finish);
        },
      );
      const timer = setTimeout(() => {
        done(() => reject(new TransportError("timeout", `Timed out after ${req.timeoutMs} ms`)));
        r.destroy();
      }, req.timeoutMs);
      r.on("error", (e) => done(() => reject(classifyNetworkError(e))));
      r.end();
    });
  }
}
