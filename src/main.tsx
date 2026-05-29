import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The window starts hidden (tauri.conf `visible: false`) to avoid a white flash
// before the UI is styled and mounted. Reveal it now that React has rendered the
// initial UI. NB: don't use requestAnimationFrame here — it's paused while the OS
// window is hidden, so the callback would never fire and the window would stay
// invisible forever. A macrotask runs regardless of visibility.
setTimeout(() => {
  getCurrentWindow()
    .show()
    .catch(() => {
      /* not running under Tauri (e.g. plain Vite preview) */
    });
}, 0);
