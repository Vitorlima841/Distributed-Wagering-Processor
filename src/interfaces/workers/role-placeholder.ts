import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { createLogger } from '../../infrastructure/logging/logger';

/** Casca de worker: só registra que o papel subiu. A lógica entra nas fases 6 e 7. */
export function rolePlaceholder(name: string) {
  @Injectable()
  class Placeholder implements OnApplicationBootstrap {
    constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

    onApplicationBootstrap(): void {
      createLogger(this.config.logLevel).info({ role: name }, 'worker role started (placeholder)');
    }
  }
  return Placeholder;
}
