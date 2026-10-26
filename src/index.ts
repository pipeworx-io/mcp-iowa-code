interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}


/**
 * Minimal RTF-to-text decoder for state statute packs whose official per-
 * chapter files are published as RTF rather than HTML — e.g. Iowa, whose
 * legis.iowa.gov serves each Code chapter as an Arbortext-generated
 * `<chapter>.rtf` for every year back to 2000, while a cleaner per-chapter
 * XML export exists ONLY for the current year (confirmed live 2026-10-06:
 * `/docs/publications/ICC/<year>/attachments/<chapter>_slim.xml` 404s for
 * every year but the current one, even though the chapter-listing page
 * keeps linking it — a dead link on their own site). RTF is the one format
 * available for every year, so it is the universal path here, not just the
 * historical fallback.
 *
 * Decodes exactly the subset these Arbortext RTF files use: groups, the
 * text-bearing control symbols (\par, \line, \tab, \~ non-breaking space,
 * \_ non-breaking hyphen, \emdash, \endash, \lquote/\rquote/\ldblquote/
 * \rdblquote, \bullet), hex character escapes (\'HH, windows-1252), and \uN
 * Unicode escapes together with their \ucN fallback-skip run (default 1).
 * Everything else — fonttbl/colortbl/stylesheet/info/listtable/
 * listoverridetable/userprops/propname/staticval/bkmkstart/bkmkend/fldinst,
 * and any unrecognized control word — is consumed silently. \fldrslt, the
 * VISIBLE text of a hyperlinked field (an "Acts" citation that is also a
 * link to the session-law PDF), is deliberately NOT a skip destination:
 * only its sibling \fldinst (the URL) is, so the citation text itself
 * survives in the output.
 *
 * This is NOT a general RTF reader — no \objdata, no pictures, no revision
 * marks. It is sized to what one state's generated chapter files contain,
 * verified against live content for chapter 714 of the 2026 and 2015
 * editions.
 *
 * publish-pack.sh inlines workspace imports, so a standalone pack still
 * ships self-contained.
 */

const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable',
  'revtbl', 'rsidtbl', 'generator', 'themedata', 'latentstyles', 'datastore',
  'userprops', 'propname', 'staticval', 'bkmkstart', 'bkmkend', 'fldinst',
  'pict', 'object', 'xmlnstbl', 'wgrffmtfilter', 'pntext',
]);

// windows-1252's 0x80-0x9F range is the only part that differs from
// Latin-1 (0xA0-0xFF match it exactly) — this is just that range, enough to
// decode every \'HH hex escape these files use.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function cp1252(byte: number): string {
  const hi = CP1252_HIGH[byte];
  if (byte >= 0x80 && byte <= 0x9f && hi !== undefined) return String.fromCodePoint(hi);
  return String.fromCharCode(byte);
}

