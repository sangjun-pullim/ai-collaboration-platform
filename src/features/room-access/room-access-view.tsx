"use client";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Room, RoomRole, Member, Organization, GroupMember } from "./contracts";
import { LogoutButton, useMutation, formValues } from "./client-actions";
import styles from "./access.module.css";
const roles: Record<RoomRole, string> = { owner: "소유자", participant: "참여자", observer: "관찰자" };
export function RoomAccessView({ userId, room, role, members, organization, groupMembers, bindings, investigation }: { userId: string; room: Room; role: RoomRole; members: Member[]; organization: Organization; groupMembers: GroupMember[]; bindings?: ReactNode; investigation?: ReactNode }) {
  const router = useRouter();
  const { send, busy, errorNode } = useMutation();
  const [invitation, setInvitation] = useState<string | null>(null);
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setInvitation(null);
    const data = await send<{ code: string }>("/api/access/invite", { roomId: room.id, ...formValues(event.currentTarget) });
    if (data) setInvitation(data.code);
  }
  async function remove(action: string, member: string) {
    const scope: Record<string, string> = action === "revoke-room-member" ? { roomId: room.id } : { organizationId: organization.id };
    if (await send(`/api/access/${action}`, { ...scope, userId: member })) router.refresh();
  }
  return <main className={styles.shell}><header className={styles.header}><Link href="/app">내 조사방</Link><LogoutButton /></header>
    <div className={styles.content}><h1>{room.title}</h1><p>내 역할: <strong>{roles[role]}</strong></p><p className={styles.notice}>기기 등록은 가능하며 AI 실행은 아직 미검증입니다. 방의 공개 등록 정보와 멤버를 확인할 수 있습니다.</p>{errorNode}<Link href="/app/connections">기기 연결 관리</Link>{bindings}{investigation}
      <section className={styles.panel}><h2>방 준비 정보</h2><dl className={styles.details}><dt>조사 목표</dt><dd>{room.goal}</dd><dt>관찰 근거</dt><dd>{room.observation}</dd><dt>환경</dt><dd>{room.environment}</dd></dl></section>
      <section className={styles.panel}><h2>방 멤버</h2><ul className={styles.list}>{members.map(member => <li className={styles.member} key={member.user_id}><span>{member.display_alias} · {roles[member.role]}</span>{role === "owner" && member.role !== "owner" && member.user_id !== userId && <button disabled={busy} className="button" onClick={() => remove("revoke-room-member", member.user_id)} aria-label={`${member.display_alias} 방에서 제거`}>방에서 제거</button>}</li>)}</ul></section>
      {role === "owner" && <section className={styles.panel}><h2>멤버 초대</h2><form className={styles.form} onSubmit={invite}><label className={styles.field}>초대 역할<select name="role"><option value="participant">참여자</option><option value="observer">관찰자</option></select></label><button disabled={busy} className="button primary">초대 발급</button></form>
        {invitation && <div><p>24시간 안에 한 번 사용할 수 있습니다. 초대할 사람에게 직접 전달하세요.</p><p aria-label="발급된 초대 코드" className={styles.code}>{invitation}</p><button className="button" onClick={() => setInvitation(null)}>코드 숨기기</button></div>}
      </section>}
      {organization.owner_user_id === userId && <section className={styles.panel}><h2>그룹 멤버 관리</h2><p>그룹에서 제거하면 그룹 내 모든 방의 접근이 취소됩니다.</p><ul className={styles.list}>{groupMembers.filter(member => member.role !== "owner").map(member => <li className={styles.member} key={member.user_id}><span>{member.display_alias}</span><button disabled={busy} className="button" aria-label={`${member.display_alias} 그룹에서 제거`} onClick={() => remove("revoke-group-member", member.user_id)}>그룹에서 제거</button></li>)}</ul></section>}
    </div></main>;
}
