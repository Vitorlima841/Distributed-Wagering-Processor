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
  logger.info({ role: config.role, port: config.port }, 'application started');
}

await bootstrap();
