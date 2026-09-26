const ORIGIN = "https://scanneraz-api.onrender.com";
const EDGE_SECRET_ENV = "SCANNERAZ_EDGE_SHARED_SECRET";

/**
 * Fixed-origin reverse proxy for ScannerAz.
 *
 * Keep this worker deployed as `scanneraz-edge-proxy` in Cloudflare. The
 * origin is deliberately constant so a caller cannot turn this into an open
 * proxy by manipulating the request URL or headers.
 */
export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.protocol === "http:") {
      incomingUrl.protocol = "https:";
      return Response.redirect(incomingUrl.toString(), 301);
    }

    const edgeSecret = env[EDGE_SECRET_ENV];

    if (!edgeSecret) {
      return new Response("ScannerAz edge is not configured.", {
        status: 503,
        headers: { "cache-control": "no-store" }
      });
    }

    const upstreamUrl = new URL(ORIGIN);
    upstreamUrl.pathname = incomingUrl.pathname;
    upstreamUrl.search = incomingUrl.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("X-Forwarded-Host", incomingUrl.host);
    headers.set("X-Forwarded-Proto", incomingUrl.protocol.slice(0, -1));
    headers.set("X-ScannerAz-Edge", "cloudflare");
    headers.set("X-ScannerAz-Edge-Auth", edgeSecret);

    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) {
      headers.set("X-Forwarded-For", clientIp);
    }

    const init = {
      method: request.method,
      headers,
      redirect: "manual"
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    const response = await fetch(upstreamUrl.toString(), init);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("X-ScannerAz-Edge", "cloudflare");
    responseHeaders.set("Cache-Control", responseHeaders.get("Cache-Control") || "no-store");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  }
};
