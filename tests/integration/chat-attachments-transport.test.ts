import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test(
  "should keep privileged image transport scoped to the private bucket and server-generated keys",
  {
    skip:
      !process.execArgv.includes("--conditions=react-server") &&
      "run this server-only transport harness with --conditions=react-server",
  },
  async () => {
    const { PrivateImageStorage, storageAdminRpc } =
      await import("../../src/features/chat-attachments/storage.ts");
    const savedFetch = globalThis.fetch;
    const savedUrl = process.env.SUPABASE_URL,
      savedSecret = process.env.AI_COLLAB_IMAGE_STORAGE_SECRET;
    const calls: { url: string; init: RequestInit }[] = [];
    let response = () =>
      new Response(new Uint8Array([7]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "1" },
      });
    process.env.SUPABASE_URL = "https://synthetic-storage.invalid";
    process.env.AI_COLLAB_IMAGE_STORAGE_SECRET = "sb_secret_synthetic_not_a_real_key";
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response();
    };
    try {
      const storage = new PrivateImageStorage(),
        id = randomUUID();
      await storage.put(id, Buffer.from([7]), "image/png");
      assert.equal(
        calls[0].url,
        `https://synthetic-storage.invalid/storage/v1/object/chat-images/${id}/image`,
      );
      assert.equal(calls[0].init.redirect, "error");
      assert.equal(calls[0].init.cache, "no-store");
      assert.equal(new Headers(calls[0].init.headers).get("x-upsert"), "false");
      assert.equal(
        new Headers(calls[0].init.headers).get("apikey"),
        process.env.AI_COLLAB_IMAGE_STORAGE_SECRET,
      );
      await assert.rejects(storage.get("../another-bucket/image"), { message: "INVALID_BODY" });
      await assert.rejects(storageAdminRpc("access_bootstrap", {}), { message: "FORBIDDEN" });
      assert.equal(calls.length, 1);
      assert.deepEqual(await storage.get(id), Buffer.from([7]));
      await storage.remove(id);
      assert.equal(calls[2].url, "https://synthetic-storage.invalid/storage/v1/object/chat-images");
      assert.deepEqual(JSON.parse(String(calls[2].init.body)), { prefixes: [`${id}/image`] });
      response = () => new Response("denied", { status: 403 });
      await assert.rejects(storage.remove(id), { message: "UNAVAILABLE" });
      let cancelled = false;
      response = () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Length": "524289" } },
        );
      await assert.rejects(storage.get(id), { message: "BODY_TOO_LARGE" });
      assert.equal(cancelled, true);
      process.env.AI_COLLAB_IMAGE_STORAGE_SECRET = "sb_publishable_not_an_admin_key";
      await assert.rejects(storage.get(id), { message: "UNAVAILABLE" });
    } finally {
      globalThis.fetch = savedFetch;
      if (savedUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = savedUrl;
      if (savedSecret === undefined) delete process.env.AI_COLLAB_IMAGE_STORAGE_SECRET;
      else process.env.AI_COLLAB_IMAGE_STORAGE_SECRET = savedSecret;
    }
  },
);