/** Decode an RTF document (already read as a string) to plain text. */
function rtfToText(rtf: string): string {
  let out = '';
  const groupSkip: boolean[] = [false];
  const n = rtf.length;
  let i = 0;
  let awaitingDestKeyword = false; // true right after '{', before the first non-'*' token
  let ucValue = 1;
  let ucSkipRemaining = 0;

  const topSkip = () => groupSkip[groupSkip.length - 1];
  const emit = (s: string) => {
    if (topSkip()) return;
    if (ucSkipRemaining > 0) { ucSkipRemaining--; return; }
    out += s;
  };

  while (i < n) {
    const ch = rtf[i];

    if (ch === '{') {
      groupSkip.push(topSkip());
      awaitingDestKeyword = true;
      i++;
      continue;
    }
    if (ch === '}') {
      groupSkip.pop();
      if (groupSkip.length === 0) groupSkip.push(false);
      awaitingDestKeyword = false;
      i++;
      continue;
    }

    if (ch === '\\') {
      i++;
      if (i >= n) break;
      const c = rtf[i];

      if (c === '\\' || c === '{' || c === '}') {
        i++;
        emit(c);
        awaitingDestKeyword = false;
        continue;
      }
      if (c === '~') { i++; emit(' '); awaitingDestKeyword = false; continue; }
      if (c === '_') { i++; emit('-'); awaitingDestKeyword = false; continue; }
      if (c === "'") {
        const hex = rtf.slice(i + 1, i + 3);
        i += 3;
        const byte = parseInt(hex, 16);
        if (ucSkipRemaining > 0) { if (!topSkip()) ucSkipRemaining--; }
        else if (!Number.isNaN(byte)) emit(cp1252(byte));
        awaitingDestKeyword = false;
        continue;
      }
      if (c === '*') { i++; continue; } // ignorable-destination marker; keep awaiting the keyword

      // Control word: letters, then an optional signed numeric parameter,
      // then a single delimiting space (consumed, not emitted).
      let j = i;
      while (j < n && /[A-Za-z]/.test(rtf[j])) j++;
      const word = rtf.slice(i, j);
      let k = j;
      let numStr = '';
      if (k < n && (rtf[k] === '-' || /[0-9]/.test(rtf[k]))) {
        let m = k + (rtf[k] === '-' ? 1 : 0);
        while (m < n && /[0-9]/.test(rtf[m])) m++;
        numStr = rtf.slice(k, m);
        k = m;
      }
      if (k < n && rtf[k] === ' ') k++;
      i = k;

      if (word === '') { awaitingDestKeyword = false; continue; } // bare backslash, nothing to do

      if (awaitingDestKeyword && SKIP_DESTINATIONS.has(word)) {
        groupSkip[groupSkip.length - 1] = true;
      }
      awaitingDestKeyword = false;

      if (topSkip()) continue;

      switch (word) {
        case 'par': case 'line': out += '\n'; continue;
        case 'tab': out += '\t'; continue;
        case 'emdash': emit('—'); continue;
        case 'endash': emit('–'); continue;
        case 'lquote': emit('‘'); continue;
        case 'rquote': emit('’'); continue;
        case 'ldblquote': emit('“'); continue;
        case 'rdblquote': emit('”'); continue;
        case 'bullet': emit('•'); continue;
        case 'uc': {
          const v = parseInt(numStr, 10);
          if (!Number.isNaN(v)) ucValue = v;
          continue;
        }
        case 'u': {
          let code = parseInt(numStr, 10);
          if (!Number.isNaN(code)) {
            if (code < 0) code += 65536;
            out += String.fromCodePoint(code);
            ucSkipRemaining = ucValue;
          }
          continue;
        }
        default:
          continue; // formatting/unknown control word: no text
      }
    }

    i++;
    emit(ch);
    awaitingDestKeyword = false;
  }

  return out
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/**
 * Iowa Code — state statutes by citation, historical edition, amendment
 * history, and chapter/section topic search.
 *
 * SOURCE AND THE SURVEY TRAP. The August state-law survey (docs/
 * state-law-probe.md) never reached Iowa, but its recorded trap —
 * "published only as PDF" — does not hold here. legis.iowa.gov serves every
 * chapter of the Iowa Code as a plain RTF file, keyless, for every year it
 * archives (2000, then 2004 through the current year — 2001-2003 are
 * simply missing from the site's own year picker, not a probe failure):
 *
 *   https://www.legis.iowa.gov/docs/code/2026/714.rtf   (current edition)
 *   https://www.legis.iowa.gov/docs/code/2015/714.rtf   (a historical one)
 *
 * A cleaner per-chapter XML export also exists
 * (`/docs/publications/ICC/<year>/attachments/<chapter>_slim.xml`) — but
 * verified live 2026-10-06, it 404s for every year except the current one,
 * even though every year's own chapter-listing page keeps linking it (a
 * dead link on their own site, not a probe mistake: the HTML exists, the
 * `href` is real, the target genuinely 404s). RTF is therefore the
 * universal path here, used for every year including the current one,
 * rather than XML-for-current plus RTF-as-fallback — one code path instead
 * of two, and the historical and current cases get identical treatment.
 *
 * Decoding RTF to text uses shared `rtfToText` (shared/src/statute-rtf.ts),
 * written for exactly this file shape and verified against both the 2026
 * and 2015 editions of chapter 714 (Theft, Fraud, and Related Offenses).
 *
 * SLICING A SECTION. legis.iowa.gov puts a full section citation
 * ("714.2  Degrees of theft.") at the START of its own line only at the
 * real heading — every cross-reference to that section from elsewhere in
 * the chapter ("...pursuant to section 714.2, subsection 1...") sits mid-
 * sentence, never at a line start. So, unlike the Colorado/Nevada/Oregon
 * state packs, there is no observed "mini table of contents repeats the
 * heading" trap here to defend against — but `sliceSection`'s most-text-
 * wins heuristic is used anyway, both as the standing defense for this pack
 * family and because it costs nothing when there is only one candidate.
 *
 * AMENDMENT HISTORY. Each section ends with 0-2 history lines: an old-style
 * bracketed citation chain back to the 1897/1924/1946/... codes
 * ("[C51, §2612...; C79, 81, §714.2]") for sections old enough to have one,
 * and/or a semicolon-joined list of amending Acts ("83 Acts, ch 134, §1;
 * ..."). Both are split out of the returned text into a separate `history`
 * field (and a trailing "Referred to in ..." cross-reference line into
 * `referred_to_in`) rather than left inline, matching the shape of the
 * other packs in this family (Colorado's `history`/`cross_references`,
 * Georgia's `history`).
 *
 * TOPIC SEARCH. Iowa does not publish a general subject index of the Code
 * the way Colorado does (verified 2026-10-06: no `INDEX.pdf`/`index.pdf`
 * under `/docs/code/<year>/`, and no "Iowa Code" facet in the Iowa
 * Legislature's own publications search — that index covers bills, fiscal
 * notes, administrative bulletins and rules, confirmed by its own facet
 * tree, but not Code section TEXT). What IS real and keyless: every
 * chapter and section carries an official caption ("714 - THEFT, FRAUD,
 * AND RELATED OFFENSES", "714.1 - Theft defined.") on the Legislature's own
 * listing pages. `ia_code_search` matches a query against those captions —
 * first across every chapter in all 16 titles, then drills into the
 * section-level captions of the best-matching chapters — which is a real,
 * live, self-updating topic search over the Code's own organization, not a
 * full-text search of statutory prose. The tool description says so.
 */

const UA = 'pipeworx-mcp-iowa-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Iowa Legislature (legis.iowa.gov)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

const CURRENT_YEAR = 2026;
// The site's own year picker (probed live 2026-10-06 against chapter 714's
// listing page) — 2001-2003 are genuinely absent, not a gap in this probe.
const VALID_YEARS: ReadonlySet<number> = new Set([
  2000,
  ...Array.from({ length: CURRENT_YEAR - 2004 + 1 }, (_, i) => 2004 + i),
]);
const MIN_YEAR = 2000;

/** The Code's 16 titles, with their official names and chapter ranges —
 *  from the Legislature's own title-listing page. Routing help: know the
 *  subject, find the title, then browse or search within it. */
const TITLES: Record<string, { name: string; range: string }> = {
  I: { name: 'State Sovereignty and Management', range: '1 - 38D' },
  II: { name: 'Elections and Official Duties', range: '39 - 79' },
  III: { name: 'Public Services and Regulation', range: '80 - 122C' },
  IV: { name: 'Public Health', range: '123 - 158' },
  V: { name: 'Agriculture', range: '159 - 215A' },
  VI: { name: 'Human Services', range: '216 - 255A' },
  VII: { name: 'Education, History, and Culture', range: '256 - 305B' },
  VIII: { name: 'Transportation', range: '306 - 330B' },
  IX: { name: 'Local Government', range: '331 - 420' },
  X: { name: 'Financial Resources', range: '421 - 454' },
  XI: { name: 'Natural Resources', range: '455 - 485' },
  XII: { name: 'Business Entities', range: '486 - 504C' },
  XIII: { name: 'Commerce', range: '505 - 554I' },
  XIV: { name: 'Property', range: '555 - 594A' },
  XV: { name: 'Judicial Branch and Judicial Procedures', range: '595 - 686D' },
  XVI: { name: 'Criminal Law and Procedure', range: '687 - 916' },
};
const TITLE_ORDER = Object.keys(TITLES);

const CITATION = /^(\d+[A-Z]*)\.(\d+[A-Z]?)$/;
const SECTION_HEADING = /^\d+[A-Z]*\.\d+[A-Z]?[ \t]/;

function normalizeSection(raw: string): string {
  return raw
    .trim()
    .replace(/^(iowa\s*code|i\.?c\.?a?\.?|§)\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/^§/, '');
}

/**
 * Cut one section out of a whole-chapter text. Picks the candidate with the
 * most text before the next section heading (or end of chapter) — the
 * defense this pack family uses against a TOC/cross-reference impostor
 * heading, even though no such impostor has been observed in Iowa's files
 * (see the file header).
 */
function sliceIowaSection(text: string, citation: string): string | null {
  const escaped = citation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^${escaped}[ \\t]`, 'gm');
  const found: Array<{ at: number; len: number }> = [];
  for (let m = headingRe.exec(text); m; m = headingRe.exec(text)) {
    found.push({ at: m.index, len: m[0].length });
    if (headingRe.lastIndex === m.index) headingRe.lastIndex++;
  }
  if (!found.length) return null;

  let best: string | null = null;
  for (const { at, len } of found) {
    const from = at + len;
    const nre = new RegExp(SECTION_HEADING.source, 'gm');
    const m = nre.exec(text.slice(from));
    const body = (m ? text.slice(at, from + m.index) : text.slice(at)).trim();
    if (body.length > (best?.length ?? 0)) best = body;
  }
  return best;
}

/** Split a sliced section into its statute text, amendment history, and
 *  "Referred to in ..." cross-references — each its own line (or run of
 *  lines) in the decoded text, see the file header. */
function splitHistory(body: string): { statute: string; history: string | null; referred_to_in: string | null } {
  const lines = body.split('\n');
  const isHistoryLine = (l: string) =>
    /^\[/.test(l) || /^\d{2,4}(?:,\s*\d{2,4})*\s+Acts,/.test(l) || /^S\d+\s+Acts,/.test(l);
  const isReferredLine = (l: string) => /^Referred to in\b/i.test(l);

  let historyStart = -1;
  for (let idx = 1; idx < lines.length; idx++) {
    if (isHistoryLine(lines[idx]!)) { historyStart = idx; break; }
  }
  let referredStart = -1;
  for (let idx = historyStart === -1 ? 1 : historyStart; idx < lines.length; idx++) {
    if (isReferredLine(lines[idx]!)) { referredStart = idx; break; }
  }

  const statuteEnd = historyStart === -1 ? lines.length : historyStart;
  const historyEnd = referredStart === -1 ? lines.length : referredStart;

  const statute = lines.slice(0, statuteEnd).join('\n').trim();
  const historyText = historyStart === -1 ? '' : lines.slice(historyStart, historyEnd).join(' ').replace(/\s+/g, ' ').trim();
  const referredText = referredStart === -1 ? '' : lines.slice(referredStart).join(' ').replace(/\s+/g, ' ').trim();

  return {
    statute,
    history: historyText || null,
    referred_to_in: referredText || null,
  };
}

async function fetchChapterText(chapter: string, year: number): Promise<{ text: string } | { notFound: true }> {
  const url = `https://www.legis.iowa.gov/docs/code/${year}/${chapter}.rtf`;
  const res = await pwFetch(url);
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`${UPSTREAM} returned HTTP ${res.status} for chapter ${chapter} (${year})`);
  const buf = await res.arrayBuffer();
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    raw = new TextDecoder('windows-1252').decode(buf);
  }
  return { text: rtfToText(raw) };
}

