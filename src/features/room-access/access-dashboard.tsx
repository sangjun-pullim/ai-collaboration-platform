"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import type { Organization, Room } from "./contracts";
import { RoomFields, LogoutButton, formValues, useMutation } from "./client-actions";
import styles from "./access.module.css";
export function AccessDashboard({
  userId,
  organizations,
  rooms,
}: {
  userId: string;
  organizations: Organization[];
  rooms: Room[];
}) {
  const router = useRouter();
  const { send, busy, errorNode } = useMutation();
  const owned = organizations.filter((org) => org.owner_user_id === userId);
  async function submit(event: FormEvent<HTMLFormElement>, action: string) {
    event.preventDefault();
    const data = await send<{ roomId: string }>(
      `/api/access/${action}`,
      formValues(event.currentTarget),
    );
    if (data) {
      router.push(`/app/rooms/${data.roomId}`);
      router.refresh();
    }
  }
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <h1>내 조사방</h1>
        <LogoutButton />
      </header>
      <p className={styles.notice}>
        인증과 방 접근이 연결되어 있습니다. 기기 등록은 가능하며 AI 실행은 아직 미검증입니다.
      </p>
      <Link href="/app/connections">기기 연결 관리</Link>
      <div className={styles.content}>
        {errorNode}
        <section className={styles.panel}>
          <h2>참가한 방</h2>
          {rooms.length ? (
            <ul className={styles.list}>
              {rooms.map((room) => (
                <li key={room.id}>
                  <Link href={`/app/rooms/${room.id}`}>{room.title}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>아직 참가한 방이 없습니다.</p>
          )}
        </section>
        <section className={styles.panel}>
          <h2>초대로 참가</h2>
          <form className={styles.form} onSubmit={(event) => submit(event, "join")}>
            <label className={styles.field}>
              초대 코드
              <input name="code" required maxLength={64} autoComplete="off" spellCheck={false} />
            </label>
            <label className={styles.field}>
              내 별칭
              <input name="displayAlias" required maxLength={80} />
            </label>
            <button disabled={busy} className="button primary">
              방 참가
            </button>
          </form>
        </section>
        <section className={styles.panel}>
          <h2>새 그룹과 첫 방 만들기</h2>
          <form className={styles.form} onSubmit={(event) => submit(event, "bootstrap")}>
            <label className={styles.field}>
              그룹 이름
              <input name="groupName" required maxLength={100} />
            </label>
            <RoomFields />
            <label className={styles.field}>
              내 별칭
              <input name="displayAlias" required maxLength={80} />
            </label>
            <button disabled={busy} className="button primary">
              그룹과 방 만들기
            </button>
          </form>
        </section>
        {owned.length > 0 && (
          <section className={styles.panel}>
            <h2>내 그룹에 방 추가</h2>
            <form className={styles.form} onSubmit={(event) => submit(event, "room")}>
              <label className={styles.field}>
                그룹
                <select name="organizationId">
                  {owned.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>
              <RoomFields />
              <button disabled={busy} className="button primary">
                방 만들기
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
