"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectionTime,
  connectionObservationExpired,
  unavailableConnectionSnapshot,
  type ConnectionPresence,
  type ConnectionSnapshot,
} from "./connection-presence";

const color: Record<ConnectionPresence, string> = {
  connected: "bg-green-600",
  unconfirmed: "bg-red-600",
  unavailable: "bg-neutral-400",
};

export function ConnectionStatusBar({ snapshot: observed }: { snapshot: ConnectionSnapshot }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1_000);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);
  const expired = now !== null && connectionObservationExpired(observed, now);
  const snapshot = expired ? unavailableConnectionSnapshot(observed.checkedAt) : observed;
  const label = expired
    ? "통신 확인 만료 · 다시 확인"
    : snapshot.state === "unavailable"
      ? "확인 불가"
      : snapshot.connectedCount > 0
        ? `최근 통신 확인 ${snapshot.connectedCount}/${snapshot.activeCount}대`
        : "연결 확인 안 됨";
  return (
    <section
      aria-label="PC 연결 상태"
      className="relative min-w-0 bg-white text-xs lg:border-t lg:px-4 lg:py-3 [overflow-wrap:anywhere]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <details className="peer min-w-0 flex-1">
          <summary
            aria-label={`PC 연결 상태 · ${label} · AI 응답 준비는 별도 · 기기별 연결 상세`}
            className="flex h-9 w-9 shrink-0 cursor-pointer list-none items-center justify-center rounded-md border hover:bg-neutral-50 lg:h-auto lg:w-auto lg:flex-col lg:items-start lg:gap-1 lg:border-0 [&::-webkit-details-marker]:hidden"
          >
            <span role="status" className="flex min-w-0 items-center gap-1 lg:gap-2">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${color[snapshot.state]}`}
              />
              <span className="sr-only lg:not-sr-only">PC 연결 · {label}</span>
              <span className="lg:hidden">PC</span>
            </span>
            <span className="hidden text-[10px] text-neutral-500 lg:block">AI 준비 별도</span>
          </summary>
          <div className="absolute right-0 top-11 z-30 w-[min(320px,calc(100vw-16px))] max-h-[min(28rem,75dvh)] space-y-3 overflow-y-auto rounded-md border bg-white p-4 shadow-lg lg:group-data-[placement=navigation]/connection:bottom-full lg:group-data-[placement=navigation]/connection:left-2 lg:group-data-[placement=navigation]/connection:right-auto lg:group-data-[placement=navigation]/connection:top-auto">
            <p className="pr-20 font-medium">PC 연결 · {label}</p>
            <p>AI 응답 준비는 별도로 확인하세요.</p>
            <p>
              마지막 조회:{" "}
              {snapshot.checkedAt ? (
                <time dateTime={snapshot.checkedAt}>
                  {connectionTime(snapshot.checkedAt)} (한국 시간)
                </time>
              ) : (
                "조회 중"
              )}
            </p>
            <div className="space-y-2">
              <p>
                초록은 조회 시점에 유효한 인증과 최근 90초 미만의 본인 PC 통신을 확인했다는
                뜻입니다. 현재 AI 답변을 보장하지 않습니다.
              </p>
              <p>
                터미널 종료는 즉시 확인할 수 없습니다. 통신 기록이 만료되면 초록 표시가 자동으로
                꺼집니다. ‘다시 확인’으로 최신 상태를 조회하세요.
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
          </div>
        </details>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
          className="absolute right-3 top-14 z-40 hidden rounded border bg-white px-2 py-1 disabled:opacity-50 peer-open:block lg:static lg:block lg:shrink-0"
        >
          {pending ? "확인 중" : "다시 확인"}
        </button>
      </div>
    </section>
  );
}
