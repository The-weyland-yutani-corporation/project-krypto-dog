import { validateEnv } from "@/lib/config";

export function register(): void {
  validateEnv();
}
