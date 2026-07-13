import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconLock,
  IconLogout,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { AccountState } from "../../codex/account.js";
import { parseAdminResponse } from "../contract.js";

type Action = "login" | "cancel" | "refresh" | "logout";
type Issue = "authentication_unavailable" | "session_unavailable";

const ACTIONS: Record<Action, { path: string; body: object }> = {
  login: { path: "/api/login", body: { type: "chatgptDeviceCode" } },
  cancel: { path: "/api/cancel", body: {} },
  refresh: { path: "/api/refresh", body: {} },
  logout: { path: "/api/logout", body: {} },
};

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function canonicalVerificationUrl(value: string): string | null {
  return value === "https://auth.openai.com/codex/device" ? value : null;
}

function statusLabel(state: AccountState | null): string {
  if (!state) return "Connecting";
  switch (state.type) {
    case "checking":
      return "Checking";
    case "signed_out":
      return "Disconnected";
    case "login_pending":
      return "Authorization pending";
    case "ready":
      return "Connected";
    case "error":
      return "Action required";
  }
}

function planLabel(value: string): string {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function IssueAlert({ issue }: { issue: Issue }) {
  const authentication = issue === "authentication_unavailable";
  return (
    <Alert role="alert">
      <IconAlertTriangle aria-hidden="true" />
      <AlertTitle>
        {authentication ? "Authentication unavailable" : "Session unavailable"}
      </AlertTitle>
      <AlertDescription>
        {authentication
          ? "Authentication is temporarily unavailable."
          : "Session unavailable. Try again."}
      </AlertDescription>
    </Alert>
  );
}

function LoadingPanel() {
  return (
    <div className="grid gap-5" role="status" aria-label="Checking account">
      <Skeleton className="h-5 w-36" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-10 w-40" />
    </div>
  );
}

function SessionUnavailable({
  retry,
  loading,
}: {
  retry: () => void;
  loading: boolean;
}) {
  return (
    <div className="grid gap-5">
      <IssueAlert issue="session_unavailable" />
      <Button type="button" onClick={retry} disabled={loading}>
        <IconRefresh aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

function AccountContent({
  state,
  busy,
  run,
}: {
  state: AccountState;
  busy: Action | null;
  run: (action: Action) => void;
}) {
  const disabled = busy !== null;
  const [copyStatus, setCopyStatus] = useState("");
  const code = state.type === "login_pending" ? state.userCode : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset feedback when the pending code changes.
  useEffect(() => setCopyStatus(""), [code]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy unavailable");
    }
  };

  switch (state.type) {
    case "checking":
      return (
        <div className="grid gap-5">
          <LoadingPanel />
          <Button
            type="button"
            onClick={() => run("refresh")}
            disabled={disabled}
          >
            <IconRefresh aria-hidden="true" />
            Refresh status
          </Button>
        </div>
      );
    case "signed_out":
      return (
        <div className="grid gap-6">
          <div className="grid gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              Connect your Codex account
            </h2>
            <p className="max-w-[52ch] text-sm leading-6 text-muted-foreground">
              Start a one-time device authorization without exposing credentials
              to this page.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => run("login")}
            disabled={disabled}
          >
            Connect Codex
          </Button>
        </div>
      );
    case "login_pending": {
      const verificationUrl = canonicalVerificationUrl(state.verificationUrl);
      return (
        <div className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-sm font-medium">One-time device code</p>
            <div className="flex flex-col gap-3 rounded-lg border bg-muted p-4 sm:flex-row sm:items-center sm:justify-between">
              <code className="break-all font-mono text-xl font-semibold tracking-[0.12em]">
                {state.userCode}
              </code>
              <Button type="button" variant="outline" onClick={copyCode}>
                {copyStatus === "Copied" ? (
                  <IconCheck aria-hidden="true" />
                ) : (
                  <IconCopy aria-hidden="true" />
                )}
                Copy code
              </Button>
            </div>
            <p
              className="min-h-5 text-sm text-muted-foreground"
              aria-live="polite"
            >
              {copyStatus}
            </p>
          </div>
          {verificationUrl ? (
            <Button asChild>
              <a
                href={verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open verification page
                <IconArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <Alert role="alert">
              <IconAlertTriangle aria-hidden="true" />
              <AlertTitle>Verification link unavailable</AlertTitle>
              <AlertDescription>
                Cancel this login and start again.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => run("refresh")}
              disabled={disabled}
            >
              <IconRefresh aria-hidden="true" />
              Refresh status
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => run("cancel")}
              disabled={disabled}
            >
              <IconX aria-hidden="true" />
              Cancel login
            </Button>
          </div>
        </div>
      );
    }
    case "ready":
      return (
        <div className="grid gap-6">
          <div className="flex items-start gap-3">
            <IconShieldCheck
              className="mt-0.5 text-primary"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Account connected
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The proxy can authenticate Codex requests.
              </p>
            </div>
          </div>
          <dl className="grid gap-4 rounded-lg border bg-muted/50 p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Email
              </dt>
              <dd className="mt-1 break-all text-sm font-medium">
                {state.email ?? "Email unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Plan
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {planLabel(state.planType)}
              </dd>
            </div>
          </dl>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => run("refresh")}
              disabled={disabled}
            >
              <IconRefresh aria-hidden="true" />
              Refresh account
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => run("logout")}
              disabled={disabled}
            >
              <IconLogout aria-hidden="true" />
              Log out
            </Button>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="grid gap-5">
          <Alert role="alert">
            <IconAlertTriangle aria-hidden="true" />
            <AlertTitle>Authentication required</AlertTitle>
            <AlertDescription>
              Reconnect Codex to restore proxy access.
            </AlertDescription>
          </Alert>
          <Button
            type="button"
            onClick={() => run("login")}
            disabled={disabled}
          >
            Reconnect Codex
          </Button>
        </div>
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function AdminApp() {
  const [state, setState] = useState<AccountState | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [issue, setIssue] = useState<Issue | null>(null);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    try {
      const response = await fetch("/api/state");
      const parsed = parseAdminResponse(await responseJson(response));
      if (!response.ok || !parsed) {
        setIssue("session_unavailable");
        return;
      }
      setState(parsed.state);
      setCsrfToken(parsed.csrfToken);
      setIssue(parsed.error ? "authentication_unavailable" : null);
    } catch {
      setIssue("session_unavailable");
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const run = async (action: Action) => {
    if (busy) return;
    setBusy(action);
    try {
      const request = ACTIONS[action];
      const response = await fetch(request.path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(request.body),
      });
      if (response.status === 401 || response.status === 403) {
        setCsrfToken("");
        await bootstrap();
        return;
      }
      const parsed = parseAdminResponse(await responseJson(response));
      if (!parsed) {
        setIssue("session_unavailable");
        return;
      }
      setState(parsed.state);
      setCsrfToken(parsed.csrfToken);
      setIssue(
        response.status === 503 || parsed.error
          ? "authentication_unavailable"
          : response.ok
            ? null
            : "session_unavailable",
      );
    } catch {
      setIssue("session_unavailable");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-card">
              <IconLock size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Codex Gateway</p>
              <p className="truncate text-xs text-muted-foreground">
                Local admin control
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" role="status">
              {statusLabel(state)}
            </Badge>
          </div>
        </div>
      </header>

      <main
        className="mx-auto grid max-w-[1120px] grid-cols-1 gap-5 px-4 py-6 md:grid-cols-12 md:gap-6 md:px-6 md:py-10"
        aria-busy={busy !== null || bootstrapping}
      >
        <section className="md:col-span-7" aria-labelledby="account-title">
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle
                id="account-title"
                className="text-sm font-medium text-muted-foreground"
              >
                Codex authentication
              </CardTitle>
              <CardDescription>
                Manage the account used by this local proxy.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5" aria-live="polite">
              {issue && state ? <IssueAlert issue={issue} /> : null}
              {state ? (
                <AccountContent
                  state={state}
                  busy={busy}
                  run={(action) => void run(action)}
                />
              ) : issue ? (
                <SessionUnavailable
                  retry={() => void bootstrap()}
                  loading={bootstrapping}
                />
              ) : (
                <LoadingPanel />
              )}
            </CardContent>
          </Card>
        </section>

        <aside
          className="grid content-start gap-6 md:col-span-5"
          aria-labelledby="guidance-title"
        >
          <div>
            <p className="text-sm font-medium text-primary">
              Secure by location
            </p>
            <h1
              id="guidance-title"
              className="mt-2 text-3xl font-semibold tracking-tight"
            >
              A focused path to authorization.
            </h1>
            <p className="mt-3 max-w-[48ch] text-sm leading-6 text-muted-foreground">
              This panel stays on loopback and handles only the Codex account
              lifecycle.
            </p>
          </div>
          <Separator />
          <ol className="grid gap-5 text-sm">
            <li className="grid grid-cols-[1.75rem_1fr] gap-3">
              <span className="font-mono text-primary">01</span>
              <span>Start login here to request a one-time code.</span>
            </li>
            <li className="grid grid-cols-[1.75rem_1fr] gap-3">
              <span className="font-mono text-primary">02</span>
              <span>Enter it only at the verified OpenAI device page.</span>
            </li>
            <li className="grid grid-cols-[1.75rem_1fr] gap-3">
              <span className="font-mono text-primary">03</span>
              <span>Return here and refresh after authorization.</span>
            </li>
          </ol>
        </aside>
      </main>
    </div>
  );
}
