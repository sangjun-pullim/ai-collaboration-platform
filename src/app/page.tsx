import Link from "next/link";
import { PrototypeApp } from "../features/investigation-prototype/prototype-app";

export default function Home() {
  return <><nav aria-label="실제 조사실"><Link href="/login">실제 조사실 로그인</Link></nav><PrototypeApp /></>;
}
