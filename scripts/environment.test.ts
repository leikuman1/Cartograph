import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../instrumentation";

const credentialNames = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;
type Credentials = Partial<Record<(typeof credentialNames)[number], string>>;
const complete = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
  CLERK_SECRET_KEY: "sk_test_placeholder",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  SUPABASE_SECRET_KEY: "sb_secret_placeholder",
};

function withCredentials(values: Credentials, check: () => void) {
  const original = new Map(credentialNames.map(name => [name, process.env[name]]));
  try {
    for (const name of credentialNames) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    check();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("startup permits absent, empty, or whitespace-only credentials for offline type generation", () => {
  withCredentials({}, () => assert.doesNotThrow(register));
  for (const blank of ["", " \t "]) {
    withCredentials(Object.fromEntries(credentialNames.map(name => [name, blank])), () => {
      assert.doesNotThrow(register);
    });
  }
});

test("every partial credential combination fails during startup", () => {
  for (let mask = 1; mask < 2 ** credentialNames.length - 1; mask += 1) {
    const values = Object.fromEntries(credentialNames
      .filter((_, index) => mask & (1 << index))
      .map(name => [name, complete[name]]));
    const missing = credentialNames.find(name => !(name in values));
    assert.ok(missing);
    withCredentials(values, () => assert.throws(register, {
      message: `Missing environment variable ${missing}. Set it in .env.local before starting Cartograph.`,
    }));
  }
  withCredentials({ ...complete, CLERK_SECRET_KEY: " \t " }, () => {
    assert.throws(register, /Missing environment variable CLERK_SECRET_KEY/);
  });
});

test("startup accepts complete configuration", () => {
  withCredentials(complete, () => assert.doesNotThrow(register));
});

test("complete configuration still validates key types and the database URL", () => {
  for (const [name, value, message] of [
    ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "invalid", "must be a Clerk publishable key"],
    ["CLERK_SECRET_KEY", "invalid", "must be a Clerk secret key"],
    ["NEXT_PUBLIC_SUPABASE_URL", "invalid", "must be an absolute HTTP(S) URL"],
    ["NEXT_PUBLIC_SUPABASE_URL", "file:///database", "must be an absolute HTTP(S) URL"],
  ]) {
    withCredentials({ ...complete, [name]: value }, () => {
      assert.throws(register, error => error instanceof Error && error.message.includes(message));
    });
  }
});
