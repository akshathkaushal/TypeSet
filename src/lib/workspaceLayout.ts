import { useEffect, useRef, useState } from "react";

export const DEFAULT_LAYOUT = {
  sidebar: 246,
  editor: 51,
  terminal: 280,
  logs: 210,
};
const STORAGE_KEY = "typeset.workspace-layout.v1";

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(() => {
    const next = { ...DEFAULT_LAYOUT };
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        const value = stored?.[key];
        const max = key === "editor" ? 85 : key === "sidebar" ? 460 : 2000;
        const min = key === "editor" ? 15 : key === "sidebar" ? 180 : 120;
        if (typeof value === "number" && Number.isFinite(value))
          next[key] = Math.max(min, Math.min(max, value));
      }
    } catch {
      /* Keep defaults if local storage is unavailable or invalid. */
    }
    return next;
  });
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
      } catch {
        /* Resizing still works if preferences cannot be persisted. */
      }
    };
    const timer = setTimeout(save, 150);
    window.addEventListener("beforeunload", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("beforeunload", save);
    };
  }, [layout]);
  const resize = (key: keyof typeof layout, value: number) =>
    setLayout((current) =>
      current[key] === value ? current : { ...current, [key]: value },
    );
  return { layout, resize };
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
