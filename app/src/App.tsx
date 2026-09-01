import { Toolbar } from "./components/Toolbar";
import { TreePanel } from "./components/TreePanel";
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
        <aside className="w-72 shrink-0 border-l" style={{ borderColor: "var(--border)", background: "var(--bg-1)" }}>
          <RelationsPanel />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
