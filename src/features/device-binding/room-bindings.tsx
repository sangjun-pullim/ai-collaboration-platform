import type { PublicBinding } from "./contracts";
import { Badge } from "../../components/ui/badge";
import styles from "../room-access/access.module.css";
export function RoomBindings({ bindings }: { bindings: PublicBinding[] }) {
  return (
    <section className="space-y-3 border-t pt-5" aria-label="공개 기기 등록">
      <h2 className="text-sm font-semibold">현재 AI 연결 정보</h2>
      <p className="text-xs text-neutral-500">
        등록·최근 통신 정보입니다. 응답 준비는 대화의 대상 선택에서 확인하세요.
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
              <p className={styles.code}>
                브랜치 {binding.branch} · 커밋 {binding.commit} · 작업 상태 미확인
              </p>
              <p>
                최근 수신:{" "}
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
