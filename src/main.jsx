import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import LeadPilotH8 from "./LeadPilotH8.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <>
      <App />
      <LeadPilotH8 />
    </>
  </StrictMode>,
);
