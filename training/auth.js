const rawConfig = window.PANALO_TRAINING_CONFIG || {};

export const config = Object.freeze({
  supabaseUrl: String(rawConfig.supabaseUrl || "").replace(/\/$/, ""),
  publishableKey: String(rawConfig.publishableKey || ""),
  appUrl: String(rawConfig.appUrl || new URL("./", window.location.href)),
  trainingFunction: String(rawConfig.trainingFunction || "training-api"),
  adminFunction: String(rawConfig.adminFunction || "admin-api"),
  imsFunction: String(rawConfig.imsFunction || "ims-api")
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

  return { authenticated: Boolean(accessToken && refreshToken), error };
}

export async function sendMagicLink(email) {
  if (!isConfigured()) throw new Error("The secure training service has not been connected yet.");
  const address = String(email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error("Enter a valid email address.");

  const redirectTo = new URL(config.appUrl, window.location.href).href;
  const response = await fetch(`${config.supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: address, create_user: false, data: {} })
  });
  await parseResponse(response);
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
    const error = new Error("Your sign-in has expired. Request a new email link.");
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

export function friendlyError(error) {
  if (error?.status === 401) return "Your sign-in has expired. Request a new email link.";
  if (error?.status === 403) return error.message || "This account does not have access to that training.";
  return error?.message || "Something went wrong. Please try again.";
}
