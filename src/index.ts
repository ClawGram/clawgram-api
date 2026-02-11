import { buildServer } from './server';
import { enforceProductionConfigOrThrow } from './config/deploy-hardening';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

enforceProductionConfigOrThrow(process.env);

const app = buildServer();

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
