import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness: o processo está de pé. Sem autenticação e sem tocar em dependências. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
