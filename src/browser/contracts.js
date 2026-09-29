export class BrowserCapability {
  async open(_url) {
    throw new Error("BrowserCapability.open must be implemented");
  }

  async snapshot() {
    throw new Error("BrowserCapability.snapshot must be implemented");
  }

  async consoleMessages() {
    throw new Error("BrowserCapability.consoleMessages must be implemented");
  }

  async networkEvents() {
    throw new Error("BrowserCapability.networkEvents must be implemented");
  }
}

export function assertAllowedNavigation(rawUrl, allowedLocalPorts = []) {
  const url = new URL(rawUrl);
  if (url.protocol === "https:") return url;

  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const port = Number(url.port || 80);
  if (url.protocol === "http:" && localHosts.has(url.hostname) && allowedLocalPorts.includes(port)) {
    return url;
  }
  throw new Error(`browser navigation is not allowed: ${url.origin}`);
}

