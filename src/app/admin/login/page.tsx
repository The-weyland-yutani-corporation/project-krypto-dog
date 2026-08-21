import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export default function AdminLoginPage() {
  const enabled =
    process.env.ADMIN_IDENTITY_MODE === "entra" &&
    process.env.ADMIN_PLATFORM_AUTH === "azure-container-apps";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-info/20">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-info/30 bg-info/10 text-info">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <CardTitle className="mt-4">Project Krypto Console</CardTitle>
          <p className="text-sm text-muted-foreground">
            Named operator access requires Microsoft Entra ID, the assigned
            admin role, and MFA. Sensitive controls also require recent
            step-up authentication.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!enabled && (
            <Alert variant="destructive">
              Admin identity is disabled in this environment. No local password
              fallback is available.
            </Alert>
          )}
          <Button asChild disabled={!enabled}>
            <a
              href={enabled ? "/api/auth/login?returnTo=/admin" : undefined}
              aria-disabled={!enabled}
            >
              Continue with Microsoft Entra ID
            </a>
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Emergency access uses reviewed Entra emergency accounts and is
            independently alerted. Shared-password access is not supported.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
