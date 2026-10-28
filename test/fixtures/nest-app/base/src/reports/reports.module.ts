import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [UsersModule],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
