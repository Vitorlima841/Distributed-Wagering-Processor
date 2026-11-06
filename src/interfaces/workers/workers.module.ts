import { Module } from '@nestjs/common';
import { rolePlaceholder } from './role-placeholder';

@Module({ providers: [rolePlaceholder('outbox')] })
export class OutboxModule {}

@Module({ providers: [rolePlaceholder('pending-ref')] })
export class PendingRefModule {}
