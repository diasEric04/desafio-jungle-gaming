// Preloaded by `bun test` (see bunfig.toml). Keep it dependency-free so domain unit
// tests run anywhere; integration helpers import what they need themselves.
process.env.TZ = 'UTC';
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5432/wagering';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
