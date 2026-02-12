import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GoogleAuth } from "google-auth-library";
import { createGoogleAuth } from "../config/auth";

test("createGoogleAuth: uses ADC when no key path is provided", () => {
  const auth = createGoogleAuth({ scopes: ["scope:a"] });
  assert.ok(auth instanceof GoogleAuth);
});

test("createGoogleAuth: rejects relative key paths", async () => {
  const fileName = ".tmp-auth-relative.json";
  await fs.writeFile(path.resolve(process.cwd(), fileName), "{}", "utf-8");
  try {
    assert.throws(
      () => createGoogleAuth({ keyFilePath: fileName }),
      /must be absolute/
    );
  } finally {
    await fs.rm(path.resolve(process.cwd(), fileName), { force: true });
  }
});

test("createGoogleAuth: rejects directory path", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-auth-dir-"));
  try {
    assert.throws(
      () => createGoogleAuth({ keyFilePath: dir }),
      /not a file/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("createGoogleAuth: accepts absolute key file path", async () => {
  const file = path.join(process.cwd(), ".tmp-auth-key.json");
  await fs.writeFile(file, "{}", "utf-8");
  try {
    const auth = createGoogleAuth({ keyFilePath: file, scopes: ["scope:a"] });
    assert.ok(auth instanceof GoogleAuth);
  } finally {
    await fs.rm(file, { force: true });
  }
});
