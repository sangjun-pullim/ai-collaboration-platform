import type { RoomGitBinding } from "./room-git-report";
import { Badge } from "../../components/ui/badge";
export function RoomBindings({ bindings }: { bindings: RoomGitBinding[] }) {
  return (
    <section className="space-y-3 border-t border-neutral-200/80 pt-5" aria-label="공개 기기 등록">
      <h2 className="text-xs font-semibold text-neutral-900">현재 AI 연결 정보</h2>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        PC에서 확인한 Git 정보와 최근 통신 정보입니다. 최신 값은 다시 확인으로 조회하세요. 응답
        준비는 대화의 대상 선택에서 확인하세요.
      </p>
      {bindings.length ? (
        <ul className="space-y-3">
          {bindings.map((binding) => (
            <li
              key={binding.agentId}
              className="min-w-0 rounded-xl border border-neutral-200/80 bg-white p-3.5 text-xs shadow-[0_1px_3px_0_rgb(0_0_0/0.02)] [overflow-wrap:anywhere]"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-[10px] font-semibold text-teal-800"
                >
                  AI
                </span>
                <div className="min-w-0">
                  <strong className="block font-semibold leading-relaxed text-neutral-900">
                    {binding.repositoryAlias}
                  </strong>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
                    {binding.sessionAlias}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-neutral-600">
                <p>
                  {binding.ownerAlias} · {binding.deviceAlias}
                </p>
                <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px]">
                  CLI · {binding.runtime}
                </span>
              </div>
              <Badge
                variant="secondary"
                className="mt-2 rounded-md bg-neutral-100 text-[10px] font-normal text-neutral-600"
              >
                {binding.lastSeenAt ? "등록 · 최근 통신 있음" : "등록 · 통신 미확인"}
              </Badge>
              <div className="mt-3 space-y-1.5 border-t border-neutral-100 pt-3 text-[11px] leading-relaxed text-neutral-600">
                {binding.gitReport ? (
                  <>
                    <p className="font-mono text-[11px] text-neutral-700">
                      <GitValue
                        branch={binding.gitReport.branch}
                        commit={binding.gitReport.commit}
                      />
                      {" · 작업 상태 미확인"}
                    </p>
                    <p className="text-neutral-500">
                      {binding.gitReport.stale ? "이전 Git 확인값 · " : ""}Git 확인:{" "}
                      {new Date(binding.gitReport.observedAt).toLocaleString("ko-KR")}
                    </p>
                  </>
                ) : (
                  <>
                    <p>Git 확인 대기 · 작업 상태 미확인</p>
                    {(binding.branch !== "unknown" || binding.commit !== "unknown") && (
                      <p className="font-mono text-[11px] text-neutral-500">
                        등록 당시 정보: <GitValue branch={binding.branch} commit={binding.commit} />
                      </p>
                    )}
                  </>
                )}
                <p className="text-neutral-500">
                  최근 수신 (PC 통신):{" "}
                  {binding.lastSeenAt
                    ? new Date(binding.lastSeenAt).toLocaleString("ko-KR")
                    : "아직 없음"}
                </p>
              </div>
              <p className="mt-3 text-[10px] tabular-nums text-neutral-500">
                연결 버전 · epoch {binding.bindingEpoch}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-neutral-200 px-3 py-5 text-center text-xs text-neutral-500">
          아직 공개 등록이 없습니다.
        </p>
      )}
    </section>
  );
}

function GitValue({ branch, commit }: { branch: string; commit: string }) {
  if (branch === "unknown" && commit === "unknown") return <>Git 정보 확인 불가</>;
  return (
    <>
      {branch === "unknown" ? "브랜치 이름 미확인" : `브랜치 ${branch}`} ·{" "}
      {commit === "unknown" ? (
        "커밋 미확인"
      ) : (
        <>
          커밋{" "}
          <span title={commit} aria-label={`전체 커밋 ${commit}`}>
            {commit.slice(0, 7)}
          </span>
        </>
      )}
    </>
  );
}
