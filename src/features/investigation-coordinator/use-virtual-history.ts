"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export function useVirtualHistory(ids: string[], scrollRef: RefObject<HTMLDivElement | null>) {
  "use no memo";
  const pending = useRef<string | null>(null);
  const handledHash = useRef<string | null>(null);
  const [missingTarget, setMissingTarget] = useState(false);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => ids[index],
    estimateSize: () => 220,
    initialRect: { width: 390, height: 800 },
    overscan: 20,
    gap: 28,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 64,
    useAnimationFrameWithResizeObserver: true,
  });
  const items = virtualizer.getVirtualItems();
  const jump = useCallback(
    (id: string) => {
      const index = ids.indexOf(id);
      if (index < 0) {
        setMissingTarget(true);
        return false;
      }
      setMissingTarget(false);
      pending.current = id;
      handledHash.current = `#message-${id}`;
      virtualizer.scrollToIndex(index, { align: "start" });
      return true;
    },
    [ids, virtualizer],
  );
  useLayoutEffect(() => {
    const id = pending.current;
    if (!id) return;
    const node = document.getElementById(`message-${id}`);
    if (node) {
      node.scrollIntoView({ block: "start" });
      node.focus({ preventScroll: true });
      pending.current = null;
    }
  }, [items]);
  useEffect(() => {
    const hash = () => {
      const match = /^#message-(.+)$/.exec(location.hash);
      if (match) jump(match[1]);
      else setMissingTarget(false);
    };
    if (handledHash.current !== location.hash) hash();
    window.addEventListener("hashchange", hash);
    return () => window.removeEventListener("hashchange", hash);
  }, [jump]);
  return { virtualizer, items, jump, missingTarget };
}
