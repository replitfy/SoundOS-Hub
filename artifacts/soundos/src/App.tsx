import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { ApiError, getGetMyAccessQueryKey } from "@workspace/api-client-react";
import { handleSessionExpired } from "@/lib/auth-error";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout";
import { AccessGate } from "@/components/access-gate";
import { UnsavedChangesProvider } from "@/hooks/use-unsaved-guard";
import { LanguageProvider } from "@/contexts/language";
import { UserSessionProvider, useUserSession } from "@/contexts/user-session";
import { AccessProvider } from "@/contexts/access";
import NotFound from "@/pages/not-found";

import Dashboard from "@/pages/dashboard";
import Financeiro from "@/pages/financeiro";
import Calendario from "@/pages/calendario";

import StorePanel from "@/pages/store";
import StorePedidos from "@/pages/store/pedidos";
import StoreProdutos from "@/pages/store/produtos";
import StoreClientes from "@/pages/store/clientes";

import EducationPanel from "@/pages/education";
import EducationCursos from "@/pages/education/cursos";
import EducationInteresse from "@/pages/education/interesse";
import EducationCursoDetail from "@/pages/education/curso-detail";
import EducationTurmas from "@/pages/education/turmas";
import EducationAlunos from "@/pages/education/alunos";
import EducationMatriculas from "@/pages/education/matriculas";

import SofiaChat from "@/pages/sofia";
import SofiaMemoria from "@/pages/sofia/memoria";
import SofiaPrompt from "@/pages/sofia/prompt";
import SofiaConduta from "@/pages/sofia/conduta";
import SofiaGovernanca from "@/pages/sofia/governanca";
import SofiaConversas from "@/pages/sofia/conversas";
import SofiaVideos from "@/pages/sofia/videos";
import SofiaVideosEnvios from "@/pages/sofia/videos-envios";

import PessoasList from "@/pages/pessoas";
import PessoaDetail from "@/pages/pessoas/[id]";

import CrmPage from "@/pages/crm";

import AdminUsuarios from "@/pages/admin/usuarios";
import AdminPerfis from "@/pages/admin/perfis-de-acesso";
import AdminBackup from "@/pages/admin/backup";
import AdminCargaAirtable from "@/pages/admin/carga-airtable";

import LoginPage from "@/pages/login";
import MeuPerfil from "@/pages/meu-perfil";
import InscricaoPage from "@/pages/inscricao/index";
import InteresseFormPage from "@/pages/inscricao/interesse";
import InteresseGeralPage from "@/pages/inscricao/interesse-geral";
import FormalizacaoPage from "@/pages/inscricao/formalizacao";
import AdminCursosInscricao from "@/pages/admin/cursos-inscricao";

// Quando qualquer chamada autenticada (via hooks gerados) recebe 401, a
// sessão expirou ou é inválida. Sem isso, cada tela mostrava um erro
// genérico próprio (ex.: "erro ao baixar planilha") sem explicar a causa
// real — o usuário ficava sem saber que precisava só logar de novo.
//
// Um 403 pode significar que o administrador mudou o perfil desta pessoa: o
// menu e as telas são revalidados na hora, sem esperar a próxima checagem.
const ACCESS_QUERY_KEY = getGetMyAccessQueryKey();

function revalidateAccessOnForbidden(err: unknown, queryKey?: readonly unknown[]): void {
  if (!(err instanceof ApiError) || err.status !== 403) return;
  if (queryKey?.[0] === ACCESS_QUERY_KEY[0]) return; // evita laço quando a própria checagem de perfil falha
  void queryClient.invalidateQueries({ queryKey: ACCESS_QUERY_KEY });
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      handleSessionExpired(err);
      revalidateAccessOnForbidden(err, query.queryKey);
    },
  }),
  mutationCache: new MutationCache({
    onError: (err) => {
      handleSessionExpired(err);
      revalidateAccessOnForbidden(err);
    },
  }),
});

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user } = useUserSession();
  const [location] = useLocation();

  if (!user) {
    return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
  }
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/interesse/:slug" component={InteresseFormPage} />
      <Route path="/interesse" component={InteresseGeralPage} />
      <Route path="/inscricao/:slug" component={InscricaoPage} />
      <Route path="/inscricao" component={InscricaoPage} />
      <Route path="/formalizacao/:token" component={FormalizacaoPage} />
      <Route>
        <AuthGuard>
          <AppLayout>
            <AccessGate>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/dashboard" component={Dashboard} />

              <Route path="/financeiro" component={Financeiro} />
              <Route path="/calendario" component={Calendario} />

              <Route path="/store" component={StorePanel} />
              <Route path="/store/pedidos" component={StorePedidos} />
              <Route path="/store/produtos" component={StoreProdutos} />
              <Route path="/store/clientes" component={StoreClientes} />

              <Route path="/education" component={EducationPanel} />
              <Route path="/education/cursos" component={EducationCursos} />
              <Route path="/education/cursos/:id" component={EducationCursoDetail} />
              <Route path="/education/interesse" component={EducationInteresse} />
              <Route path="/education/turmas" component={EducationTurmas} />
              <Route path="/education/alunos" component={EducationAlunos} />
              <Route path="/education/matriculas" component={EducationMatriculas} />

              <Route path="/sofia" component={SofiaChat} />
              <Route path="/sofia/memoria" component={SofiaMemoria} />
              <Route path="/sofia/prompt" component={SofiaPrompt} />
              <Route path="/sofia/conduta" component={SofiaConduta} />
              <Route path="/sofia/governanca" component={SofiaGovernanca} />
              <Route path="/sofia/conversas" component={SofiaConversas} />
              <Route path="/sofia/videos" component={SofiaVideos} />
              <Route path="/sofia/videos/envios" component={SofiaVideosEnvios} />

              <Route path="/pessoas" component={PessoasList} />
              <Route path="/pessoas/:id" component={PessoaDetail} />
              <Route path="/crm" component={CrmPage} />

              <Route path="/meu-perfil" component={MeuPerfil} />

              <Route path="/admin/usuarios" component={AdminUsuarios} />
              <Route path="/admin/perfis" component={AdminPerfis} />
              <Route path="/admin/backup" component={AdminBackup} />
              <Route path="/admin/manutencao/airtable" component={AdminCargaAirtable} />
              {/* Redireciona rota legada para a página de cursos unificada */}
              <Route path="/admin/cursos-inscricao">
                {() => { window.location.replace("/education/cursos"); return null; }}
              </Route>

              <Route component={NotFound} />
            </Switch>
            </AccessGate>
          </AppLayout>
        </AuthGuard>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <UserSessionProvider>
          <AccessProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <UnsavedChangesProvider>
                <Router />
              </UnsavedChangesProvider>
            </WouterRouter>
            <Toaster />
            <SonnerToaster position="bottom-right" richColors />
          </TooltipProvider>
          </AccessProvider>
        </UserSessionProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
