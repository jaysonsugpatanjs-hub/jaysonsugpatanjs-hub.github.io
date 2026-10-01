import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map();
globalThis.window = {
  PANALO_TRAINING_CONFIG: {
    supabaseUrl: "https://abc123.supabase.co",
    publishableKey: "sb_publishable_test_key",
    appUrl: "https://example.com/training/",
    trainingFunction: "training-api",
    adminFunction: "admin-api"
  },
  location: {
    href: "https://example.com/training/#access_token=access-1&refresh_token=refresh-1&expires_in=3600&token_type=bearer",
    pathname: "/training/",
    search: "",
    hash: "#access_token=access-1&refresh_token=refresh-1&expires_in=3600&token_type=bearer"
  },
  history: { replaceState() { window.location.hash = ""; } },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); }
  }
};
globalThis.document = { title: "Training" };

const auth = await import("../auth.js?auth-test");

test("valid public configuration is recognised", () => {
  assert.equal(auth.isConfigured(), true);
});

test("magic-link callback stores and removes the URL session fragment", async () => {
  const result = auth.completeAuthRedirect();
  assert.equal(result.authenticated, true);
  assert.equal(window.location.hash, "");
  assert.equal((await auth.getSession()).access_token, "access-1");
});

test("password sign-in stores the session and hides whether the email exists", async () => {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ access_token: "pw-access", refresh_token: "pw-refresh", expires_in: 3600, token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await auth.signInWithPassword(" Learner@Example.com ", "Grinder-Torch-47");
  assert.match(captured.url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.deepEqual(JSON.parse(captured.options.body), { email: "learner@example.com", password: "Grinder-Torch-47" });
  assert.equal((await auth.getSession()).access_token, "pw-access");

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }), { status: 400 });
  await assert.rejects(auth.signInWithPassword("nobody@example.com", "wrong"), /don't match/);
});

test("password reset uses the configured redirect", async () => {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await auth.requestPasswordReset("Learner@Example.com");
  assert.match(captured.url, /\/auth\/v1\/recover\?redirect_to=/);
  assert.equal(new URL(captured.url).searchParams.get("redirect_to"), "https://example.com/training/");
  assert.deepEqual(JSON.parse(captured.options.body), { email: "learner@example.com" });
});

test("function request sends the verified access token", async () => {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ assignments: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await auth.api("training-api", { action: "bootstrap" });
  assert.deepEqual(result, { assignments: [] });
  assert.equal(captured.options.headers.Authorization, "Bearer pw-access");
  assert.equal(JSON.parse(captured.options.body).action, "bootstrap");
});

test("sign out clears the local session even if the server is unavailable", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  await auth.signOut();
  assert.equal(await auth.getSession(), null);
});
