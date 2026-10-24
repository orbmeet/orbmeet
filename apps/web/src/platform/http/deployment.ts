import { isLoopbackUrl } from "./loopback";

/** What a deployment says about itself: its `APP_URL` and `ENVIRONMENT`. */
export interface Deployment {
  appUrl?: string;
  environment?: string;
}

export function deploymentOf(env: Pick<Env, "APP_URL" | "ENVIRONMENT"> | undefined): Deployment {
  return { appUrl: env?.APP_URL, environment: env?.ENVIRONMENT };
}

/**
 * Whether this Worker is a developer's own run, where the protections that
 * only work behind Cloudflare stand down: the CSRF origin check, `Secure` and
 * `__Host-` cookies, trusting `X-Forwarded-For` for the client address, the
 * rate limiters a local runtime has no binding for, and plain-HTTP service
 * origins.
 *
 * This is the one place that decides it, and it takes a declaration and a
 * fact together: the deployment says it is for development
 * (`ENVIRONMENT=development`) and its `APP_URL` is on this machine. Either
 * alone is production, so a remote deployment configured as "development" by
 * mistake keeps every protection. The request's own Host is never consulted:
 * anyone can send `Host: localhost`.
 */
export function isLocalDevelopment(deployment: Deployment | undefined): boolean {
  return deployment?.environment === "development" && isLoopbackUrl(deployment.appUrl);
}
