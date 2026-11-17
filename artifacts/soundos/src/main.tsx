import { createRoot } from "react-dom/client";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import App from "./App";
import { getStoredSessionToken } from "./contexts/user-session";
import "./index.css";

// Registra o token de sessão globalmente para TODOS os hooks gerados
// (@workspace/api-client-react): sem isso, cada página precisaria lembrar de
// passar `authHeader` manualmente em toda chamada, e qualquer rota protegida
// chamada por um hook gerado (ex.: useListPrompts, useListKnowledgeItems)
// ficaria inacessível assim que o backend passasse a exigir autenticação.
setAuthTokenGetter(() => getStoredSessionToken());

createRoot(document.getElementById("root")!).render(<App />);
