import test from "node:test";
import assert from "node:assert/strict";
import { generateTemporaryPassword, passwordProblem } from "../../supabase/functions/_shared/accounts.ts";

test("password rules reject weak passwords with a plain reason", () => {
  assert.match(passwordProblem("Short1!") ?? "", /at least 12/);
  assert.match(passwordProblem("alllowercaseletters") ?? "", /three of/);
  assert.match(passwordProblem("Password123!") ?? "", /too common/);
  assert.match(passwordProblem("PanaloPipes2026!") ?? "", /too common/);
  assert.match(passwordProblem("Marco.Reyes-2026x", "marco.reyes@example.com") ?? "", /email name/);
  assert.match(passwordProblem(" Leading-Space-99") ?? "", /space/);
  assert.match(passwordProblem("Aaaaaaaa1234!!") ?? "", /repeating/);
});

test("reasonable passwords pass", () => {
  assert.equal(passwordProblem("Grinder-Torch-47-Kettle"), null);
  assert.equal(passwordProblem("blue harbour tram 2026", "someone@example.com"), null);
});

test("temporary passwords are well formed, strong and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generateTemporaryPassword();
    assert.match(p, /^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);
    assert.doesNotMatch(p, /[01OIl]/);
    assert.equal(passwordProblem(p), null);
    seen.add(p);
  }
  assert.equal(seen.size, 500);
});
