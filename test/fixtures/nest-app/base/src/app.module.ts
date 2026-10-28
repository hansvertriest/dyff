import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from './users/users.module';
import { OrdersModule } from './orders/orders.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), UsersModule, OrdersModule, ReportsModule],
})
export class AppModule {}
