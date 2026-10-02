import type { PublicBinding } from "./contracts";
import styles from "../room-access/access.module.css";
export function RoomBindings({ bindings }: { bindings: PublicBinding[] }) {
  return <section className={styles.panel} aria-label="공개 기기 등록"><h2>저장소와 AI 등록</h2><p>등록과 최근 수신은 연결 정보입니다. AI 실행과 공급자 인증은 미검증입니다.</p>{bindings.length ? <ul className={styles.list}>{bindings.map(binding=><li key={binding.agentId}><strong>{binding.repositoryAlias} · {binding.sessionAlias}</strong><p>{binding.ownerAlias} · {binding.deviceAlias} · {binding.runtime} · epoch {binding.bindingEpoch}</p><p>등록 · 실행 미검증</p><p className={styles.code}>브랜치 {binding.branch} · 커밋 {binding.commit} · 작업 상태 unknown</p><p>최근 수신: {binding.lastSeenAt ? new Date(binding.lastSeenAt).toLocaleString("ko-KR"):"아직 없음"}</p></li>)}</ul>:<p>아직 공개 등록이 없습니다.</p>}</section>;
}
