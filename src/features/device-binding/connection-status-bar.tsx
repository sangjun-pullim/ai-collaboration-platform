"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectionTime,
  type ConnectionPresence,
  type ConnectionSnapshot,
} from "./connection-presence";

const color: Record<ConnectionPresence, string> = {
  connected: "bg-green-600",
  unconfirmed: "bg-red-600",
  unavailable: "bg-neutral-400",
};

export function ConnectionStatusBar({ snapshot }: { snapshot: ConnectionSnapshot }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const label =
    snapshot.state === "unavailable"
      ? "확인 불가"
      : snapshot.connectedCount > 0
        ? `최근 통신 확인 ${snapshot.connectedCount}/${snapshot.activeCount}대`
        : "연결 확인 안 됨";
  return (
    <section
      aria-label="내 AI 연결 상태"
      className="shrink-0 border-b bg-white px-4 py-2 text-xs [overflow-wrap:anywhere]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <p role="status" className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${color[snapshot.state]}`}
          />
          <span>내 AI · {label}</span>
        </p>
        <span>
          마지막 조회:{" "}
          {snapshot.checkedAt ? (
            <time dateTime={snapshot.checkedAt}>
              {connectionTime(snapshot.checkedAt)} (한국 시간)
            </time>
          ) : (
            "조회 중"
          )}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
          className="rounded border px-2 py-1 disabled:opacity-50"
        >
          {pending ? "확인 중" : "다시 확인"}
        </button>
        <details className="min-w-0">
          <summary className="cursor-pointer">기기별 연결 상세</summary>
          <div className="mt-2 max-h-48 overflow-y-auto space-y-2">
            <p>
              초록은 조회 시점에 유효한 인증과 최근 90초 미만의 본인 PC 통신을 확인했다는 뜻입니다.
              현재 AI 답변을 보장하지 않습니다.
            </p>
            <p>
              연결 종료는 즉시 반영되지 않습니다. 화면은 마지막 조회 결과이며 ‘다시 확인’을 누르면
              갱신합니다.
            </p>
            {snapshot.state === "unavailable" ? (
              <p>연결 정보를 확인할 수 없습니다. 직접 다시 확인하세요.</p>
            ) : (
              <>
                <p>
                  활성 기기 {snapshot.activeCount}대 · 최근 통신 확인 {snapshot.connectedCount}대
                </p>
                {!snapshot.activeCount && <p>활성 등록 기기가 없습니다.</p>}
                <ul className="space-y-2">
                  {snapshot.devices.map((device, index) => (
                    <li key={index} className="flex min-w-0 gap-2">
                      <span
                        aria-hidden="true"
                        className={`mt-1 size-2 shrink-0 rounded-full ${color[device.state]}`}
                      />
                      <div>
                        <p>
                          {device.deviceAlias} ·{" "}
                          {device.organizationName ? `${device.organizationName} / ` : ""}
                          {device.roomTitle}
                        </p>
                        <p>
                          {device.state === "connected" ? "연결 통신 확인" : "연결 확인 안 됨"} ·{" "}
                          {device.reason}
                        </p>
                        <p>
                          마지막 통신:{" "}
                          {device.lastSeenAt ? (
                            <time dateTime={device.lastSeenAt}>
                              {connectionTime(device.lastSeenAt)} (한국 시간)
                            </time>
                          ) : (
                            "없음"
                          )}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {snapshot.activeCount > snapshot.devices.length && (
                  <p>
                    상세는 {snapshot.devices.length}대까지 표시합니다. 전체 기기는 연결 관리에서
                    확인하세요.
                  </p>
                )}
              </>
            )}
            <Link href="/app/connections" className="inline-block underline">
              연결 관리
            </Link>
          </div>
        </details>
      </div>
    </section>
  );
}
