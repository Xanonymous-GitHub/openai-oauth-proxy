import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./admin-app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Admin root element is missing");

createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
