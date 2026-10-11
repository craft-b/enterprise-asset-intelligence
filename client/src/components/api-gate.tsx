// client/src/components/api-gate.tsx
//
// Holds the app back until the API answers, and explains the wait.
//
// The SPA is on static hosting and the API is in a container that free tiers
// suspend when idle. Rendering the app immediately would mount a dozen queries
// against a server that is still starting, so the first visit after a quiet
// period would look like a broken app rather than a cold start. Gating here
// means those queries only ever run against a server that has answered.
//
// Nothing is shown for a warm API: the notice appears only once the wait is
// long enough to need explaining, so local development and a warm instance go
// straight through with no flash.

import { useEffect, useState } from "react";
import { Loader2, Moon, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { waitForApi, type WakeupState } from "@/lib/api-wakeup";

/** Roughly how long a suspended free instance takes, for the progress hint. */
const TYPICAL_COLD_START_SECONDS = 45;

export function ApiGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WakeupState>({
    phase: "checking",
    elapsedSeconds: 0,
    attempts: 0,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    waitForApi({
      onUpdate: next => {
        if (!cancelled) setState(next);
      },
    }).then(final => {
      if (!cancelled) setState(final);
    });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.phase === "ready") return <>{children}</>;

  // Probing, but not for long enough to be worth a word. Showing nothing here
  // is what keeps a warm load from flickering.
  if (state.phase === "checking") return null;

  if (state.phase === "unreachable") {
    return (
      <Shell
        icon={<AlertTriangle className="h-6 w-6 text-destructive" aria-hidden />}
        title="The API isn't responding"
        body={
          <>
            No answer after {state.elapsedSeconds} seconds across {state.attempts}{" "}
            attempts. The service may be redeploying, or its database may be
            unreachable.
          </>
        }
        action={
          <Button onClick={() => setAttempt(n => n + 1)} variant="outline" size="sm">
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Try again
          </Button>
        }
      />
    );
  }

  const pct = Math.min(
    95,
    Math.round((state.elapsedSeconds / TYPICAL_COLD_START_SECONDS) * 100)
  );

  return (
    <Shell
      icon={<Moon className="h-6 w-6 text-muted-foreground" aria-hidden />}
      title="Waking the API"
      body={
        <>
          This demo runs on free hosting that suspends the API when it's idle, so
          the first request after a quiet period has to start the container.
          It usually takes about {TYPICAL_COLD_START_SECONDS} seconds. Everything
          is immediate afterwards.
        </>
      }
      action={
        <div className="w-full space-y-2" aria-live="polite">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={TYPICAL_COLD_START_SECONDS}
            aria-valuenow={state.elapsedSeconds}
            aria-label="Time spent waiting for the API"
          >
            <div
              className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground tabular-nums">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {state.elapsedSeconds}s elapsed
          </p>
        </div>
      }
    />
  );
}

function Shell({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <div className="flex justify-center">{icon}</div>
        <div className="space-y-2">
          <h1 className="text-base font-semibold text-foreground">{title}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        </div>
        <div className="flex justify-center">{action}</div>
      </div>
    </div>
  );
}
