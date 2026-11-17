import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type PendingAction =
  | { kind: "navigate"; href: string }
  | { kind: "popstate"; targetPathname: string };

interface UnsavedChangesCtx {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  requestNavigate: (href: string) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesCtx>({
  isDirty: false,
  setDirty: () => {},
  requestNavigate: () => {},
});

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const [isDirty, setIsDirty] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [location, navigate] = useLocation();

  const dirtyRef = useRef(isDirty);
  useEffect(() => { dirtyRef.current = isDirty; }, [isDirty]);

  // Track the full pathname we should restore if the user cancels back/forward.
  // Updated whenever navigation is clean (not dirty).
  const safePathnameRef = useRef(window.location.pathname);
  useEffect(() => {
    if (!isDirty) {
      safePathnameRef.current = window.location.pathname;
    }
  }, [location, isDirty]);

  // Flag to skip our own popstate handler when we restore history programmatically.
  const isRestoringRef = useRef(false);

  // ── beforeunload: block tab close / hard refresh ──────────────────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ── popstate: block browser back / forward ────────────────────────────────
  useEffect(() => {
    if (!isDirty) return;

    const handlePopState = () => {
      // Ignore our own synthetic popstate dispatches.
      if (isRestoringRef.current) return;

      const targetPathname = window.location.pathname;

      // Restore the safe pathname in the browser history so the current page
      // stays visible while the dialog is open.
      isRestoringRef.current = true;
      history.pushState(null, "", safePathnameRef.current);
      // Dispatch synthetic popstate so Wouter re-syncs to the restored URL.
      // dispatchEvent is synchronous — our handler fires and exits immediately
      // because isRestoringRef.current is still true.
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      isRestoringRef.current = false;

      // Show confirmation dialog.
      setPending({ kind: "popstate", targetPathname });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isDirty]);

  // ── requestNavigate: used by sidebar / any in-app links ───────────────────
  const setDirty = useCallback((dirty: boolean) => setIsDirty(dirty), []);

  const requestNavigate = useCallback((href: string) => {
    if (dirtyRef.current) {
      setPending({ kind: "navigate", href });
    } else {
      navigate(href);
    }
  }, [navigate]);

  // ── Dialog actions ────────────────────────────────────────────────────────
  const handleConfirm = () => {
    setIsDirty(false);
    if (pending?.kind === "navigate") {
      navigate(pending.href);
    } else if (pending?.kind === "popstate") {
      // Push the destination and let Wouter pick it up.
      isRestoringRef.current = true;
      history.pushState(null, "", pending.targetPathname);
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      isRestoringRef.current = false;
    }
    setPending(null);
  };

  const handleCancel = () => setPending(null);

  return (
    <UnsavedChangesContext.Provider value={{ isDirty, setDirty, requestNavigate }}>
      {children}
      <AlertDialog
        open={pending !== null}
        onOpenChange={open => { if (!open) handleCancel(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Você tem alterações não salvas</AlertDialogTitle>
            <AlertDialogDescription>
              Se sair agora, as edições feitas no prompt serão perdidas. Deseja continuar sem salvar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Sair sem salvar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedGuard() {
  return useContext(UnsavedChangesContext);
}
