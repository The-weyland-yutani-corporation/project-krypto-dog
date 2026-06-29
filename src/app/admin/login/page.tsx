"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";

export default function AdminLoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push("/admin");
      } else {
        // Surface the server's actual error so 429 (rate-limited) doesn't
        // masquerade as a wrong password during development.
        let message = "Invalid password";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // ignore JSON parse failures
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) message += ` (retry in ${retryAfter}s)`;
        }
        setError(message);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-info/20">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-info/30 bg-info/10 text-2xl">
            🐕
          </div>
          <CardTitle className="mt-4">Project Krypto Console</CardTitle>
          <p className="text-sm text-muted-foreground">
            Authenticate to manage paper trading operations.
          </p>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter admin password"
            required
          />

          {error && (
            <Alert variant="destructive">{error}</Alert>
          )}

          <Button
            type="submit"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        </CardContent>
      </Card>
    </div>
  );
}
