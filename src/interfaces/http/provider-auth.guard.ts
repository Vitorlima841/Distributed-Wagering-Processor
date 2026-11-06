import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (fora do escopo de pontuação, ARCHITECTURE §11). Hoje deixa
 * tudo passar. Desenho previsto:
 *  - cada provedor é um client OIDC (Keycloak/Zitadel) com `client_credentials`;
 *  - o guard valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e extrai o `providerId` de
 *    uma claim;
 *  - `POST /wagering/transactions` exige que o `providerId` do token seja o do corpo, e
 *    `GET /providers/:providerId/...` que seja o do path (senão 403);
 *  - rotas de wallet/reconciliação exigem um papel de backoffice.
 * Health fica fora do guard; mensagens da fila são canal interno confiável, mas o `providerId`
 * delas passa pelas mesmas validações de domínio.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
