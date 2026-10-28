import { Controller, Get, Param } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('users')
  users() {
    return this.reports.exportUsers();
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.reports.userSummary(+id);
  }
}
