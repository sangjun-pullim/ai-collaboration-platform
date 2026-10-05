"use client";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../../components/ui/dialog";
export function AdvancedControls({ children }: { children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          공동 조사
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>공동 조사</DialogTitle>
          <DialogDescription>
            내 AI와 상대 AI의 준비 보고가 필요합니다. 직접 질문은 기본 대화에서 보낼 수 있습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="advanced-controls grid gap-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
