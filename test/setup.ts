import 'reflect-metadata';

// Defaults para testes locais contra o docker compose (portas publicadas no host).
// Banco próprio dos testes: o ledger é append-only (não dá para limpar), então os testes não
// escrevem no banco `wagering` usado pelo app. O helper de integração cria o banco se faltar.
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5433/wagering_test';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.SQS_ENDPOINT ??= 'http://localhost:4566';
