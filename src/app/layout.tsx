import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 채팅방",
  description:
    "동료의 AI에게 질문하고 함께 대화하는 AI 채팅방. 내 AI 연결 없이도 질문할 수 있습니다.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