async function iaCodeSection(args: Record<string, unknown>) {
  const rawInput = String(args.section ?? '').trim();
  if (!rawInput) {
    return {
      found: false, reason: 'empty_section',
      message: 'ia_code_section needs a "section" argument, e.g. "714.2" or "6B.1".',
    };
  }
  const normalized = normalizeSection(rawInput);
  const m = CITATION.exec(normalized);
  if (!m) {
    return {
      found: false, reason: 'unparsed_section',
      message: `"${rawInput}" is not an Iowa Code citation.`,
      hint: 'Iowa citations are chapter.section, e.g. "714.2" (degrees of theft) or "321J.2" (OWI). The chapter is the part before the dot and may carry letters, e.g. "714A" or "6B".',
    };
  }
  const chapter = m[1]!;
  const citation = `${chapter}.${m[2]}`;

  let year = CURRENT_YEAR;
  if (args.year !== undefined && args.year !== null && args.year !== '') {
    const y = Number(args.year);
    if (!Number.isInteger(y) || !VALID_YEARS.has(y)) {
      return {
        found: false, reason: 'unsupported_year',
        message: `Iowa's own archive does not have a ${args.year} edition.`,
        hint: `Years ${MIN_YEAR} and ${MIN_YEAR + 4}-${CURRENT_YEAR} are archived; 2001-2003 were never published online by the Legislature. Omit "year" for the current (${CURRENT_YEAR}) edition.`,
      };
    }
    year = y;
  }

  const chapterResult = await fetchChapterText(chapter, year);
  if ('notFound' in chapterResult) {
    return {
      found: false, reason: 'chapter_not_found', chapter, year,
      message: `No chapter ${chapter} in the ${year} Iowa Code (HTTP 404 for its RTF file).`,
      hint: 'Chapter numbers are not contiguous — reserved, repealed, and renumbered chapters are normal. Call ia_code_titles to see which chapter ranges exist under each title.',
      data_as_of: new Date().toISOString(),
    };
  }

  const sliced = sliceIowaSection(chapterResult.text, citation);
  if (!sliced) {
    return {
      found: false, reason: 'section_not_found', citation, chapter, year,
      message: `No section ${citation} found in chapter ${chapter} of the ${year} Iowa Code.`,
      hint: 'Section numbers are not contiguous — repealed or renumbered sections are normal. Try a different year, or ia_code_search to find the right section by topic.',
      data_as_of: new Date().toISOString(),
    };
  }

  const headingLine = sliced.split('\n', 1)[0] ?? '';
  const headingText = headingLine.slice(citation.length).trim() || null;
  const isReserved = /^Reserved\.?$/i.test(headingText ?? '');

  const { statute, history, referred_to_in } = splitHistory(sliced);
  const url = `https://www.legis.iowa.gov/docs/code/${year}/${chapter}.rtf`;

  return {
    found: true,
    citation: `Iowa Code § ${citation}`,
    section: citation,
    chapter,
    heading: headingText,
    reserved: isReserved,
    text: statute,
    text_chars: statute.length,
    history,
    referred_to_in,
    year,
    is_current_edition: year === CURRENT_YEAR,
    url,
    source: `${UPSTREAM}, official RTF edition of chapter ${chapter}, keyless`,
    attribution: 'Iowa statutes are public record; the current edition designated official under Iowa Code § 2B.17.',
    data_as_of: new Date().toISOString(),
  };
}

