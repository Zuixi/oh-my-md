import React from "react";
import ReactDOM from "react-dom/client";
import { ToastContainer } from "react-toastify";
// Import order matters: the toast stylesheet comes first so styles.css
// `.Toastify` overrides can win ties at equal specificity.
import "react-toastify/dist/ReactToastify.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/* Production-only mount: tests render <App /> without toasts (spec 2026-08-20). */}
    <ToastContainer
      position="bottom-right"
      newestOnTop
      limit={3}
      pauseOnHover
      closeButton
      draggable={false}
    />
  </React.StrictMode>,
);
