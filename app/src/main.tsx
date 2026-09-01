import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode is intentionally not used here: it double-invokes effects in dev,
// which double-mounts/unmounts the imperative three.js scene (WebGL context,
// DOM canvas, animation loop) in Viewport.tsx and causes stale-ref glitches
// (e.g. the transform gizmo attaching to the wrong object).
createRoot(document.getElementById('root')!).render(<App />)
