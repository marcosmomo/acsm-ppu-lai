# B6.2.2 — Auditoria de autenticação e autorização server-side

## Conclusão

O aplicativo não possui autenticação humana reutilizável. Não há login, sessão de aplicação, middleware/proxy, cadastro de usuários/papéis, NextAuth/Auth.js, Better Auth, Clerk, Auth0 ou Descope. As rotas de governança aceitam nomes informativos enviados pelo frontend e não autenticam o operador.

`VERCEL_OIDC_TOKEN` é identidade de workload da plataforma, não uma sessão humana. O token opcional da rota de ingestão de IA é um segredo compartilhado específico daquela integração; não identifica operador, sessão nem papel e não pode ser reutilizado para governança. O header `Authorization` permitido no CORS também não constitui verificação.

Consequentemente, nenhuma autenticação operacional foi declarada ou implementada nesta etapa.

## Pontos de autorização

| Operação | Permissão proposta | Papel mínimo | Estado atual |
|---|---|---|---|
| Aprovar perfil | `governance.profile.approve` | `GOVERNANCE_OPERATOR` | Body `approvedBy`; não autenticado |
| Rejeitar perfil | `governance.profile.reject` | `GOVERNANCE_OPERATOR` | Body `rejectedBy`; não autenticado |
| Atualizar políticas | `governance.policy.update` | `GOVERNANCE_ADMIN` | Body `updatedBy`; não autenticado |
| Aprovar ação | `governance.action.approve` | `GOVERNANCE_OPERATOR` | Body `approvedBy/decidedBy`; não autenticado |
| Rejeitar ação | `governance.action.reject` | `GOVERNANCE_OPERATOR` | Body `rejectedBy/decidedBy`; não autenticado |
| Reconciliar ciclo `FAILED` | `governance.cycle.reconcile` | `GOVERNANCE_ADMIN` | Endpoint ainda inexistente |
| Liberar lock órfão | `governance.lock.release` | `GOVERNANCE_ADMIN` | Somente API isolada do Repository; endpoint inexistente |
| Plug manual | `governance.lifecycle.plug` | `LIFECYCLE_OPERATOR` | Não autenticado |
| Unplug manual | `governance.lifecycle.unplug` | `LIFECYCLE_OPERATOR` | Não autenticado |

Plug/Unplug originados por automação não devem reutilizar uma identidade humana. Precisam de autenticação de serviço separada, autorização do subsistema e evidência lifecycle correlacionada. A permissão humana acima se aplica apenas a uma futura operação manual autenticada.

## Adaptador isolado

`serverGovernanceAuthorization.mjs` recebe `resolveServerIdentity`, que no futuro deverá chamar a API server-side oficial do provedor escolhido. O resolver é o único componente autorizado a afirmar que uma sessão foi verificada.

Entrada autenticada mínima:

- `authenticated: true`;
- `verifiedByServer: true`;
- `source: SERVER_SESSION`;
- `subject` estável;
- `authenticationId` da sessão/autenticação;
- `authenticatedAt` e `expiresAt` válidos;
- papéis obtidos da fonte server-side.

Saída confiável:

- `subject`;
- `authenticationId`;
- `authenticatedAt`;
- `roles`;
- `provenance: SERVER_AUTHENTICATION`;
- `authenticated: true`;
- `authorized: true`;
- `trusted: true`;
- permissão efetivamente autorizada.

O adaptador não lê o body para produzir sujeito ou papéis. A autenticação apenas produz contexto de ator; a decisão `APPROVED` ou `DENIED` continua sendo um comando explícito, separado e correlacionado ao ciclo/perfil.

## Alternativas para uma fonte real

### 1. OIDC institucional — recomendada se já disponível

Usar o IdP institucional com biblioteca madura compatível com Next.js e mapear grupos/claims para os papéis locais no servidor. Oferece identidade institucional, revogação e potencial MFA. Requer registrar aplicação, callbacks, política de claims/grupos e validação com a equipe de identidade. O custo e o risco principais são a coordenação institucional e configuração incorreta de claims.

### 2. Provedor hospedado de aplicação

Clerk, Auth0 ou Descope reduzem o trabalho de login, sessão, expiração e MFA. Exigem tenant, configuração externa, gestão de papéis e dependência de fornecedor. Não devem ser adicionados sem decisão arquitetural e avaliação de dados/custos.

### 3. Better Auth autogerido

Mantém usuários e sessões sob controle do projeto, mas exige banco, migrations, gestão segura de credenciais, recuperação de conta e operação contínua. Como o projeto não possui Store de identidade e esta etapa proíbe mudanças no MySQL, não é o caminho mínimo atual.

### 4. Proteção do deployment/reverse proxy

Pode restringir acesso ao ambiente, mas só serve como identidade da aplicação se o token/header encaminhado for verificável no servidor, não puder ser enviado diretamente pelo cliente e trouxer claims suficientes. Proteção de deployment isoladamente não substitui autorização granular de governança.

## Sequência futura mínima

1. Escolher formalmente IdP e definir identificador humano estável.
2. Definir origem autoritativa dos papéis e política de administração.
3. Implementar o resolver server-side oficial e validar sessão em cada route handler; middleware pode ser defesa adicional, nunca a única validação.
4. Passar o resultado ao adaptador isolado e depois aos contratos transacionais.
5. Registrar `subject`, `authenticationId`, decisão, ciclo, perfil, revisão e timestamp no histórico/auditoria.
6. Aplicar proteção conjuntamente a todas as rotas escritoras; não fazer rollout parcial.
7. Manter reconciliação e liberação de locks em endpoints administrativos separados, com justificativa e auditoria obrigatórias.

## Bloqueios

- provedor de identidade ainda não escolhido;
- nenhuma sessão humana real;
- origem e administração de papéis indefinidas;
- política de MFA/expiração/revogação indefinida;
- endpoints administrativos inexistentes;
- autenticação de serviço para lifecycle ainda indefinida;
- rotas operacionais continuam aceitando campos informativos do frontend.

A B6.3 não está autorizada por esta entrega.
