import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "조사실 · 공동 조사",
  description:
    "이메일 로그인과 조사방 접근 관리, 공동 조사 모의 체험을 제공합니다. AI와 기기 연결은 준비 중입니다.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
