import { Toolbar } from "./components/Toolbar";
import { TreePanel } from "./components/TreePanel";
import { InspectorPanel } from "./components/InspectorPanel";
import { RelationsPanel } from "./components/RelationsPanel";
import { StatusBar } from "./components/StatusBar";
import { Viewport } from "./scene/Viewport";

export default function App() {
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
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
