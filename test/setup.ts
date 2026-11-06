import 'reflect-metadata';

// Defaults para testes locais contra o docker compose (portas publicadas no host).
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5433/wagering';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.SQS_ENDPOINT ??= 'http://localhost:4566';
