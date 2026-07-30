// Guard tests for the at-rest encryption primitive.
//
// These exist so "Do you encrypt data at rest?" stays a true answer: if the
// ciphertext format, the auth tag, or the key handling regresses, this file
// goes red before anything reaches a merchant's stored credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { encryptSecret, decryptSecret } from "./crypto.server.js";

const KEY_ENV_VAR = "SOURCETRACK_CONFIG_ENCRYPTION_KEY";

// Test-only keys, generated per run. Never a hardcoded literal, so nothing in
// this repo ever resembles a real key.
const HEX_KEY = crypto.randomBytes(32).toString("hex");
const OTHER_HEX_KEY = crypto.randomBytes(32).toString("hex");
const BASE64_KEY = crypto.randomBytes(32).toString("base64");

process.env[KEY_ENV_VAR] = HEX_KEY;

// Run body with a specific value of the key env var, then restore.
function withKey(value, body) {
  const previous = process.env[KEY_ENV_VAR];
  if (value === undefined) delete process.env[KEY_ENV_VAR];
  else process.env[KEY_ENV_VAR] = value;
  try {
    return body();
  } finally {
    process.env[KEY_ENV_VAR] = previous;
  }
}

const SITE_KEY = "st_live_9f2c4b7ae1d84c0fa3e6";

test("a round trip returns the original value exactly", () => {
  assert.equal(decryptSecret(encryptSecret(SITE_KEY)), SITE_KEY);
});

test("the ciphertext does not contain the plaintext, or any fragment of it", () => {
  const encrypted = encryptSecret(SITE_KEY);
  assert.notEqual(encrypted, SITE_KEY);
  for (let i = 0; i + 6 <= SITE_KEY.length; i++) {
    assert.equal(
      encrypted.includes(SITE_KEY.slice(i, i + 6)),
      false,
      `ciphertext leaked the fragment at offset ${i}`,
    );
  }
});

test("the output is iv:ciphertext:tag, all hex, with a 12-byte iv and 16-byte tag", () => {
  const [iv, ciphertext, tag] = encryptSecret(SITE_KEY).split(":");
  assert.match(iv, /^[0-9a-f]{24}$/);
  assert.match(ciphertext, /^[0-9a-f]+$/);
  assert.match(tag, /^[0-9a-f]{32}$/);
});

test("encrypting the same value twice gives different ciphertext (random iv)", () => {
  // A deterministic ciphertext would let anyone with DB read access tell which
  // shops share a site key, and confirm a guessed key by comparison.
  assert.notEqual(encryptSecret(SITE_KEY), encryptSecret(SITE_KEY));
});

test("a tampered ciphertext fails the auth tag instead of decrypting", () => {
  const [iv, ciphertext, tag] = encryptSecret(SITE_KEY).split(":");
  const flipped = ciphertext.slice(0, -1) + (ciphertext.endsWith("a") ? "b" : "a");
  assert.throws(() => decryptSecret(`${iv}:${flipped}:${tag}`));
});

test("the wrong key cannot decrypt — it throws, it does not return garbage", () => {
  const encrypted = encryptSecret(SITE_KEY);
  withKey(OTHER_HEX_KEY, () => {
    assert.throws(() => decryptSecret(encrypted));
  });
});

test("a plaintext (pre-encryption) value is refused, not passed through", () => {
  // The legacy-row case. Returning it as-is would silently undo encryption.
  assert.throws(() => decryptSecret(SITE_KEY), /format/);
});

test("a base64 key is accepted as well as hex", () => {
  withKey(BASE64_KEY, () => {
    assert.equal(decryptSecret(encryptSecret(SITE_KEY)), SITE_KEY);
  });
});

test("a missing key throws naming the variable, and never the value", () => {
  withKey(undefined, () => {
    assert.throws(
      () => encryptSecret(SITE_KEY),
      (err) => {
        assert.match(err.message, new RegExp(KEY_ENV_VAR));
        assert.equal(err.message.includes(SITE_KEY), false);
        return true;
      },
    );
  });
});

test("a malformed key is refused rather than stretched into 32 bytes", () => {
  withKey("too-short", () => {
    assert.throws(() => encryptSecret(SITE_KEY), /64-character hex|32-byte base64/);
  });
});

test("this app never reads the main SourceTrack API's ENCRYPTION_KEY", () => {
  // Blast-radius isolation: two deployables, two secrets. Sharing the main
  // API's key would mean a leak of this app's env also exposes every CAPI
  // token and OAuth secret over there.
  const source = readFileSync(new URL("./crypto.server.js", import.meta.url), "utf8");
  assert.equal(
    /process\.env\.ENCRYPTION_KEY|process\.env\[\s*["']ENCRYPTION_KEY["']\s*\]/.test(source),
    false,
    "crypto.server.js must not read the main API's ENCRYPTION_KEY",
  );
  assert.equal(source.includes(KEY_ENV_VAR), true);
});