async function iaCodeTitles() {
  return {
    titles: TITLE_ORDER.map((roman) => ({
      title: roman,
      name: TITLES[roman]!.name,
      chapters: TITLES[roman]!.range,
    })),
    count: TITLE_ORDER.length,
    hint: 'Pass a chapter number from the right range to ia_code_search, or a known citation straight to ia_code_section.',
    source: `${UPSTREAM} title listing, keyless`,
    data_as_of: new Date().toISOString(),
  };
}

interface ChapterHit { chapter: string; caption: string; title: string; title_name: string; score: number }
interface SectionHit { section: string; caption: string; chapter: string; title: string; title_name: string; score: number }

/**
 * IDF-weighted word overlap: a word present in FEW captions counts for more
 * than one present in many. Plain word-count scoring ranks "security
 * deposit" (chapter 12C, bank deposits of PUBLIC FUNDS — "security" and
 * "deposit" both common words across many chapter captions) above chapter
 * 562A, "UNIFORM RESIDENTIAL LANDLORD AND TENANT LAW" — the actually-wanted
 * chapter, which only contains the rarer word "landlord" but contains it
 * distinctively. Weighting by rarity fixes that without hand-tuning any
 * particular query.
 */
function scoreCaption(words: string[], caption: string, weight: Map<string, number>): number {
  const lower = caption.toLowerCase();
  let score = 0;
  for (const w of words) if (lower.includes(w)) score += weight.get(w) ?? 1;
  return score;
}

