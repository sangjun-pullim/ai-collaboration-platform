import Link from "next/link";
import { PrototypeApp } from "../../features/investigation-prototype/prototype-app";
import "../../features/investigation-prototype/prototype.css";
export default function DemoPage() {
  return (
    <div className="prototype-demo">
      <nav aria-label="실제 AI 채팅방">
        <Link href="/">실제 AI 채팅방으로 이동</Link>
      </nav>
      <PrototypeApp />
    </div>
  );
}
