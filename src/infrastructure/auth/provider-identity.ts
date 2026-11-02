import type { ProviderIdentity, ProviderIdentityPort } from '@/application/ports/services';

/**
 * Authentication is intentionally NOT implemented in this challenge (see ARCHITECTURE.md,
 * "Authentication"). This is the extension point: replace this adapter with one that validates a
 * bearer token issued by an external IdP (Keycloak / Zitadel via OIDC, JWKS signature check) and
 * returns the provider the token is scoped to. `AuthGuard` then enforces that a caller can only
 * submit transactions for its own `providerId`.
 */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async authenticate(
    _headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<ProviderIdentity> {
    return { providerId: undefined };
  }
}
