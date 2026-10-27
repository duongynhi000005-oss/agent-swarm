import {
  MAX_REDIRECTS,
  MAX_REPLAY_BODY_BYTES,
  nextHopRequest,
  REDIRECT_STATUSES,
  RequestBodyTooLargeError,
  replayableBody,
} from "../../utils/egress-guard";
import type { FailedCredentialBinding, ResolvedCredentialBinding } from "./types";

const IntrinsicHeaders = globalThis.Headers;
const IntrinsicRequest = globalThis.Request;
const IntrinsicURL = globalThis.URL;
const IntrinsicURLSearchParams = globalThis.URLSearchParams;
const IntrinsicTypeError = globalThis.TypeError;
const IntrinsicError = globalThis.Error;
const objectCreate = Object.create;
const objectAssign = Object.assign;
const objectFreeze = Object.freeze;

const bindCall = Function.prototype.bind.bind(Function.prototype.call) as <
  T,
  A extends unknown[],
  R,
>(
  fn: (this: T, ...args: A) => R,
) => (thisArg: T, ...args: A) => R;

const headersEntries = bindCall(IntrinsicHeaders.prototype.entries);
const headersGet = bindCall(IntrinsicHeaders.prototype.get);
const headersSet = bindCall(IntrinsicHeaders.prototype.set);
const headersDelete = bindCall(IntrinsicHeaders.prototype.delete);
const headersIteratorNext = bindCall(
  Object.getPrototypeOf(headersEntries(new IntrinsicHeaders())).next,
) as (iter: IterableIterator<[string, string]>) => IteratorResult<[string, string]>;

const urlHref = bindCall(Object.getOwnPropertyDescriptor(IntrinsicURL.prototype, "href")!.get!);
const urlHostname = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicURL.prototype, "hostname")!.get!,
);
const urlOrigin = bindCall(Object.getOwnPropertyDescriptor(IntrinsicURL.prototype, "origin")!.get!);
const urlSearchParams = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicURL.prototype, "searchParams")!.get!,
);

const searchParamsGetAll = bindCall(IntrinsicURLSearchParams.prototype.getAll);
const searchParamsDelete = bindCall(IntrinsicURLSearchParams.prototype.delete);
const searchParamsAppend = bindCall(IntrinsicURLSearchParams.prototype.append);

const requestUrl = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicRequest.prototype, "url")!.get!,
);
const requestHeaders = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicRequest.prototype, "headers")!.get!,
);
const requestMethod = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicRequest.prototype, "method")!.get!,
);
const requestBody = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicRequest.prototype, "body")!.get!,
);
const requestRedirect = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicRequest.prototype, "redirect")!.get!,
);
const requestSignal = bindCall(
  Object.getOwnPropertyDescriptor(IntrinsicRequest.prototype, "signal")!.get!,
);

const responseHeaders = bindCall(
  Object.getOwnPropertyDescriptor(Response.prototype, "headers")!.get!,
);
const responseStatus = bindCall(
  Object.getOwnPropertyDescriptor(Response.prototype, "status")!.get!,
);
const responseBody = bindCall(Object.getOwnPropertyDescriptor(Response.prototype, "body")!.get!);

const stringIncludes = bindCall(String.prototype.includes);
const stringIndexOf = bindCall(String.prototype.indexOf);
const stringSlice = bindCall(String.prototype.slice);
const stringTrim = bindCall(String.prototype.trim);
const stringToLowerCase = bindCall(String.prototype.toLowerCase);

type InternalBinding = {
  readonly allowedHosts: readonly string[];
  readonly headerName: string | null;
  readonly queryParamName: string | null;
  readonly placeholder: string;
  readonly value: string;
};

type InternalFailedBinding = {
  readonly allowedHosts: readonly string[];
  readonly placeholder: string;
  readonly reason: string;
  readonly authorizationLabel?: string;
};

function replaceLiteral(input: string, search: string, replacement: string): string {
  if (search.length === 0) return input;
  let out = "";
  let cursor = 0;
  while (true) {
    const index = stringIndexOf(input, search, cursor);
    if (index === -1) {
      return cursor === 0 ? input : out + stringSlice(input, cursor);
    }
    out += stringSlice(input, cursor, index) + replacement;
    cursor = index + search.length;
  }
}

function hostMatches(allowedHosts: readonly string[], hostname: string): boolean {
  for (let i = 0; i < allowedHosts.length; i++) {
    if (allowedHosts[i] === hostname) return true;
  }
  return false;
}

function headerNameForTemplate(headerTemplate: string | undefined): string | null {
  if (!headerTemplate) return null;
  const separator = stringIndexOf(headerTemplate, ":");
  if (separator <= 0) return null;
  const name = stringToLowerCase(stringTrim(stringSlice(headerTemplate, 0, separator)));
  return name.length > 0 ? name : null;
}

