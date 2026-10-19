import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { cleanupImages } from "../../src/features/chat-attachments/cleanup.ts";
import { uploadImage, downloadImage } from "../../src/features/chat-attachments/service.ts";
import type { AttachmentRpc, ImageStorage } from "../../src/features/chat-attachments/quota.ts";
import type { AttachmentDescriptor } from "../../src/features/chat-attachments/contracts.ts";
import { WorkflowError } from "../../src/features/investigation-coordinator/contracts.ts";

// Fault-injection boundary harness: no cloud credentials, AI or Docker process.
function harness() {
  const id = randomUUID(),
    lease = randomUUID();
  const calls: string[] = [];
  const objects = new Map<string, Buffer>();
  let charged = 0,
    state = "RESERVED",
    blocked = false,
    egress = 0;
  let failWrite = false,
    failFinalize = false,
    failDelete = false,
    failConfirm = false;
  let image: AttachmentDescriptor;
  const rpc: AttachmentRpc = async (name, params) => {
    calls.push(name);
    if (name === "chat_attachment_authorize_upload") {
      if (blocked) throw new Error("FORBIDDEN");
      return {};
    }
    if (name === "chat_attachment_reserve") {
      const body = params.p_body as AttachmentDescriptor;
      image = {
        attachmentId: id,
        mime: body.mime,
        bytes: body.bytes,
        width: body.width,
        height: body.height,
        sha256: body.sha256,
      };
      charged += image.bytes;
      return { attachmentId: id };
    }
    if (name === "chat_attachment_finalize") {
      if (failFinalize) throw new Error("DB response lost");
      state = "READY";
      return image;
    }
    if (name === "chat_attachment_cleanup_claim") {
      state = "DELETING";
      return { leaseId: lease, attachmentIds: [id] };
    }
    if (name === "chat_attachment_cleanup_confirm") {
      assert.equal(objects.has(id), false, "must not release bytes before object deletion");
      if (failConfirm) throw new Error("DB response lost");
      state = "DELETED";
      charged = 0;
      return { deleted: true };
    }
    if (name === "authorize_download") {
      if (blocked || state !== "ATTACHED") throw new Error("FORBIDDEN");
      egress += image.bytes;
      return { descriptor: image, leaseId: lease };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
  const storage: ImageStorage = {
    async put(key, bytes) {
      calls.push("storage.put");
      objects.set(key, bytes);
      if (failWrite) throw new Error("Storage response lost after write");
    },
    async get(key) {
      calls.push("storage.get");
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    async remove(key) {
      calls.push("storage.remove");
      if (failDelete) throw new Error("Storage deletion failed");
      objects.delete(key);
    },
  };
  return {
    id,
    calls,
    objects,
    rpc,
    storage,
    get charged() {
      return charged;
    },
    get egress() {
      return egress;
    },
    get state() {
      return state;
    },
    attach() {
      state = "ATTACHED";
    },
    block() {
      blocked = true;
    },
    fail(which: "write" | "finalize" | "delete" | "confirm", value = true) {
      if (which === "write") failWrite = value;
      if (which === "finalize") failFinalize = value;
      if (which === "delete") failDelete = value;
      if (which === "confirm") failConfirm = value;
    },
  };
}
async function upload(h: ReturnType<typeof harness>) {
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  return uploadImage(
    h.rpc,
    h.rpc,
    h.storage,
    { protocol: 1, roomId: randomUUID(), expectedUserId: randomUUID() },
    image,
    "image/png",
  );
}
test("should authorize reserve write and finalize in order and keep bytes charged for uncertain writes", async () => {
  for (const fault of ["write", "finalize"] as const) {
    const h = harness();
    h.fail(fault);
    await assert.rejects(upload(h));
    assert.ok(h.charged > 0);
    assert.equal(h.objects.has(h.id), true);
    assert.equal(h.state, "RESERVED");
    assert.deepEqual(h.calls.slice(0, 3), [
      "chat_attachment_authorize_upload",
      "chat_attachment_reserve",
      "storage.put",
    ]);
    assert.equal((await cleanupImages(h.rpc, h.storage)).deleted, 1);
    assert.equal(h.charged, 0);
  }
});
test("should retain deletion reservations on Storage or database failures and retry the same object", async () => {
  for (const fault of ["delete", "confirm"] as const) {
    const h = harness();
    await upload(h);
    const before = h.charged;
    h.fail(fault);
    assert.equal((await cleanupImages(h.rpc, h.storage)).deleted, 0);
    assert.equal(h.state, "DELETING");
    assert.equal(h.charged, before);
    h.fail(fault, false);
    assert.equal((await cleanupImages(h.rpc, h.storage)).deleted, 1);
    assert.equal(h.charged, 0);
    assert.equal(h.state, "DELETED");
  }
});
test("should charge every authorized supply attempt before fetching and reject changed bytes", async () => {
  const h = harness(),
    image = await upload(h);
  h.attach();
  const authorize = () => h.rpc("authorize_download", {});
  const result = await downloadImage(authorize, h.storage);
  assert.equal(result.bytes.length, image.bytes);
  assert.equal(h.egress, image.bytes);
  h.objects.set(h.id, Buffer.alloc(image.bytes));
  await assert.rejects(downloadImage(authorize, h.storage), { message: "UNAVAILABLE" });
  assert.equal(h.egress, image.bytes * 2);
  h.block();
  const before = h.calls.filter((c) => c === "storage.get").length;
  await assert.rejects(downloadImage(authorize, h.storage));
  await assert.rejects(upload(h));
  assert.equal(h.calls.filter((c) => c === "storage.get").length, before);
  assert.equal(h.egress, image.bytes * 2);
});
test("should bound cleanup batches by object count and elapsed time", async () => {
  const h = harness();
  await upload(h);
  let tick = 0;
  assert.deepEqual(await cleanupImages(h.rpc, h.storage, () => (tick++ ? 10_001 : 0)), {
    deleted: 0,
    pending: 1,
  });
  assert.ok(h.charged > 0);
  await assert.rejects(
    cleanupImages(
      async () => ({
        leaseId: randomUUID(),
        attachmentIds: Array.from({ length: 33 }, randomUUID),
      }),
      h.storage,
    ),
    { message: "UNAVAILABLE" },
  );
});
test("should stop after one bounded cleanup and explain protected storage or egress limits", async () => {
  const h = harness();
  let reserves = 0,
    cleanups = 0;
  const userRpc: AttachmentRpc = async (name) => {
    if (name === "chat_attachment_authorize_upload") return {};
    reserves++;
    return { needsCleanup: true, reason: "STORAGE_PROTECTED" };
  };
  const adminRpc: AttachmentRpc = async () => {
    cleanups++;
    return { leaseId: null, attachmentIds: [] };
  };
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  await assert.rejects(
    uploadImage(
      userRpc,
      adminRpc,
      h.storage,
      { protocol: 1, roomId: randomUUID(), expectedUserId: randomUUID() },
      bytes,
      "image/png",
    ),
    { code: "QUOTA", reason: "STORAGE_PROTECTED" },
  );
  assert.equal(reserves, 2);
  assert.equal(cleanups, 1);
  assert.equal(h.objects.size, 0);
  await assert.rejects(
    downloadImage(async () => {
      throw new WorkflowError("QUOTA");
    }, h.storage),
    { code: "QUOTA", reason: "EGRESS_LIMIT" },
  );
  assert.equal(h.calls.includes("storage.get"), false);
});
