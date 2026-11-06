import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigError, parseConfig } from './infrastructure/config/app-config';
import { createLogger } from './infrastructure/logging/logger';

async function bootstrap(): Promise<void> {
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const app = await NestFactory.create(AppModule.forRole(config), { logger: false });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  // com PORT=0 o SO escolhe a porta; o log traz a porta real (os testes multi-instância a leem daqui)
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  logger.info({ role: config.role, port, pid: process.pid }, 'application started');
}

await bootstrap();