function wordWeights(words: string[], captions: string[]): Map<string, number> {
  const weight = new Map<string, number>();
  for (const w of words) {
    const df = captions.reduce((n, c) => n + (c.toLowerCase().includes(w) ? 1 : 0), 0);
    weight.set(w, 1 / Math.max(1, df));
  }
  return weight;
}

async function fetchChapterListing(title: string, year: number): Promise<Array<{ chapter: string; caption: string }>> {
  const url = `https://www.legis.iowa.gov/law/iowaCode/chapters?title=${title}&year=${year}`;
  const res = await pwFetch(url);
  if (!res.ok) return [];
  const html = await res.text();
  const rows: Array<{ chapter: string; caption: string }> = [];
  const re = /<td>Chapter (\d+[A-Z]*) - ([^<]+)<\/td>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const caption = m[2]!.trim();
    if (caption === 'RESERVED') continue;
    rows.push({ chapter: m[1]!, caption });
  }
  return rows;
}

async function fetchSectionListing(chapter: string, year: number): Promise<Array<{ section: string; caption: string }>> {
  const url = `https://www.legis.iowa.gov/law/iowaCode/sections?codeChapter=${chapter}&year=${year}`;
  const res = await pwFetch(url);
  if (!res.ok) return [];
  const html = await res.text();
  const rows: Array<{ section: string; caption: string }> = [];
  const re = /<td>&#167;([^\s<]+)(?:\s*-\s*([^<]+))?<\/td>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const caption = (m[2] ?? '').trim();
    if (!caption || /^reserved\.?$/i.test(caption)) continue;
    rows.push({ section: m[1]!, caption });
  }
  return rows;
}

