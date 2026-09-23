import { useEffect, useRef, useState } from "react";

interface ResizeHandleProps {
  label: string;
  controls: string;
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  unit?: "pixels" | "percent";
  step?: number;
  pixelsPerUnit?: number;
  direction?: 1 | -1;
  onChange: (value: number) => void;
  onReset: () => void;
}

export default function ResizeHandle(props: ResizeHandleProps) {
  const latest = useRef(props);
  latest.current = props;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    start: number;
    value: number;
    pixelsPerUnit: number;
    element: HTMLDivElement;
  } | null>(null);
  const finish = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.element.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
    delete document.documentElement.dataset.resizing;
    setDragging(false);
  };
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("blur", finish);
      finish();
    };
  }, []);
  const change = (value: number) => {
    const { min, max, onChange } = latest.current;
    onChange(Math.max(min, Math.min(max, value)));
  };
  return (
    <div
      className={`resize-handle ${props.orientation}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-orientation={props.orientation}
      aria-valuemin={Math.round(props.min)}
      aria-valuemax={Math.round(props.max)}
      aria-valuenow={Math.round(props.value)}
      aria-valuetext={`${Math.round(props.value)} ${props.unit ?? "pixels"}`}
      title={`${props.label}. Drag or use arrow keys; double-click to reset.`}
      tabIndex={0}
      onDoubleClick={props.onReset}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          start:
            props.orientation === "vertical" ? event.clientX : event.clientY,
          value: props.value,
          pixelsPerUnit: props.pixelsPerUnit ?? 1,
          element: event.currentTarget,
        };
        document.documentElement.dataset.resizing = props.orientation;
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const coordinate =
          props.orientation === "vertical" ? event.clientX : event.clientY;
        change(
          current.value +
            ((coordinate - current.start) / current.pixelsPerUnit) *
              (props.direction ?? 1),
        );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const negative =
          props.orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const positive =
          props.orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (
          [negative, positive, "Home", "End", "Enter", "Escape"].includes(
            event.key,
          )
        )
          event.preventDefault();
        if (event.key === negative || event.key === positive) {
          const step = (props.step ?? 10) * (event.shiftKey ? 4 : 1);
          change(
            props.value +
              step * (event.key === positive ? 1 : -1) * (props.direction ?? 1),
          );
        } else if (event.key === "Home") change(props.min);
        else if (event.key === "End") change(props.max);
        else if (event.key === "Enter") props.onReset();
        else if (event.key === "Escape" && drag.current) {
          change(drag.current.value);
          finish();
        }
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
