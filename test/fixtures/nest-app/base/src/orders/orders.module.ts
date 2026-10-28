import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { OrdersService, ORDERS_REPO } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';

@Module({
  imports: [UsersModule],
  providers: [OrdersService, { provide: ORDERS_REPO, useClass: OrdersRepository }],
  controllers: [OrdersController],
})
export class OrdersModule {}
