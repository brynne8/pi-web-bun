import assert from "node:assert/strict";

// The UI must preserve omitted protocols so discovery can resolve them through
// pi's catalogue. These routes isolate the panel from credentials and upstreams.
//
// The fixtures are registered when the page is created, not when this check runs:
// ModelsConfig reads `/api/models-config` once on mount, so installing later would
// miss that read if an earlier check had already opened Settings.

const CONFIG_ROUTE = "**/api/models-config";
const DISCOVERY_ROUTE = "**/api/models-config/discover";

/**
 * Registers the models-config fixtures on `page`.
 * Call this right after the page is created, before the first navigation.
 */
export async function installModelDiscoveryStub(page) {
  const config = { providers: {
    anthropic: { models: [{ id: "claude-existing" }] },
    relay: { baseUrl: "https://example.invalid/v1", api: "openai-responses", models: [{ id: "relay-existing" }] },
  } };
  const stub = { discoveries: [], saved: undefined };
  await page.route(CONFIG_ROUTE, (route) => {
    if (route.request().method() === "PUT") {
      stub.saved = route.request().postDataJSON();
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: config });
  });
  await page.route(DISCOVERY_ROUTE, (route) => {
    stub.discoveries.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      models: [{ id: "discovered-fixture" }], endpoint: "https://example.invalid/v1/models",
    } });
  });
  return stub;
}

export async function checkModelDiscovery(page, stub) {
  const discoveries = stub?.discoveries ?? [];
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: "Models", exact: true }).click();
    await settings.locator(".config-sidebar-item").filter({ hasText: /^anthropic$/ }).click();
    const api = settings.locator(".config-field-label").filter({ hasText: /^API$/ }).locator("..").locator("select");
    assert.equal(await api.inputValue(), "", "A missing protocol stays unspecified in the editor");
    const discover = async () => {
      const response = page.waitForResponse((reply) => reply.url().endsWith("/api/models-config/discover"));
      await settings.getByRole("button", { name: "Import models…", exact: true }).click();
      await response;
    };
    await discover();
    assert.equal(discoveries[0].providerName, "anthropic");
    assert.equal(discoveries[0].provider.api, undefined, "Discovery must reach the catalog protocol fallback");
    assert.equal(discoveries[0].provider.baseUrl, undefined);

    await settings.locator(".config-sidebar-item").filter({ hasText: /^relay$/ }).click();
    assert.equal(await api.inputValue(), "openai-responses");
    await discover();
    assert.equal(discoveries[1].provider.api, "openai-responses", "Explicit protocols must stay authoritative");
    assert.equal(discoveries[1].provider.baseUrl, "https://example.invalid/v1");

    const saveResponse = page.waitForResponse((reply) => reply.url().endsWith("/api/models-config") && reply.request().method() === "PUT");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await saveResponse;
    assert.equal(stub.saved.providers.anthropic.api, undefined, "Visiting a provider must not persist a guessed protocol");
    assert.equal(stub.saved.providers.relay.api, "openai-responses");
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    console.log("PASS: discovery preserves catalog protocols and explicit overrides without changing them on Save");
  } finally {
    await page.unroute(CONFIG_ROUTE);
    await page.unroute(DISCOVERY_ROUTE);
  }
}
