import { useEffect } from "react";
import { Toolbar } from "./components/Toolbar";
import { TreePanel } from "./components/TreePanel";
import { InspectorPanel } from "./components/InspectorPanel";
import { RelationsPanel } from "./components/RelationsPanel";
import { KeyframesPanel } from "./components/KeyframesPanel";
import { StatusBar } from "./components/StatusBar";
import { Viewport } from "./scene/Viewport";
import { useAssemblyStore } from "./assembly/store";

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export default function App() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      if (isTextInput(e.target)) return;
      e.preventDefault();
      const store = useAssemblyStore.getState();
      if (e.altKey) store.redo();
      else store.undo();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col" style={{ background: "var(--bg-0)" }}>
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 border-r" style={{ borderColor: "var(--border)", background: "var(--bg-1)" }}>
          <TreePanel />
        </aside>
        <main className="min-w-0 flex-1">
          <Viewport />
        </main>
        <aside
          className="flex w-72 shrink-0 flex-col border-l"
          style={{ borderColor: "var(--border)", background: "var(--bg-1)" }}
        >
          <InspectorPanel />
          <div className="min-h-0 flex-1">
            <RelationsPanel />
          </div>
          <KeyframesPanel />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
