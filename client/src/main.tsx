import { createRoot } from "react-dom/client";
import { installApiFetch } from "./lib/api-base";
import App from "./App";
import "./index.css";

// Must run before any component mounts: the wrapper points relative /api
// paths at VITE_API_URL when the SPA is hosted apart from the API. No-op
// when they share an origin.
installApiFetch();

createRoot(document.getElementById("root")!).render(<App />);