async function iaCodeSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false, reason: 'empty_query',
      message: 'ia_code_search needs a "query" — a topic or a few keywords, e.g. "landlord security deposit" or "concealed handgun permit".',
      hint: 'To look up a known citation directly, use ia_code_section instead.',
    };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) {
    return {
      found: false, reason: 'query_too_short', query: q,
      message: `"${q}" has no word of 3+ characters to match against chapter and section captions.`,
    };
  }

  const listings = await Promise.all(
    TITLE_ORDER.map(async (title) => {
      const chapters = await fetchChapterListing(title, CURRENT_YEAR);
      return chapters.map((c) => ({ ...c, title, title_name: TITLES[title]!.name }));
    }),
  );
  const allChapters = listings.flat();
  const chapterWeight = wordWeights(words, allChapters.map((c) => c.caption));

  const chapterHits: ChapterHit[] = allChapters
    .map((c) => ({ chapter: c.chapter, caption: c.caption, title: c.title, title_name: c.title_name, score: scoreCaption(words, c.caption, chapterWeight) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!chapterHits.length) {
    return {
      found: false, query: q,
      message: `No chapter caption in the Iowa Code matched "${q}".`,
      hint: 'This matches official chapter and section CAPTIONS, not full statutory text — try shorter or more literal terms (e.g. "theft" rather than "stealing someone\'s property").',
      chapters_scanned: allChapters.length,
      data_as_of: new Date().toISOString(),
    };
  }

  // Drill into section-level captions for the best-matching chapters only —
  // bounded fan-out, see the file header. 10 rather than fewer because the
  // IDF weighting above still leaves ties near the cutoff on short queries.
  const topChapters = chapterHits.slice(0, Math.min(10, chapterHits.length));
  const sectionListings = await Promise.all(
    topChapters.map(async (c) => {
      const sections = await fetchSectionListing(c.chapter, CURRENT_YEAR);
      return sections.map((s) => ({ ...s, chapter: c.chapter, title: c.title, title_name: c.title_name }));
    }),
  );
  const allSections = sectionListings.flat();
  // Re-use the CHAPTER-level weights (computed over all 1400+ chapters)
  // rather than re-deriving a weight from just these ~10 chapters' own
  // sections: a word's rarity within such a small, already-filtered pool is
  // noise, not signal — e.g. "security" looks rare among ONLY the chapters
  // that matched "deposit", so it would outweigh "deposit" itself if
  // recomputed locally, inverting the ranking for no good reason.
  const sectionHits: SectionHit[] = allSections
    .map((s) => ({ section: s.section, caption: s.caption, chapter: s.chapter, title: s.title, title_name: s.title_name, score: scoreCaption(words, s.caption, chapterWeight) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (sectionHits.length) {
    return {
      found: true,
      query: q,
      count: sectionHits.length,
      results: sectionHits.map((s) => ({
        citation: `Iowa Code § ${s.section}`,
        section: s.section,
        heading: s.caption,
        chapter: s.chapter,
        title: s.title,
        title_name: s.title_name,
      })),
      match_level: 'section_caption',
      hint: 'Call ia_code_section with the section from a result to get its full text.',
      source: `${UPSTREAM} chapter and section listing pages, keyless`,
      data_as_of: new Date().toISOString(),
    };
  }

  return {
    found: true,
    query: q,
    count: Math.min(limit, chapterHits.length),
    results: chapterHits.slice(0, limit).map((c) => ({
      chapter: c.chapter,
      heading: c.caption,
      title: c.title,
      title_name: c.title_name,
    })),
    match_level: 'chapter_caption',
    hint: 'No individual section caption matched — these chapters did by name. Call ia_code_section for a specific section once you know its number, or browse the chapter at legis.iowa.gov.',
    source: `${UPSTREAM} chapter listing pages, keyless`,
    data_as_of: new Date().toISOString(),
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ia_code_section',
    description:
      'Get the FULL TEXT of a section of the Iowa Code — Iowa state law — by citation. "714.2" is degrees of theft; "321J.2" is operating while intoxicated (OWI). Returns the statute text plus its amendment history (the Acts that enacted/amended it) and cross-references ("Referred to in ..."), each as a separate field. Pass "year" (2000, or 2004 through the current year) to get a historical edition instead of the current one. Keyless. Use for "what does Iowa Code 714.2 say", "Iowa OWI law", or to check an Iowa statute a case relies on.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section as cited, e.g. "714.2" or "321J.2". The chapter is the part before the dot and may carry letters, e.g. "714A.1" or "6B.1".' },
        year: { type: 'integer', description: `Optional. An Iowa Code edition year (${MIN_YEAR}, or ${MIN_YEAR + 4}-${CURRENT_YEAR}) to retrieve a historical version instead of the current one. 2001-2003 were never published online by the Legislature. Omit for the current (${CURRENT_YEAR}) edition.` },
      },
      required: ['section'],
    },
  },
  {
    name: 'ia_code_titles',
    description:
      'List the 16 titles of the Iowa Code with their official names and chapter-number ranges, e.g. Title XVI is Criminal Law and Procedure (chapters 687-916). Routing help for when you know the subject but not the chapter/section number — call this or ia_code_search before guessing a citation. Keyless.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ia_code_search',
    description:
      'Search the Iowa Code by TOPIC or keyword rather than citation, e.g. "landlord security deposit", "concealed handgun permit", "operating while intoxicated". Matches against the Iowa Legislature\'s own official chapter and section CAPTIONS (not full statutory prose — Iowa does not publish a general-index or full-text search of Code section text, verified live) across all 16 titles, then returns the matching sections (or, if none match at the section level, the matching chapters) with their citations. Use ia_code_section afterward for the full text of a result. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "landlord security deposit".' },
        limit: { type: 'number', description: 'Max results, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ia_code_section': return iaCodeSection(args);
    case 'ia_code_titles': return iaCodeTitles();
    case 'ia_code_search': return iaCodeSearch(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
