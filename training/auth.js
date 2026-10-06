const rawConfig = window.PANALO_TRAINING_CONFIG || {};

export const config = Object.freeze({
  supabaseUrl: String(rawConfig.supabaseUrl || "").replace(/\/$/, ""),
  publishableKey: String(rawConfig.publishableKey || ""),
  appUrl: String(rawConfig.appUrl || new URL("./", window.location.href)),
  trainingFunction: String(rawConfig.trainingFunction || "training-api"),
  adminFunction: String(rawConfig.adminFunction || "admin-api"),
  imsFunction: String(rawConfig.imsFunction || "ims-api"),
  financeFunction: String(rawConfig.financeFunction || "finance-api")
});

const SESSION_KEY = "panalo-training-session-v1";
let sessionCache = readStoredSession();

export function isConfigured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.supabaseUrl) &&
    /^(sb_publishable_|eyJ)/.test(config.publishableKey);
}

function readStoredSession() {
  try {
    const value = JSON.parse(window.localStorage.getItem(SESSION_KEY));
    return value?.access_token && value?.refresh_token ? value : null;
  } catch (_) {
    return null;
  }
}

function saveSession(value) {
  sessionCache = value;
  if (value) window.localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else window.localStorage.removeItem(SESSION_KEY);
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error_description || data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

function authHeaders(accessToken) {
  const headers = {
    apikey: config.publishableKey,
    "Content-Type": "application/json",
    "X-Client-Info": "panalo-training-portal/1.0"
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

export function completeAuthRedirect() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const error = hash.get("error_description") || hash.get("error");
  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");

  if (accessToken && refreshToken) {
    const expiresIn = Number(hash.get("expires_in") || 3600);
    saveSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_type: hash.get("token_type") || "bearer"
    });
  }

  if (window.location.hash) {
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  }

  // "invite" and "recovery" links arrive signed in and must set a password next.
  return { authenticated: Boolean(accessToken && refreshToken), error, type: hash.get("type") || null };
}

function cleanEmail(email) {
  const address = String(email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error("Enter a valid email address.");
  return address;
}

export async function signInWithPassword(email, password) {
  if (!isConfigured()) throw new Error("The secure training service has not been connected yet.");
  const address = cleanEmail(email);
  if (!password) throw new Error("Enter your password.");
  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: address, password: String(password) })
  });
  let data;
  try {
    data = await parseResponse(response);
  } catch (error) {
    // Never reveal whether the email exists.
    if (error.status === 400 || error.status === 401 || error.status === 422) {
      const wrapped = new Error("That email and password don't match. Check them, or use Forgot password.");
      wrapped.status = 400;
      throw wrapped;
    }
    throw error;
  }
  saveSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    token_type: data.token_type || "bearer"
  });
  return data;
}

export async function requestPasswordReset(email) {
  if (!isConfigured()) throw new Error("The secure training service has not been connected yet.");
  const address = cleanEmail(email);
  const redirectTo = new URL(config.appUrl, window.location.href).href;
  const response = await fetch(`${config.supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: address })
  });
  // The response is the same whether or not the account exists.
  if (!response.ok && response.status !== 429) await parseResponse(response).catch(() => null);
  if (response.status === 429) throw new Error("Too many requests. Wait a minute and try again.");
}

async function refreshSession() {
  if (!sessionCache?.refresh_token) return null;
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: sessionCache.refresh_token })
    });
    const data = await parseResponse(response);
    saveSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token || sessionCache.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
      token_type: data.token_type || "bearer"
    });
    return sessionCache;
  } catch (_) {
    saveSession(null);
    return null;
  }
}

export async function getSession({ refresh = true } = {}) {
  if (!sessionCache) return null;
  const expiresSoon = Number(sessionCache.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60;
  if (refresh && expiresSoon) return refreshSession();
  return sessionCache;
}

export async function signOut() {
  const session = await getSession({ refresh: false });
  if (session?.access_token && isConfigured()) {
    try {
      await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
        method: "POST",
        headers: authHeaders(session.access_token)
      });
    } catch (_) {
      // Local sign-out still completes when the network is unavailable.
    }
  }
  saveSession(null);
}

export async function api(functionName, body, retry = true) {
  if (!isConfigured()) throw new Error("The secure training service has not been connected yet.");
  const session = await getSession();
  if (!session?.access_token) {
    const error = new Error("Your sign-in has expired. Please sign in again.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${config.supabaseUrl}/functions/v1/${encodeURIComponent(functionName)}`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify(body || {})
  });

  if (response.status === 401 && retry && await refreshSession()) {
    return api(functionName, body, false);
  }
  return parseResponse(response);
}

/* ---------------- Multi-factor authentication (TOTP) ---------------- */

/** Assurance level of the current session: "aal1" (password) or "aal2" (password + authenticator). */
export function sessionAal() {
  const token = sessionCache?.access_token || "";
  const part = token.split(".")[1];
  if (!part) return "aal1";
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return String(payload.aal || "aal1");
  } catch (_) {
    return "aal1";
  }
}

async function authCall(path, method = "GET", body) {
  const session = await getSession();
  if (!session?.access_token) {
    const error = new Error("Your sign-in has expired. Please sign in again.");
    error.status = 401;
    throw error;
  }
  const response = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
    method, headers: authHeaders(session.access_token), body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parseResponse(response);
}

/** The signed-in user's authenticator factors. */
export async function mfaFactors() {
  const user = await authCall("user");
  return (user?.factors || []).filter(f => f.factor_type === "totp");
}

/** Starts authenticator set-up; returns the factor id, QR code (SVG data URL) and secret. */
export async function mfaEnroll(friendlyName = "Panalo Accounts") {
  // An abandoned set-up leaves an unverified factor that blocks the same name.
  for (const f of await mfaFactors()) {
    if (f.status !== "verified") await authCall(`factors/${encodeURIComponent(f.id)}`, "DELETE").catch(() => null);
  }
  const data = await authCall("factors", "POST", { factor_type: "totp", friendly_name: friendlyName });
  return { id: data.id, qrCode: data.totp?.qr_code, secret: data.totp?.secret };
}

/** Checks a 6-digit code and upgrades the session to aal2. */
export async function mfaVerify(factorId, code) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) throw new Error("Enter the 6-digit code from your authenticator app.");
  const challenge = await authCall(`factors/${encodeURIComponent(factorId)}/challenge`, "POST", {});
  let data;
  try {
    data = await authCall(`factors/${encodeURIComponent(factorId)}/verify`, "POST", { challenge_id: challenge.id, code: clean });
  } catch (error) {
    if (error.status === 400 || error.status === 422) throw new Error("That code didn't work. Codes change every 30 seconds; try the current one.");
    throw error;
  }
  saveSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token || sessionCache?.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    token_type: data.token_type || "bearer"
  });
  return true;
}

export function friendlyError(error) {
  if (error?.status === 401) return "Your sign-in has expired. Please sign in again.";
  if (error?.status === 403) return error.message || "This account does not have access to that training.";
  return error?.message || "Something went wrong. Please try again.";
}