function queryParamNameForTemplate(
  queryTemplate: string | undefined,
  placeholder: string,
): string | null {
  if (!queryTemplate) return null;
  const separator = stringIndexOf(queryTemplate, "=");
  if (separator <= 0) return null;
  const paramName = stringSlice(queryTemplate, 0, separator);
  const paramTemplate = stringSlice(queryTemplate, separator + 1);
  if (!stringIncludes(paramTemplate, placeholder)) return null;
  return paramName;
}

function snapshotBindings(bindings: ResolvedCredentialBinding[]): readonly InternalBinding[] {
  const out: InternalBinding[] = [];
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i]!;
    out.push(
      objectFreeze({
        allowedHosts: objectFreeze([...binding.allowedHosts]),
        headerName: headerNameForTemplate(binding.headerTemplate),
        queryParamName: queryParamNameForTemplate(binding.queryTemplate, binding.placeholder),
        placeholder: binding.placeholder,
        value: binding.value,
      }),
    );
  }
  return objectFreeze(out);
}

function snapshotFailedBindings(
  failedBindings: FailedCredentialBinding[],
): readonly InternalFailedBinding[] {
  const out: InternalFailedBinding[] = [];
  for (let i = 0; i < failedBindings.length; i++) {
    const failed = failedBindings[i]!;
    out.push(
      objectFreeze({
        allowedHosts: objectFreeze([...failed.allowedHosts]),
        placeholder: failed.placeholder,
        reason: failed.reason,
        authorizationLabel: failed.authorizationLabel,
      }),
    );
  }
  return objectFreeze(out);
}

function urlForFetchInput(input: string | URL | Request): URL | null {
  try {
    const raw =
      input instanceof IntrinsicRequest
        ? requestUrl(input)
        : input instanceof IntrinsicURL
          ? urlHref(input)
          : input;
    return new IntrinsicURL(raw);
  } catch {
    return null;
  }
}

function cloneRequestInit(input: string | URL | Request, init?: RequestInit): RequestInit {
  const base =
    input instanceof IntrinsicRequest
      ? {
          method: requestMethod(input),
          body: requestBody(input),
          redirect: requestRedirect(input),
          signal: requestSignal(input),
        }
      : {};
  return objectAssign(objectCreate(null), base, init ?? {});
}

function applyQueryTemplates(url: URL, bindings: readonly InternalBinding[]): boolean {
  let modified = false;
  const hostname = urlHostname(url);
  const searchParams = urlSearchParams(url);

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i]!;
    if (!hostMatches(binding.allowedHosts, hostname) || !binding.queryParamName) continue;

    const values = searchParamsGetAll(searchParams, binding.queryParamName);
    if (values.length === 0) continue;

    searchParamsDelete(searchParams, binding.queryParamName);
    for (let j = 0; j < values.length; j++) {
      const value = values[j]!;
      const nextValue = stringIncludes(value, binding.placeholder)
        ? replaceLiteral(value, binding.placeholder, binding.value)
        : value;
      if (nextValue !== value) modified = true;
      searchParamsAppend(searchParams, binding.queryParamName, nextValue);
    }
  }

  return modified;
}

function stripCrossOriginCredentialHeaders(
  headers: Headers,
  bindings: readonly InternalBinding[],
): void {
  for (let i = 0; i < bindings.length; i++) {
    const headerName = bindings[i]?.headerName;
    if (headerName) headersDelete(headers, headerName);
  }
}

function assertNoFailedBinding(
  failedBindings: readonly InternalFailedBinding[],
  hostname: string,
  url: URL,
  headers: Headers,
): void {
  if (failedBindings.length === 0) return;
  const href = urlHref(url);
  for (let i = 0; i < failedBindings.length; i++) {
    const failed = failedBindings[i]!;
    if (!hostMatches(failed.allowedHosts, hostname)) continue;
    const inUrl = stringIncludes(href, failed.placeholder);
    let inHeaders = false;
    if (!inUrl) {
      const iter = headersEntries(headers);
      while (true) {
        const step = headersIteratorNext(iter);
        if (step.done) break;
        if (stringIncludes(step.value[1], failed.placeholder)) {
          inHeaders = true;
          break;
        }
      }
    }
    if (inUrl || inHeaders) {
      throw new IntrinsicError(
        `OAuth authorization '${failed.authorizationLabel ?? "unknown"}' is in refresh-failed state: ${failed.reason}`,
      );
    }
  }
}

