import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, Boxes } from "lucide-react";

import landingImg from "@assets/pexels-apasaric-1238864_1767415604985.jpg";

export default function Login() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { loginMutation, registerMutation, user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user) {
      setLocation("/");
    }
  }, [user, setLocation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRegister) {
      registerMutation.mutate({ username, password } as any);
    } else {
      loginMutation.mutate({ username, password });
    }
  };

  const isPending = loginMutation.isPending || registerMutation.isPending;

  // Seconds the current attempt has been in flight.
  //
  // The button said "Authenticating..." for as long as the request took, which
  // on this deployment is about thirty seconds the first time anyone signs in
  // after a quiet period -- and for most of that it is not authenticating
  // anything. The API is on a free tier that suspends when idle, so the
  // request is still waiting for a host to start. A spinner that names a step
  // the system has not reached is the same defect as a progress bar that
  // invents its stages: it is indistinguishable from the system working, right
  // up until the visitor closes the tab.
  //
  // Ticks rather than a clock read, because Date.now() during render is an
  // impure call and the only use for this number is a threshold.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isPending) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [isPending]);

  // A warm sign-in answers in well under this.
  const likelyColdStart = isPending && elapsed >= 6;

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left: Brand panel */}
      <div className="hidden lg:flex relative flex-col justify-between overflow-hidden bg-slate-950 p-12 text-white">
        {/* Background image, held down by a slate wash so type stays primary */}
        <div
          className="absolute inset-0 z-0 opacity-40"
          style={{
            backgroundImage: `url(${landingImg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
        <div className="absolute inset-0 z-[1] bg-gradient-to-t from-slate-950 via-slate-950/85 to-slate-950/60" />

        <div className="z-10">
          <div className="mb-16 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-inset ring-primary/30">
              <Boxes className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <p className="text-[15px] font-semibold tracking-tight leading-tight">Craft &amp; Smash</p>
              <p className="text-[11px] font-medium tracking-wide text-slate-400 leading-tight">Asset Intelligence</p>
            </div>
          </div>

          <h1 className="max-w-lg text-4xl font-semibold leading-[1.15] tracking-tight text-white">
            Know which machine fails next —
            <span className="text-slate-400"> before it costs you the jobsite.</span>
          </h1>
          <p className="mt-6 max-w-md text-[15px] leading-relaxed text-slate-300">
            Calibrated multi-horizon failure prediction, dispatch risk guarding, and
            maintenance economics for mixed construction fleets — one risk model across
            every make on the yard.
          </p>

          <div className="mt-10 flex gap-8 text-sm">
            <div>
              <p className="font-mono text-xl font-semibold tabular-nums">3</p>
              <p className="mt-0.5 text-slate-400">prediction horizons</p>
            </div>
            <div>
              <p className="font-mono text-xl font-semibold tabular-nums">10 / 30 / 60d</p>
              <p className="mt-0.5 text-slate-400">failure windows</p>
            </div>
            <div>
              <p className="font-mono text-xl font-semibold tabular-nums">31</p>
              <p className="mt-0.5 text-slate-400">engineered features</p>
            </div>
          </div>
        </div>

        <div className="z-10 text-xs text-slate-500">
          © 2026 Craft &amp; Smash Rental Systems
        </div>
      </div>

      {/* Right: Auth form */}
      <div className="flex items-center justify-center bg-background p-8">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <CardTitle className="text-center text-xl">
              {isRegister ? "Create an account" : "Sign in"}
            </CardTitle>
            <CardDescription className="text-center">
              {isRegister
                ? "Enter your details to register"
                : "Enter your credentials to access the dashboard"}
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  placeholder="viewer"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col space-y-4">
              <Button
                type="submit"
                className="w-full font-semibold"
                disabled={isPending}
              >
                {isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {isRegister ? "Registering..." : "Authenticating..."}
                  </>
                ) : (
                  isRegister ? "Register" : "Sign In"
                )}
              </Button>

              {likelyColdStart && (
                <p
                  className="text-xs text-muted-foreground text-center"
                  data-testid="text-cold-start"
                >
                  Still waiting after {elapsed}s. The demo API is on free hosting
                  and suspends when idle — the first sign-in after a quiet period
                  spends about 30 seconds waking it. Nothing is wrong; it has not
                  reached the server yet.
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                className="text-primary text-xs hover:bg-transparent no-default-hover-elevate"
                onClick={() => setIsRegister(!isRegister)}
                disabled={isPending}
              >
                {isRegister
                  ? "Already have an account? Sign in"
                  : "Don't have an account? Register now"}
              </Button>
            </CardFooter>
          </form>
          {!isRegister && (
            <div className="px-8 pb-8 text-center text-xs text-muted-foreground">
              {/*
                Only the read-only account is advertised. The administrator one
                still exists -- the seed creates both -- but it can reseed and
                reset the demo, and a visitor who does that wipes the data for
                everyone else looking at the same deployment.

                This is "not advertised", not "protected": the seed's passwords
                are committed in server/seeds/demo-users.ts and the repository
                is public. Anyone who reads it has the administrator password.
                Keeping it off this card only stops a casual visitor finding a
                destructive button they had no reason to press.
              */}
              <p>Demo Credentials:</p>
              <p><span className="font-mono">viewer / viewer123</span></p>
              <p className="mt-1">Read-only access to the full dataset.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
