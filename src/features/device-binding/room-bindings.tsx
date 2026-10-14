import type { RoomGitBinding } from "./room-git-report";
import { Badge } from "../../components/ui/badge";
import styles from "../room-access/access.module.css";
export function RoomBindings({ bindings }: { bindings: RoomGitBinding[] }) {
  return (
    <section className="space-y-3 border-t pt-5" aria-label="공개 기기 등록">
      <h2 className="text-sm font-semibold">현재 AI 연결 정보</h2>
      <p className="text-xs text-neutral-500">
        PC에서 확인한 Git 정보와 최근 통신 정보입니다. 최신 값은 다시 확인으로 조회하세요. 응답
        준비는 대화의 대상 선택에서 확인하세요.
      </p>
      {bindings.length ? (
        <ul className={styles.list}>
          {bindings.map((binding) => (
            <li key={binding.agentId}>
              <strong>
                {binding.repositoryAlias} · {binding.sessionAlias}
              </strong>
              <p>
                {binding.ownerAlias} · {binding.deviceAlias} · {binding.runtime} · epoch{" "}
                {binding.bindingEpoch}
              </p>
              <Badge variant="secondary">
                {binding.lastSeenAt ? "등록 · 최근 통신 있음" : "등록 · 통신 미확인"}
              </Badge>
              {binding.gitReport ? (
                <>
                  <p className={styles.code}>
                    <GitValue branch={binding.gitReport.branch} commit={binding.gitReport.commit} />
                    {" · 작업 상태 미확인"}
                  </p>
                  <p>
                    {binding.gitReport.stale ? "이전 Git 확인값 · " : ""}Git 확인:{" "}
                    {new Date(binding.gitReport.observedAt).toLocaleString("ko-KR")}
                  </p>
                </>
              ) : (
                <>
                  <p>Git 확인 대기 · 작업 상태 미확인</p>
                  {(binding.branch !== "unknown" || binding.commit !== "unknown") && (
                    <p className={styles.code}>
                      등록 당시 정보: <GitValue branch={binding.branch} commit={binding.commit} />
                    </p>
                  )}
                </>
              )}
              <p>
                최근 수신 (PC 통신):{" "}
                {binding.lastSeenAt
                  ? new Date(binding.lastSeenAt).toLocaleString("ko-KR")
                  : "아직 없음"}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>아직 공개 등록이 없습니다.</p>
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