export function patchFetchWithCredentialBroker(
  bindings: ResolvedCredentialBinding[],
  failedBindings: FailedCredentialBinding[] = [],
): void {
  // Always install: even with zero resolved bindings (fresh install, identity
  // without the credential) the wrapper must strip unresolved placeholder
  // headers below, or the literal placeholder rides to the provider as a
  // guaranteed 401 and optional-auth APIs stop serving public data.
  const originalFetch = globalThis.fetch;
  const internalBindings = snapshotBindings(bindings);
  const internalFailedBindings = snapshotFailedBindings(failedBindings);

  async function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
    hop = 0,
  ): Promise<Response> {
    const url = urlForFetchInput(input);
    const hostname = url ? urlHostname(url) : null;
    if (!hostname || !url) return originalFetch(input, init);

    const headers = new IntrinsicHeaders(
      input instanceof IntrinsicRequest ? requestHeaders(input) : init?.headers,
    );

    // Fail closed: a request that would carry a broken binding's placeholder to
    // its host throws a typed error instead of leaking the placeholder.
    assertNoFailedBinding(internalFailedBindings, hostname, url, headers);

    let headersModified = false;
    const newHeaders = new IntrinsicHeaders();
    const iter = headersEntries(headers);

    while (true) {
      const step = headersIteratorNext(iter);
      if (step.done) break;
      const key = step.value[0];
      const lowerKey = stringToLowerCase(key);
      let value = step.value[1];
      for (let i = 0; i < internalBindings.length; i++) {
        const binding = internalBindings[i]!;
        if (
          binding.headerName === lowerKey &&
          hostMatches(binding.allowedHosts, hostname) &&
          stringIncludes(value, binding.placeholder)
        ) {
          value = replaceLiteral(value, binding.placeholder, binding.value);
          headersModified = true;
        }
      }
      // A placeholder still present after substitution means the credential is
      // not configured (or not allowed) for this identity, host, or header:
      // drop the header instead of sending the literal, so optional-auth
      // providers can still serve public data unauthenticated.
      if (stringIncludes(value, "[REDACTED:")) {
        headersModified = true;
        continue;
      }
      headersSet(newHeaders, key, value);
    }

    const requestUrlObj = new IntrinsicURL(urlHref(url));
    const urlModified = applyQueryTemplates(requestUrlObj, internalBindings);

    // Once the broker follows a redirect it keeps following every later hop,
    // so the chain has one hop budget even where the fetch below also counts.
    if (!headersModified && !urlModified && hop === 0) return originalFetch(input, init);

    const callerInit = cloneRequestInit(input, init);
    const redirectMode = callerInit.redirect ?? "follow";
    // A 307/308 sends the body again, so a short stream (a Request body) is read
    // once here; a longer one is sent unbuffered and cannot follow such a hop.
    let replayable = true;
    if (redirectMode === "follow") {
      const prepared = await replayableBody(callerInit.body, callerInit.signal);
      callerInit.body = prepared.body;
      replayable = prepared.replayable;
    }
    const mergedInit: RequestInit = objectAssign(objectCreate(null), callerInit, {
      headers: headersModified || input instanceof IntrinsicRequest ? newHeaders : init?.headers,
      // Never let the fetch follow a redirect with the substituted credential
      // attached: each hop goes back through the broker, which substitutes
      // again only for an allowed host and origin.
      redirect: "manual",
    });
    const nextUrl = urlModified
      ? urlHref(requestUrlObj)
      : input instanceof IntrinsicRequest
        ? requestUrl(input)
        : input;
    const response = await originalFetch(nextUrl, mergedInit);
    const status = responseStatus(response);
    const location = headersGet(responseHeaders(response), "location");
    if (redirectMode === "manual" || !REDIRECT_STATUSES.has(status) || !location) {
      return response;
    }
    if (redirectMode === "error")
      throw new IntrinsicTypeError(`fetch redirect refused (redirect: "error"): ${urlHref(url)}`);
    if (hop >= MAX_REDIRECTS)
      throw new IntrinsicTypeError(`fetch exceeded ${MAX_REDIRECTS} redirects: ${urlHref(url)}`);
    await responseBody(response)
      ?.cancel()
      .catch(() => {});
    const next = new IntrinsicURL(location, urlHref(url));
    // Re-enter with the caller's placeholder headers, not the substituted ones.
    const hopRequest = nextHopRequest(status, url, next, {
      method: callerInit.method ?? "GET",
      headers,
      body: callerInit.body ?? undefined,
    });
    if (urlOrigin(next) !== urlOrigin(url)) {
      stripCrossOriginCredentialHeaders(hopRequest.headers, internalBindings);
    }
    if (!replayable && hopRequest.body !== undefined) {
      throw new RequestBodyTooLargeError(MAX_REPLAY_BODY_BYTES);
    }
    return patchedFetch(
      urlHref(next),
      objectAssign(objectCreate(null), callerInit, hopRequest, { redirect: redirectMode }),
      hop + 1,
    );
  }

  globalThis.fetch = objectAssign(
    (input: string | URL | Request, init?: RequestInit) => patchedFetch(input, init),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}
