// Password rules and temporary password generation, shared by the Edge
// Functions and unit-tested. Passwords are only ever passed to Supabase Auth;
// nothing here stores or logs them.

const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "qwerty", "qwerty123", "letmein", "welcome", "welcome1",
  "iloveyou", "admin", "administrator", "panalo", "panalopipes", "123456", "12345678", "123456789", "1234567890",
  "abc123", "changeme", "monkey", "dragon", "football", "sunshine", "australia"
]);

export const PASSWORD_MIN_LENGTH = 12;

/** Returns null when acceptable, or a plain-language reason. */
export function passwordProblem(password: string, email = ""): string | null {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (value.length > 128) return "Use 128 characters or fewer.";
  if (/^\s|\s$/.test(value)) return "Don't start or end the password with a space.";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length;
  if (classes < 3) return "Mix at least three of: lower-case letters, capitals, numbers and symbols.";
  const lowered = value.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/g, "");
  if (COMMON.has(lowered) || COMMON.has(compact) || [...COMMON].some(word => word.length >= 6 && compact.includes(word))) {
    return "That password is too common. Choose something harder to guess.";
  }
  const local = String(email || "").toLowerCase().split("@")[0].replace(/[^a-z0-9]/g, "");
  if (local.length >= 4 && compact.includes(local)) return "Don't include your email name in the password.";
  if (/(.)\1{3,}/.test(value)) return "Avoid repeating the same character four or more times.";
  return null;
}

// No 0/O, 1/l/I: temporary passwords are read out over the phone.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGIT = "23456789";

function pick(alphabet: string, random: Uint8Array, index: number) {
  // 256 is not a multiple of every alphabet length; reject biased values.
  const limit = 256 - (256 % alphabet.length);
  let value = random[index];
  let step = 0;
  while (value >= limit) {
    const extra = new Uint8Array(1);
    crypto.getRandomValues(extra);
    value = extra[0];
    if (++step > 64) break;
  }
  return alphabet[value % alphabet.length];
}

/** Four groups of four, e.g. "Kp7m-Q3xv-T9cw-Hn4r" (about 80 bits). */
export function generateTemporaryPassword(): string {
  const all = UPPER + LOWER + DIGIT;
  for (;;) {
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const chars = Array.from({ length: 16 }, (_, i) => pick(all, random, i));
    const password = [0, 4, 8, 12].map(start => chars.slice(start, start + 4).join("")).join("-");
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && !passwordProblem(password)) return password;
  }
}
