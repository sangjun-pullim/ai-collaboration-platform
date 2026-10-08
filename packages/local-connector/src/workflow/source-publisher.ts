import { digest, stableJson, RuntimeError } from "../runtime-contracts.ts";
import {
  validateBody,
  projectResponse,
  type Body,
  type DeviceAction,
} from "../workflow-contracts.ts";
import {
  sourceChunkByteLimit,
  sourceManifestByteLimit,
  type SourceIdentity,
  type SourcePacket,
  type SourceConfirmation,
  type SourceAcknowledgement,
} from "./source-contracts.ts";
/** The address includes attempt identity and index, not content; changed bytes must conflict. */
function packetOperationId(identity: SourceIdentity, index: number): string {
  const hex = digest(stableJson({ domain: "RUN_SOURCE_PACKET", version: 2, ...identity, index }));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function packetCount(bytes: Buffer, manifestHash: string): number {
  if (bytes.length < 1 || bytes.length > sourceManifestByteLimit || digest(bytes) !== manifestHash)
    throw new RuntimeError("INVALID_RUNTIME");
  return Math.ceil(bytes.length / sourceChunkByteLimit);
}
function packetAt(
  identity: SourceIdentity,
  bytes: Buffer,
  manifestHash: string,
  count: number,
  index: number,
): { body: Body; packet: SourcePacket } {
  const chunk = bytes.subarray(index * sourceChunkByteLimit, (index + 1) * sourceChunkByteLimit);
  const packet: SourcePacket = {
    version: 2,
    index,
    count,
    totalBytes: bytes.length,
    manifestHash,
    chunkHash: digest(chunk),
    bytesBase64: chunk.toString("base64"),
  };
  return {
    packet,
    body: validateBody("source-upload", {
      protocol: 1,
      ...identity,
      operationId: packetOperationId(identity, index),
      packetJson: JSON.stringify(packet),
    }),
  };
}
export function sourcePackets(
  identity: SourceIdentity,
  bytes: Buffer,
  manifestHash: string,
): { body: Body; packet: SourcePacket }[] {
  const count = packetCount(bytes, manifestHash);
  return Array.from({ length: count }, (_, index) =>
    packetAt(identity, bytes, manifestHash, count, index),
  );
}
export type SourceTransport = (action: DeviceAction, body: Body) => Promise<unknown>;
/** No durable packet operations: deterministic bytes are rebuilt from the immutable original journal. */
export async function publishSource(
  identity: SourceIdentity,
  bytes: Buffer,
  manifestHash: string,
  call: SourceTransport,
  check: () => void,
): Promise<"CONFIRMED" | "NO_TARGET_SNAPSHOT"> {
  check();
  if (bytes.length < 1 || bytes.length > sourceManifestByteLimit)
    throw new RuntimeError("INVALID_RUNTIME");
  // Own the bytes before awaiting transport; callers may retain their mutable Buffer.
  const snapshot = Buffer.from(bytes),
    count = packetCount(snapshot, manifestHash),
    confirmationBody = validateBody("source-confirm", { protocol: 1, ...identity, manifestHash });
  const confirm = async () => {
    check();
    const raw = await call("source-confirm", confirmationBody);
    check();
    const result = projectResponse("source-confirm", raw) as SourceConfirmation;
    if (
      Object.entries(identity).some(
        ([key, value]) => result[key as keyof SourceIdentity] !== value,
      ) ||
      result.manifestHash !== manifestHash ||
      !(result.count === null || (result.count === count && result.totalBytes === snapshot.length))
    )
      throw new RuntimeError("AUTHORITY_LOST");
    return result;
  };
  const initial = await confirm();
  if (initial.state === "NO_TARGET_SNAPSHOT") return initial.state;
  if (initial.state === "CONFIRMED") return initial.state;
  for (let index = initial.nextMissingIndex; index < count; index++) {
    check();
    const { body, packet } = packetAt(identity, snapshot, manifestHash, count, index);
    const raw = await call("source-upload", body);
    check();
    const ack = projectResponse("source-upload", raw) as SourceAcknowledgement;
    if (
      Object.entries(identity).some(([key, value]) => ack[key as keyof SourceIdentity] !== value) ||
      ack.manifestHash !== manifestHash ||
      ack.operationId !== body.operationId ||
      ack.index !== packet.index ||
      ack.chunkHash !== packet.chunkHash
    )
      throw new RuntimeError("AUTHORITY_LOST");
  }
  if ((await confirm()).state !== "CONFIRMED") throw new RuntimeError("UNKNOWN");
  check();
  return "CONFIRMED";
}
